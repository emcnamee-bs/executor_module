// test/perp/labEndToEnd.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { loadPrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { makeEvaluator } from '../../src/perp/lab/features.js';
import { openLabDb } from '../../src/perp/lab/labDb.js';
import { makeRng } from '../../src/perp/lab/sampler.js';
import { LabService } from '../../src/perp/lab/service.js';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
let n = 0;
const item = (source_id: string, headline: string, at: number): Item => ({
  item_id: `e${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline, snippet: null, url: null,
  raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null, source_publish_ts: new Date(at - 60_000).toISOString(),
  first_seen_ts: new Date(at - 50_000).toISOString(), emitted_ts: new Date(at - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0,
  provenance_gaps: [], amends_item_id: null, amendment_kind: null,
});

describe('lab end to end (fake audit, no model)', () => {
  it('logs a day of mixed traffic, audits dropped items within the pace, fills returns, and reports', async () => {
    const clock = { t: T0 };
    const labDb = openLabDb(':memory:'); const botDb = openPerpDb(':memory:');
    for (let h = 0; h <= 30; h++) recordMark(botDb, T0 + h * H, 100 + h * 0.1);
    const cfg = loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));
    const audited: string[] = [];
    const svc = new LabService({
      labDb, botDb, evaluator: makeEvaluator(cfg), cfg, now: () => clock.t, commit: 'abc1234', capUsd: 0.5, days: 7, rng: makeRng(3),
      audit: async (row, stratum, kind) => {
        audited.push(row.item_id);
        labDb.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, ?, ?, 'minor', 'neutral', 'x', 0, 1)").run(row.item_id, clock.t, stratum, kind);
        return 'audited';
      },
      alert: () => undefined, writeReport: () => undefined,
    });
    const feed = [
      ['axios_all', 'Inflation heats up as gas prices surge'], ['bluesky_geopolitics', 'Inflation and the Fed: rates must fall'], ['ukrinform_news', 'Zelensky briefs Burnham on Russian attacks'],
      ['thehill_news', 'Inflation heats up as gas prices surge again'], ['oilprice_main', 'Crude inventories fall'], ['bluesky_geopolitics', 'A rant about everything'],
    ];
    for (let i = 0; i < 60; i++) {
      const [src, head] = feed[i % feed.length];
      clock.t = T0 + i * 5 * 60_000;
      await svc.handleEntry({ id: `${i}-0`, fields: { json: JSON.stringify(item(src, `${head} #${i}`, clock.t)) } });
      await svc.auditTick();
    }
    const total = (labDb.prepare('select count(*) as n from items').get() as { n: number }).n;
    expect(total).toBe(60);
    expect(audited.length).toBeGreaterThan(0);
    expect(new Set(audited).size).toBe(audited.length); // never the same item twice
    clock.t = T0 + 6 * H;
    expect(svc.fillMarks()).toBeGreaterThan(0);
    clock.t = T0 + 8 * 24 * H;
    expect(await svc.maybeReport()).toBe(true);
  });
});
