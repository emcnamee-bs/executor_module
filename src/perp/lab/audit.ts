// src/perp/lab/audit.ts
//
// One audit: ask Sonnet (the bot's own impact prompt, so labels are comparable) how much a DROPPED item should have mattered.
// Spend, cap and the model_calls row are handled by callJson on the lab's own database.
import type Database from 'better-sqlite3';
import { ItemSchema, type Item } from '../../item.js';
import { SpendCapError } from '../model/callJson.js';
import { summarizeContext } from '../model/context.js';
import type { ModelDeps } from '../model/gate.js';
import { extractImpact } from '../model/impact.js';
import type { Snapshot } from '../types.js';
import type { AuditKind, Stratum } from './sampler.js';

export const CONTEXT_MAX_AGE_MS = 10 * 60_000;
export const MISS_BUCKETS: ReadonlySet<string> = new Set(['moderate', 'major', 'shock']);
export type AuditOutcome = 'audited' | 'no_context' | 'cap' | 'error';

export interface AuditRow {
  item_id: string; received_ms: number; published_ms: number | null; source_id: string; tier: number; headline: string; snippet: string | null;
}
export interface AuditDeps {
  labDb: Database.Database;
  botDb: Database.Database;
  modelDeps: ModelDeps;
  now: () => number;
  extract?: typeof extractImpact;
}

/** The bot's market context from its newest snapshot (read-only), as if flat with no news pressure; null when none is fresh. */
export function latestContext(botDb: Database.Database, nowMs: number, maxAgeMs: number = CONTEXT_MAX_AGE_MS): string | null {
  const row = botDb.prepare('SELECT ts_ms, json FROM snapshots ORDER BY ts_ms DESC LIMIT 1').get() as { ts_ms: number; json: string } | undefined;
  if (row === undefined || nowMs - row.ts_ms > maxAgeMs) return null;
  return summarizeContext({ snapshot: JSON.parse(row.json) as Snapshot, position: null, pressureNow: 0, topItems: [] });
}

export function rowToItem(row: Pick<AuditRow, 'item_id' | 'received_ms' | 'published_ms' | 'source_id' | 'tier' | 'headline' | 'snippet'>): Item {
  const received = new Date(row.received_ms).toISOString();
  return ItemSchema.parse({
    item_id: row.item_id, dedup_id: row.item_id, source_id: row.source_id, adapter: 'lab', trust_tier: row.tier, headline: row.headline,
    snippet: row.snippet, source_publish_ts: row.published_ms === null ? null : new Date(row.published_ms).toISOString(),
    first_seen_ts: received, emitted_ts: received,
  });
}

export async function auditItem(deps: AuditDeps, row: AuditRow, stratum: Stratum, kind: AuditKind): Promise<AuditOutcome> {
  const now = deps.now();
  const context = latestContext(deps.botDb, now);
  if (context === null) return 'no_context';
  const extract = deps.extract ?? extractImpact;
  try {
    const a = await extract(deps.modelDeps, rowToItem(row), context, now);
    const cost = deps.labDb
      .prepare("SELECT cost_usd FROM model_calls WHERE item_id = ? AND stage = 'impact' ORDER BY id DESC LIMIT 1")
      .get(row.item_id) as { cost_usd: number } | undefined;
    deps.labDb
      .prepare(
        `INSERT OR IGNORE INTO audits (item_id, at_ms, stratum, kind, bucket, direction, credibility, novelty, already_priced, confidence, rationale, miss, cost_usd, model, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
      )
      .run(row.item_id, now, stratum, kind, a.bucket, a.direction, a.credibility, a.novelty, a.alreadyPriced, a.confidence, a.rationale,
        MISS_BUCKETS.has(a.bucket) ? 1 : 0, cost?.cost_usd ?? null, deps.modelDeps.impactModel ?? 'claude-sonnet-5-5');
    return 'audited';
  } catch (err) {
    if (err instanceof SpendCapError) return 'cap';
    deps.labDb
      .prepare(
        `INSERT OR IGNORE INTO audits (item_id, at_ms, stratum, kind, miss, ok, error) VALUES (?, ?, ?, ?, NULL, 0, ?)`
      )
      .run(row.item_id, now, stratum, kind, (err instanceof Error ? err.message : String(err)).slice(0, 300));
    return 'error';
  }
}
