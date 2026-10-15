import { describe, it, expect } from 'vitest';
import type { ImpactAssessment, Snapshot } from '../../src/perp/types.js';
import { SpendCapError } from '../../src/perp/model/callJson.js';
import { openPerpDb, saveSnapshot } from '../../src/perp/store/db.js';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
import { auditItem, latestContext, rowToItem, type AuditRow } from '../../src/perp/lab/audit.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const snap = (tsMs: number): Snapshot => ({
  tsMs, perp: { bid: 13.75, ask: 13.76, mark: 13.755, marketOpen: true, nextCloseTsMs: tsMs + 26 * 3_600_000, fundingEstimate: 0.0001 },
  returns: { d1: 0.0123, d5: -0.0041 }, realizedWeeklySigma: null, macro: { vix: { value: 16.2, change1d: -0.3, asOf: '2026-10-13' } },
  events: [], kalshiEvents: [], freshness: { perpAgeMs: 1000, macroAgeMs: 3_600_000 },
});
const itemRow = (over: Partial<LabItemRow> = {}): LabItemRow => ({
  item_id: 'i1', received_ms: NOW - 30_000, published_ms: NOW - 90_000, source_id: 'bluesky_geopolitics', tier: 4, headline: 'Fed to cut rates', snippet: 'details', commit_sha: 'c',
  class: 'social', score: 6, hits: '[]', prod_pass: 0, prod_reason: 'source_class_drop', dup_of: null, variants: '{}', mark_at_ms: null, mark: null, ...over,
});
const assessment = (bucket: ImpactAssessment['bucket']): ImpactAssessment => ({
  itemId: 'i1', receivedAtMs: NOW, publishedAtMs: NOW, direction: 'down', bucket, horizon: 'days', credibility: 0.4, novelty: 'new', alreadyPriced: 'unclear', confidence: 0.7, rationale: 'because',
});
function setup(extract: (...a: any[]) => Promise<ImpactAssessment>, snapshotAt: number | null = NOW - 60_000) {
  const labDb = openLabDb(':memory:');
  const botDb = openPerpDb(':memory:');
  if (snapshotAt !== null) saveSnapshot(botDb, snap(snapshotAt));
  insertItem(labDb, itemRow());
  const modelDeps = { client: {} as never, db: labDb, dailyUsdCap: 0.5, now: () => NOW };
  const row = labDb.prepare('select item_id, received_ms, published_ms, source_id, tier, headline, snippet from items').get() as AuditRow;
  return { labDb, botDb, row, deps: { labDb, botDb, modelDeps, now: () => NOW, extract } };
}
const auditRow = (db: ReturnType<typeof openLabDb>) => db.prepare('select * from audits').get() as Record<string, unknown> | undefined;

describe('latestContext', () => {
  it('builds the bot-style context from the newest snapshot, flat and with no news pressure', () => {
    const botDb = openPerpDb(':memory:');
    saveSnapshot(botDb, snap(NOW - 120_000));
    const text = latestContext(botDb, NOW)!;
    expect(text).toContain('perp mark 13.755');
    expect(text).toContain('position: flat');
  });
  it('is null when there is no snapshot or it is older than 10 minutes', () => {
    const botDb = openPerpDb(':memory:');
    expect(latestContext(botDb, NOW)).toBeNull();
    saveSnapshot(botDb, snap(NOW - 11 * 60_000));
    expect(latestContext(botDb, NOW)).toBeNull();
  });
});

describe('rowToItem', () => {
  it('rebuilds a valid Item the bot prompt can use', () => {
    const it = rowToItem({ item_id: 'i1', received_ms: NOW, published_ms: NOW - 1000, source_id: 's', tier: 3, headline: 'h', snippet: null });
    expect(it).toMatchObject({ item_id: 'i1', source_id: 's', trust_tier: 3, headline: 'h', snippet: null, event_type: 'item', replay: false });
    expect(it.source_publish_ts).toBe(new Date(NOW - 1000).toISOString());
  });
});

describe('auditItem', () => {
  it('records the assessment, flags a miss for moderate or higher, and takes the cost from model_calls', async () => {
    const { labDb, botDb, row, deps } = setup(async () => assessment('moderate'));
    labDb.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'impact', 'claude-sonnet-5-5', 'i1', 10, 5, 0.0042, 1)").run(NOW);
    expect(await auditItem(deps, row, 'social', 'random')).toBe('audited');
    expect(auditRow(labDb)).toMatchObject({ item_id: 'i1', stratum: 'social', kind: 'random', bucket: 'moderate', direction: 'down', miss: 1, ok: 1, cost_usd: 0.0042, rationale: 'because' });
    botDb.close();
  });
  it('minor is not a miss', async () => {
    const { labDb, row, deps } = setup(async () => assessment('minor'));
    await auditItem(deps, row, 'low_score', 'boundary');
    expect(auditRow(labDb)).toMatchObject({ bucket: 'minor', miss: 0, kind: 'boundary' });
  });
  it.each(['major', 'shock'] as const)('%s is a miss', async (b) => {
    const { labDb, row, deps } = setup(async () => assessment(b));
    await auditItem(deps, row, 'social', 'random');
    expect(auditRow(labDb)).toMatchObject({ miss: 1 });
  });
  it('skips without a row when there is no fresh market context', async () => {
    const { labDb, row, deps } = setup(async () => assessment('minor'), null);
    expect(await auditItem(deps, row, 'social', 'random')).toBe('no_context');
    expect(auditRow(labDb)).toBeUndefined();
  });
  it('a spend-cap refusal writes nothing and reports cap', async () => {
    const { labDb, row, deps } = setup(async () => { throw new SpendCapError('cap'); });
    expect(await auditItem(deps, row, 'social', 'random')).toBe('cap');
    expect(auditRow(labDb)).toBeUndefined();
  });
  it('any other model error writes an ok=0 row (no retry) and reports error', async () => {
    const { labDb, row, deps } = setup(async () => { throw new Error('503 overloaded'); });
    expect(await auditItem(deps, row, 'social', 'random')).toBe('error');
    expect(auditRow(labDb)).toMatchObject({ ok: 0, miss: null, error: '503 overloaded' });
  });
  it('auditing the same item twice never writes two rows', async () => {
    const { labDb, row, deps } = setup(async () => assessment('minor'));
    await auditItem(deps, row, 'social', 'random');
    await auditItem(deps, row, 'social', 'random');
    expect((labDb.prepare('select count(*) as n from audits').get() as { n: number }).n).toBe(1);
  });
});
