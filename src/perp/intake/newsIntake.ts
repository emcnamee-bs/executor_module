// src/perp/intake/newsIntake.ts
import type Database from 'better-sqlite3';
import { parseItemFields, type Item } from '../../item.js';
import type { StreamEntry } from '../../redis/consumer.js';
import { SpendCapError } from '../model/callJson.js';
import { appendJournal } from '../store/db.js';
import type { ImpactAssessment } from '../types.js';

export type IntakeResult =
  | 'assessed' | 'gated_out' | 'skipped_replay' | 'skipped_amended' | 'skipped_old' | 'skipped_seen'
  | 'skipped_no_context' | 'parse_error' | 'error';

export interface IntakeDeps {
  db: Database.Database;
  now: () => number;
  alert: (message: string) => void;
  engine: { contextText(): string | null; onAssessment(a: ImpactAssessment): Promise<void> };
  gate: (item: Item) => Promise<{ relevant: boolean; reason: string }>;
  extract: (item: Item, contextText: string) => Promise<ImpactAssessment>;
  /** Items whose publish time is older than this are skipped. Default 6 hours. */
  maxAgeMs?: number;
}

const SEEN_LIMIT = 5000;
const RESULTS: IntakeResult[] = [
  'assessed', 'gated_out', 'skipped_replay', 'skipped_amended', 'skipped_old', 'skipped_seen', 'skipped_no_context', 'parse_error', 'error',
];

export class NewsIntake {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private capAlertDay: string | null = null;
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

  async handleEntry(entry: StreamEntry): Promise<IntakeResult> {
    const parsed = parseItemFields(entry.fields);
    if (!parsed.ok) {
      appendJournal(this.d.db, { tsMs: this.d.now(), kind: 'intake_parse_error', payload: { id: entry.id, error: parsed.error } });
      return this.count('parse_error');
    }
    return this.handleItem(parsed.item);
  }

  async handleItem(item: Item): Promise<IntakeResult> {
    const now = this.d.now();
    try {
      if (item.replay) return this.count('skipped_replay');
      if (item.event_type === 'item_amended') return this.count('skipped_amended');
      const published = Date.parse(item.source_publish_ts ?? item.first_seen_ts);
      if (Number.isFinite(published) && now - published > (this.d.maxAgeMs ?? 6 * 3_600_000)) return this.count('skipped_old');
      if (this.seen.has(item.item_id)) return this.count('skipped_seen');
      const context = this.d.engine.contextText();
      if (context === null) return this.count('skipped_no_context');
      this.markSeen(item.item_id);

      const gate = await this.d.gate(item);
      if (!gate.relevant) return this.count('gated_out');
      const assessment = await this.d.extract(item, context);
      await this.d.engine.onAssessment(assessment);
      return this.count('assessed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof SpendCapError) {
        const day = new Date(now).toISOString().slice(0, 10);
        if (this.capAlertDay !== day) {
          this.capAlertDay = day;
          this.d.alert(
            `[PERP] model daily spend cap reached; news is ignored until the next UTC day. ` +
              `Any open position stays protected by its exchange-side stop. (${msg})`
          );
        }
      } else {
        appendJournal(this.d.db, { tsMs: now, kind: 'intake_error', payload: { itemId: item.item_id, error: msg } });
        console.error('[perp-intake] item failed:', msg);
      }
      return this.count('error');
    }
  }
}
