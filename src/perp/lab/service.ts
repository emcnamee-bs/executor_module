// src/perp/lab/service.ts
//
// All the lab's logic behind injected dependencies (clock, audit, alerts, report writer) so it is testable without Redis or a model.
import type Database from 'better-sqlite3';
import { parseItemFields } from '../../item.js';
import type { StreamEntry } from '../../redis/consumer.js';
import { hygieneSkip } from '../intake/hygiene.js';
import { checkSilence } from '../intake/silence.js';
import type { PrefilterConfig } from '../intake/prefilter.js';
import { modelSpendTodayUsd } from '../model/callJson.js';
import type { AuditOutcome, AuditRow } from './audit.js';
import { evaluate, toItemRow, type Evaluator } from './features.js';
import { firstItemMs, getMeta, hasItem, insertItem, setMeta } from './labDb.js';
import { fillReturns, markAtIngest } from './marks.js';
import { buildReport } from './report.js';
import { CANDIDATE_WINDOW_MS, canSpendNow, chooseCandidate, listCandidates, randomAuditCounts, type AuditKind, type Stratum } from './sampler.js';

export type EntryResult = 'logged' | 'duplicate' | 'skipped' | 'parse_error' | 'error';
const DAY_MS = 86_400_000;
export const DEFAULT_REPORT_PATH_LABEL = 'data/perp/intake-lab-week1.md';

export interface LabServiceDeps {
  labDb: Database.Database;
  botDb: Database.Database | null;
  evaluator: Evaluator;
  cfg: PrefilterConfig;
  now: () => number;
  commit: string;
  capUsd: number;
  days: number;
  rng: () => number;
  audit: (row: AuditRow, stratum: Stratum, kind: AuditKind) => Promise<AuditOutcome>;
  alert: (message: string) => void | Promise<void>;
  writeReport: (markdown: string) => void;
  /** How the report location is named in the completion alert. */
  reportPathLabel?: string;
}

export class LabService {
  readonly counters: Record<string, number> = { logged: 0, duplicate: 0, skipped: 0, parse_error: 0, error: 0 };
  private lastEntryAt: number | null = null;
  private readonly startedAt: number;
  private silence = { alerted: false };
  private auditing = false;

  constructor(private readonly d: LabServiceDeps) {
    this.startedAt = d.now();
  }

  get lastEntryAtMs(): number | null {
    return this.lastEntryAt;
  }

  private count(r: EntryResult): EntryResult {
    this.counters[r] += 1;
    return r;
  }

  async handleEntry(entry: StreamEntry): Promise<EntryResult> {
    try {
      const now = this.d.now();
      this.lastEntryAt = now;
      const parsed = parseItemFields(entry.fields);
      if (!parsed.ok) return this.count('parse_error');
      const item = parsed.item;
      if (hygieneSkip(item, now) !== null) return this.count('skipped');
      // A redelivered entry must not re-run the prefilter: its dedup/cap state has already seen this item.
      if (hasItem(this.d.labDb, item.item_id)) return this.count('duplicate');
      const evaluation = evaluate(this.d.evaluator, item, now);
      let mark: { tsMs: number; mark: number } | null = null;
      if (this.d.botDb !== null) {
        try { mark = markAtIngest(this.d.botDb, now); } catch { mark = null; } // an unreadable bot ledger must not stop feature logging
      }
      return this.count(insertItem(this.d.labDb, toItemRow(item, evaluation, now, this.d.commit, mark)) ? 'logged' : 'duplicate');
    } catch (err) {
      console.error('[perp-lab] entry failed:', err instanceof Error ? err.message : String(err));
      return this.count('error');
    }
  }

  /** True until `days` days after the first logged item. */
  auditActive(): boolean {
    const first = firstItemMs(this.d.labDb);
    return first === null || this.d.now() - first < this.d.days * DAY_MS;
  }

  async auditTick(): Promise<'inactive' | 'paced' | 'idle' | 'busy' | AuditOutcome> {
    if (this.auditing) return 'busy';
    this.auditing = true;
    try {
      const now = this.d.now();
      if (!this.auditActive()) return 'inactive';
      if (!canSpendNow(this.d.capUsd, modelSpendTodayUsd(this.d.labDb, now), now)) return 'paced';
      const pick = chooseCandidate(listCandidates(this.d.labDb, now - CANDIDATE_WINDOW_MS, this.d.cfg.threshold), randomAuditCounts(this.d.labDb), this.d.rng);
      if (pick === null) return 'idle';
      const row = this.d.labDb
        .prepare('SELECT item_id, received_ms, published_ms, source_id, tier, headline, snippet FROM items WHERE item_id = ?')
        .get(pick.candidate.itemId) as AuditRow;
      return await this.d.audit(row, pick.candidate.stratum, pick.kind);
    } catch (err) {
      // A timer must never see a rejection: an unhandled one would crash the process and stop feature logging.
      console.error('[perp-lab] audit tick failed:', err instanceof Error ? err.message : String(err));
      return 'error';
    } finally {
      this.auditing = false;
    }
  }

  fillMarks(): number {
    if (this.d.botDb === null) return 0;
    try { return fillReturns(this.d.labDb, this.d.botDb, this.d.now()); } catch { return 0; }
  }

  recordHeartbeat(): void {
    const now = this.d.now();
    let botOk = 0;
    let marksFresh = 0;
    if (this.d.botDb !== null) {
      try {
        const r = this.d.botDb.prepare('SELECT MAX(ts_ms) AS m FROM marks').get() as { m: number | null };
        botOk = 1;
        marksFresh = r.m !== null && now - r.m < 120_000 ? 1 : 0;
      } catch { botOk = 0; marksFresh = 0; }
    }
    const last = this.d.labDb.prepare('SELECT MAX(received_ms) AS m FROM items').get() as { m: number | null };
    const streamOk = this.lastEntryAt !== null && now - this.lastEntryAt < 30 * 60_000 ? 1 : 0;
    this.d.labDb.prepare('INSERT OR REPLACE INTO heartbeat (ts_ms, last_item_ms, stream_ok, bot_db_ok, marks_fresh) VALUES (?, ?, ?, ?, ?)').run(now, last.m, streamOk, botOk, marksFresh);
  }

  async silenceTick(): Promise<void> {
    const q = checkSilence(this.silence, this.d.now(), this.lastEntryAt, this.startedAt);
    this.silence = q.state;
    if (q.alert) {
      try {
        await this.d.alert(`[PERP-LAB] no IIP items for ${Math.round(q.silentForMs / 60_000)} minutes: the lab is not seeing the news stream`);
      } catch (err) {
        console.error('[perp-lab] alert failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Once the audit window has closed: build and write the report, alert, and remember it was done. */
  async maybeReport(): Promise<boolean> {
    try {
      if (this.auditActive() || getMeta(this.d.labDb, 'report_done') !== null) return false;
      const md = buildReport(this.d.labDb, this.d.botDb, this.d.now());
      this.d.writeReport(md);
      setMeta(this.d.labDb, 'report_done', new Date(this.d.now()).toISOString());
    } catch (err) {
      // report_done stays unset, so the next housekeeping tick retries; no alert for a report that was not written.
      console.error('[perp-lab] report failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
    try {
      await this.d.alert(`[PERP-LAB] the ${this.d.days}-day audit is complete; the report is in ${this.d.reportPathLabel ?? DEFAULT_REPORT_PATH_LABEL}`);
    } catch (err) {
      console.error('[perp-lab] alert failed:', err instanceof Error ? err.message : String(err));
    }
    return true;
  }
}
