// src/perp/intake/newsIntake.ts
import type Database from 'better-sqlite3';
import { parseItemFields, type Item } from '../../item.js';
import type { StreamEntry } from '../../redis/consumer.js';
import { SpendCapError } from '../model/callJson.js';
import { appendJournal } from '../store/db.js';
import type { ImpactAssessment } from '../types.js';

export type IntakeResult =
  | 'assessed' | 'gated_out' | 'skipped_replay' | 'skipped_amended' | 'skipped_old' | 'skipped_bad_time' | 'skipped_seen'
  | 'skipped_no_context' | 'parse_error' | 'error';

export interface IntakeDeps {
  db: Database.Database;
  now: () => number;
  alert: (message: string) => void | Promise<void>;
  engine: { contextText(): string | null; onAssessment(a: ImpactAssessment): Promise<void> };
  gate: (item: Item) => Promise<{ relevant: boolean; reason: string }>;
  extract: (item: Item, contextText: string) => Promise<ImpactAssessment>;
  /** Items whose publish time is older than this are skipped. Default 6 hours. */
  maxAgeMs?: number;
}

const SEEN_LIMIT = 5000;
const OUTAGE_ERROR_THRESHOLD = 5;
const OUTAGE_MESSAGE_MAX = 200;
/** A publish time further than this in the future is clock trouble or garbage, not news: skip it. */
const MAX_FUTURE_SKEW_MS = 10 * 60_000;
const RESULTS: IntakeResult[] = [
  'assessed', 'gated_out', 'skipped_replay', 'skipped_amended', 'skipped_old', 'skipped_bad_time', 'skipped_seen',
  'skipped_no_context', 'parse_error', 'error',
];

/** Epoch ms of an ISO timestamp; NaN for a missing, empty or unparseable value. */
const parseTs = (v: string | null | undefined): number => (typeof v === 'string' && v.trim() !== '' ? Date.parse(v) : NaN);

export class NewsIntake {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private capAlertDay: string | null = null;
  private outageAlertDay: string | null = null;
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

  async handleItem(item: Item): Promise<IntakeResult> {
    const now = this.d.now();
    try {
      if (item.replay) return this.count('skipped_replay');
      if (item.event_type === 'item_amended') return this.count('skipped_amended');
      // Fail closed on time: the publish time (else first-seen time) must parse and must not lie in the future.
      const publishedRaw = parseTs(item.source_publish_ts);
      const published = Number.isFinite(publishedRaw) ? publishedRaw : parseTs(item.first_seen_ts);
      if (!Number.isFinite(published) || published - now > MAX_FUTURE_SKEW_MS) return this.count('skipped_bad_time');
      if (now - published > (this.d.maxAgeMs ?? 6 * 3_600_000)) return this.count('skipped_old');
      if (this.seen.has(item.item_id)) return this.count('skipped_seen');
      const context = this.d.engine.contextText();
      if (context === null) return this.count('skipped_no_context');
      this.markSeen(item.item_id);

      const gate = await this.d.gate(item);
      if (!gate.relevant) {
        this.consecutiveErrors = 0;
        return this.count('gated_out');
      }
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
