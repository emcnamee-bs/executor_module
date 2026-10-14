import { describe, it, expect, vi } from 'vitest';
import type { Item } from '../../src/item.js';
import { NewsIntake } from '../../src/perp/intake/newsIntake.js';
import { SpendCapError } from '../../src/perp/model/callJson.js';
import { listJournal, openPerpDb } from '../../src/perp/store/db.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;

const item = (over: Partial<Item> = {}): Item => ({
  item_id: `i-${Math.random()}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false,
  source_id: 'reuters', adapter: 'rss', trust_tier: 1, headline: 'Fed cuts rates', snippet: null, url: null, raw_url: null,
  enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0,
  provenance_gaps: [], amends_item_id: null, amendment_kind: null, ...over,
});

function mk(over: Record<string, unknown> = {}) {
  const calls = { gate: 0, extract: [] as string[], assessed: [] as ImpactAssessment[] };
  const alerts: string[] = [];
  let ctx: string | null = 'CTX';
  const db = openPerpDb(':memory:');
  const intake = new NewsIntake({
    db, now: () => NOW, alert: (m: string) => alerts.push(m),
    engine: { contextText: () => ctx, onAssessment: async (a: ImpactAssessment) => { calls.assessed.push(a); } },
    gate: async () => { calls.gate += 1; return { relevant: true, reason: 'r' }; },
    extract: async (it: Item, c: string) => {
      calls.extract.push(c);
      return { itemId: it.item_id, receivedAtMs: NOW, publishedAtMs: NOW - 60_000, direction: 'up', bucket: 'minor', horizon: 'days', credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r' };
    },
    ...over,
  } as never);
  return { intake, calls, alerts, db, setCtx: (c: string | null) => { ctx = c; } };
}

describe('NewsIntake', () => {
  it('gates, extracts with the engine context, and hands the assessment to the engine', async () => {
    const { intake, calls } = mk();
    expect(await intake.handleItem(item())).toBe('assessed');
    expect(calls.gate).toBe(1);
    expect(calls.extract).toEqual(['CTX']);
    expect(calls.assessed).toHaveLength(1);
  });

  it('skips replays, amendments and stale items without calling any model', async () => {
    const { intake, calls } = mk();
    expect(await intake.handleItem(item({ replay: true }))).toBe('skipped_replay');
    expect(await intake.handleItem(item({ event_type: 'item_amended' }))).toBe('skipped_amended');
    expect(await intake.handleItem(item({ source_publish_ts: new Date(NOW - 7 * H).toISOString() }))).toBe('skipped_old');
    expect(calls.gate).toBe(0);
  });

  it('a redelivered item id is processed only once', async () => {
    const { intake, calls } = mk();
    const it = item({ item_id: 'same' });
    expect(await intake.handleItem(it)).toBe('assessed');
    expect(await intake.handleItem(it)).toBe('skipped_seen');
    expect(calls.gate).toBe(1);
  });

  it('stops after the gate when the item is not relevant', async () => {
    const { intake, calls } = mk({ gate: async () => ({ relevant: false, reason: 'sports' }) });
    expect(await intake.handleItem(item())).toBe('gated_out');
    expect(calls.extract).toHaveLength(0);
  });

  it('skips when the engine has no context yet (no snapshot)', async () => {
    const m = mk();
    m.setCtx(null);
    expect(await m.intake.handleItem(item())).toBe('skipped_no_context');
    expect(m.calls.gate).toBe(0);
  });

  it('alerts once per UTC day when the model spend cap is hit, and never throws (review focus 6)', async () => {
    const { intake, alerts } = mk({ gate: async () => { throw new SpendCapError('cap reached'); } });
    expect(await intake.handleItem(item())).toBe('error');
    expect(await intake.handleItem(item())).toBe('error');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/spend cap/);
    expect(alerts[0]).toMatch(/exchange-side stop/);
  });

  it('records other model errors in the journal without alerting', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // the intake logs the failed item
    const { intake, alerts, db } = mk({ extract: async () => { throw new Error('503'); } });
    expect(await intake.handleItem(item())).toBe('error');
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    expect(alerts).toHaveLength(0);
    expect(listJournal(db, 'intake_error', 5)).toHaveLength(1);
  });

  it('handleEntry parses a stream entry and reports a malformed one as parse_error', async () => {
    const { intake, calls, db } = mk();
    expect(await intake.handleEntry({ id: '1-0', fields: { json: JSON.stringify(item()) } })).toBe('assessed');
    expect(calls.assessed).toHaveLength(1);
    expect(await intake.handleEntry({ id: '2-0', fields: { json: '{"headline": 1}' } })).toBe('parse_error');
    expect(await intake.handleEntry({ id: '3-0', fields: {} })).toBe('parse_error');
    expect(listJournal(db, 'intake_parse_error', 5)).toHaveLength(2);
  });

  it('counts outcomes', async () => {
    const { intake } = mk();
    await intake.handleItem(item());
    await intake.handleItem(item({ replay: true }));
    expect(intake.counters.assessed).toBe(1);
    expect(intake.counters.skipped_replay).toBe(1);
  });
});
