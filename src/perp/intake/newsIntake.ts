// src/perp/intake/newsIntake.ts
import type Database from 'better-sqlite3';
import { parseItemFields, type Item } from '../../item.js';
import type { StreamEntry } from '../../redis/consumer.js';
import { SpendCapError } from '../model/callJson.js';
import type { GateImpact } from '../model/gate.js';
import { appendJournal } from '../store/db.js';
import type { ImpactAssessment } from '../types.js';
import { escalate } from './escalate.js'; // NEW
import { DEFAULT_MAX_AGE_MS, hygieneSkip } from './hygiene.js'; // NEW
import { countLastHour, prefilter, recordPass, type PrefilterConfig, type PrefilterState, type SourceClass } from './prefilter.js'; // NEW

export type IntakeResult =
  | 'assessed' | 'gated_out' | 'not_escalated' | 'prefiltered' | 'prefilter_error' | 'skipped_replay' | 'skipped_amended' | 'skipped_old'
  | 'skipped_bad_time' | 'skipped_seen' | 'skipped_no_context' | 'parse_error' | 'error';

export interface IntakeDeps {
  db: Database.Database;
  now: () => number;
  alert: (message: string) => void | Promise<void>;
  engine: { contextText(): string | null; onAssessment(a: ImpactAssessment): Promise<void> };
  gate: (item: Item) => Promise<{ relevant: boolean; reason: string; impact?: GateImpact }>;
  extract: (item: Item, contextText: string) => Promise<ImpactAssessment>;
  /** Items whose publish time is older than this are skipped. Default 6 hours. */
  maxAgeMs?: number;
  /** NEW: the code gate in front of Haiku. Absent or `enabled: false` = the old behaviour (every hygiene-passing item reaches the gate). */
  prefilter?: { enabled: boolean; cfg: PrefilterConfig; state: PrefilterState };
  /** NEW: is a high-impact scheduled event within +-2 h of `nowMs`? Used by the escalation policy. */
  calendarWindowOpen?: (nowMs: number) => boolean;
  /** NEW: git sha recorded on journal rows. */
  commit?: string;
}

const SEEN_LIMIT = 5000;
const OUTAGE_ERROR_THRESHOLD = 5;
const OUTAGE_MESSAGE_MAX = 200;
const PREFILTER_ERROR_ALERT_THRESHOLD = 5; // NEW
const RESULTS: IntakeResult[] = [
  'assessed', 'gated_out', 'not_escalated', 'prefiltered', 'prefilter_error', 'skipped_replay', 'skipped_amended', 'skipped_old',
  'skipped_bad_time', 'skipped_seen', 'skipped_no_context', 'parse_error', 'error',
];

export class NewsIntake {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private capAlertDay: string | null = null;
  private outageAlertDay: string | null = null;
  private prefilterAlertDay: string | null = null; // NEW
  private prefilterErrorDay: string | null = null; // NEW
  private prefilterErrorsToday = 0; // NEW
  private consecutiveErrors = 0;
  private lastEntryAt: number | null = null;
  readonly counters = Object.fromEntries(RESULTS.map((r) => [r, 0])) as Record<IntakeResult, number>;

  constructor(private readonly d: IntakeDeps) {}

  private count(r: IntakeResult): IntakeResult {
    this.counters[r] += 1;
    return r;
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) this.seen.delete(this.seenOrder.shift() as string);
  }

  /** Runs a side effect (journal write or alert); never throws or rejects. Returns whether it succeeded. */
  private async safe(what: string, fn: () => void | Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`[perp-intake] ${what} failed:`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  private journal(tsMs: number, kind: string, payload: unknown): Promise<boolean> {
    return this.safe(`journal ${kind}`, () => appendJournal(this.d.db, { tsMs, kind, payload }));
  }

  /** When the last stream entry of any kind (even an unparseable one) arrived; null before the first. */
  get lastEntryAtMs(): number | null {
    return this.lastEntryAt;
  }

  async handleEntry(entry: StreamEntry): Promise<IntakeResult> {
    try {
      this.lastEntryAt = this.d.now(); // the stream is alive, whatever this entry turns out to be
      const parsed = parseItemFields(entry.fields);
      if (!parsed.ok) {
        await this.journal(this.d.now(), 'intake_parse_error', { id: entry.id, error: parsed.error });
        return this.count('parse_error');
      }
      return await this.handleItem(parsed.item);
    } catch (err) {
      console.error('[perp-intake] entry failed:', err instanceof Error ? err.message : String(err));
      return this.count('error');
    }
  }

  /** NEW: fail closed. The item is dropped, the failure journaled and counted; five in one UTC day raise one alert. */
  private async prefilterFailed(item: Item, err: unknown, now: number): Promise<IntakeResult> {
    const msg = err instanceof Error ? err.message : String(err);
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.prefilterErrorDay !== day) {
      this.prefilterErrorDay = day;
      this.prefilterErrorsToday = 0;
    }
    this.prefilterErrorsToday += 1;
    await this.journal(now, 'prefilter_error', { itemId: item.item_id, error: msg.slice(0, 300) });
    console.error('[perp-intake] prefilter failed (item dropped):', msg);
    if (this.prefilterErrorsToday >= PREFILTER_ERROR_ALERT_THRESHOLD && this.prefilterAlertDay !== day) {
      const sent = await this.safe('prefilter alert', () =>
        this.d.alert(`[PERP] the news prefilter failed ${this.prefilterErrorsToday} times today (items dropped, fail-closed; latest: ${msg.slice(0, OUTAGE_MESSAGE_MAX)}); set PERP_PREFILTER=off to bypass it`)
      );
      if (sent) this.prefilterAlertDay = day;
    }
    return this.count('prefilter_error');
  }

  async handleItem(item: Item): Promise<IntakeResult> {
    const now = this.d.now();
    try {
      // NEW (extracted, same checks and order; the maxAgeMs dep override is passed through)
      const skip = hygieneSkip(item, now, this.d.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
      if (skip !== null) return this.count(skip);
      if (this.seen.has(item.item_id)) return this.count('skipped_seen');
      const context = this.d.engine.contextText();
      if (context === null) return this.count('skipped_no_context');
      this.markSeen(item.item_id);

      // NEW: the code gate. Cheap, deterministic, and it decides what Haiku ever reads.
      const pf = this.d.prefilter?.enabled ? this.d.prefilter : null;
      let sourceClass: SourceClass = 'unknown';
      if (pf !== null) {
        let verdict: ReturnType<typeof prefilter>;
        try {
          verdict = prefilter(item, pf.cfg, pf.state, now);
        } catch (err) {
          return await this.prefilterFailed(item, err, now);
        }
        sourceClass = verdict.sourceClass;
        await this.journal(now, 'intake_item', {
          itemId: item.item_id, sourceId: item.source_id, tier: item.trust_tier, pass: verdict.pass, reason: verdict.reason,
          sourceClass: verdict.sourceClass, score: verdict.score, hits: verdict.hits, strongHits: verdict.strongHits,
          ...(verdict.dupOf === undefined ? {} : { dupOf: verdict.dupOf }), commit: this.d.commit ?? 'unknown',
        });
        if (!verdict.pass) return this.count('prefiltered');
        recordPass(pf.state, item, verdict, now, pf.cfg);
      }

      const gate = await this.d.gate(item);
      const impact: GateImpact = gate.impact ?? (gate.relevant ? 'moderate' : 'none'); // NEW
      let escalated = gate.relevant;
      if (pf !== null) {
        const e = escalate({
          impact, sourceClass, calendarWindowOpen: this.d.calendarWindowOpen?.(now) ?? false,
          sonnetPassesLastHour: countLastHour(pf.state.sonnetAtMs, now), sonnetPerHour: pf.cfg.sonnetPerHour,
        });
        escalated = e.escalate;
        await this.journal(now, 'intake_outcome', {
          itemId: item.item_id, impact, escalated: e.escalate, reason: e.reason, haikuReason: gate.reason.slice(0, 300),
        });
      }
      if (!escalated) {
        this.consecutiveErrors = 0;
        return this.count(impact === 'none' || !gate.relevant ? 'gated_out' : 'not_escalated');
      }
      if (pf !== null) pf.state.sonnetAtMs.push(now);
      const assessment = await this.d.extract(item, context);
      await this.d.engine.onAssessment(assessment);
      this.consecutiveErrors = 0;
      return this.count('assessed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const day = new Date(now).toISOString().slice(0, 10);
      if (err instanceof SpendCapError) {
        if (this.capAlertDay !== day) {
          const sent = await this.safe('spend-cap alert', () =>
            this.d.alert(
              `[PERP] model daily spend cap reached; news is ignored until the next UTC day. ` +
                `Any open position stays protected by its exchange-side stop. (${msg})`
            )
          );
          if (sent) this.capAlertDay = day;
        }
      } else {
        await this.journal(now, 'intake_error', { itemId: item.item_id, error: msg });
        console.error('[perp-intake] item failed:', msg);
        this.consecutiveErrors += 1;
        if (this.consecutiveErrors >= OUTAGE_ERROR_THRESHOLD && this.outageAlertDay !== day) {
          const sent = await this.safe('outage alert', () =>
            this.d.alert(
              `[PERP] news intake: ${OUTAGE_ERROR_THRESHOLD} consecutive model/engine errors ` +
                `(latest: ${msg.slice(0, OUTAGE_MESSAGE_MAX)}); news-driven action is impaired; ` +
                `any open position stays protected by its exchange-side stop`
            )
          );
          if (sent) this.outageAlertDay = day;
        }
      }
      return this.count('error');
    }
  }
}
