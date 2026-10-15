// test/perp/labEndToEnd.test.ts
import { describe, it, expect, vi } from 'vitest';
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
const AUDIT_COST = 0.05;
const CAP = 0.5;
const mark = (h: number): number => 100 + 0.1 * h;   // the bot's hourly marks are linear in the hour
const item = (id: string, source_id: string, headline: string, at: number): Item => ({
  item_id: id, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline, snippet: null, url: null,
  raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null, source_publish_ts: new Date(at - 60_000).toISOString(),
  first_seen_ts: new Date(at - 50_000).toISOString(), emitted_ts: new Date(at - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0,
  provenance_gaps: [], amends_item_id: null, amendment_kind: null,
});

describe('lab end to end (fake audit, no model)', () => {
  it('logs five hours of mixed traffic, audits dropped items within the pace and the cap, fills returns, and reports once', async () => {
    const clock = { t: T0 };
    const labDb = openLabDb(':memory:'); const botDb = openPerpDb(':memory:');
    for (let h = 0; h <= 30; h++) recordMark(botDb, T0 + h * H, mark(h));
    const cfg = loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));
    const audited: string[] = [];
    const writeReport = vi.fn();
    const alert = vi.fn();
    const svc = new LabService({
      labDb, botDb, evaluator: makeEvaluator(cfg), cfg, now: () => clock.t, commit: 'abc1234', capUsd: CAP, days: 7, rng: makeRng(3),
      audit: async (row, stratum, kind) => {
        audited.push(row.item_id);
        labDb.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, ?, ?, 'minor', 'neutral', 'x', 0, 1)").run(row.item_id, clock.t, stratum, kind);
        // The real audit records its spend in the lab's model_calls (which the pacing reads); a fixed cost exercises the pacing and the cap.
        labDb.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'audit', 'fake', ?, 1, 1, ?, 1)").run(clock.t, row.item_id, AUDIT_COST);
        return 'audited';
      },
      alert, writeReport,
    });
    const feed = [
      ['axios_all', 'Inflation heats up as gas prices surge'], ['bluesky_geopolitics', 'Inflation and the Fed: rates must fall'], ['ukrinform_news', 'Zelensky briefs Burnham on Russian attacks'],
      ['thehill_news', 'Inflation heats up as gas prices surge again'], ['oilprice_main', 'Crude inventories fall'], ['bluesky_geopolitics', 'A rant about everything'],
    ];
    for (let i = 0; i < 60; i++) {
      const [src, head] = feed[i % feed.length];
      clock.t = T0 + i * 5 * 60_000;
      await svc.handleEntry({ id: `${i}-0`, fields: { json: JSON.stringify(item(`e${i}`, src, `${head} #${i}`, clock.t)) } });
      await svc.auditTick();
    }
    const total = (labDb.prepare('select count(*) as n from items').get() as { n: number }).n;
    expect(total).toBe(60);
    // (b) the feed really exercises both branches of the prefilter
    const split = labDb.prepare('select coalesce(sum(prod_pass), 0) as passed, coalesce(sum(1 - prod_pass), 0) as dropped from items').get() as { passed: number; dropped: number };
    expect(split.passed).toBeGreaterThanOrEqual(1);
    expect(split.dropped).toBeGreaterThanOrEqual(1);
    // (a) audits: only dropped items, never twice, and the spend respects the pace (UTC hour 16 at the last tick: min(0.5, 0.5/24 x 18) = 0.375, plus one call of slack) and the cap
    expect(audited.length).toBeGreaterThan(0);
    expect(new Set(audited).size).toBe(audited.length);
    const spent = (labDb.prepare('select coalesce(sum(cost_usd), 0) as s from model_calls').get() as { s: number }).s;
    expect(spent).toBeCloseTo(audited.length * AUDIT_COST, 9);
    expect(spent).toBeLessThanOrEqual(CAP);
    expect(spent).toBeLessThanOrEqual((CAP / 24) * 18 + AUDIT_COST + 1e-9);
    const passedAudited = (labDb.prepare('select count(*) as n from audits a join items i on i.item_id = a.item_id where i.prod_pass <> 0').get() as { n: number }).n;
    expect(passedAudited).toBe(0);

    // (d) returns: the items at a whole hour h carry mark(h); at 6 h in, e0, e12 and e24 have both horizons, e36 and e48 only the 1 h return
    clock.t = T0 + 6 * H;
    expect(svc.fillMarks()).toBe(5);
    const ret = (id: string) => labDb.prepare('select mark, ret_1h, ret_4h from items where item_id = ?').get(id) as { mark: number | null; ret_1h: number | null; ret_4h: number | null };
    const e0 = ret('e0');
    expect(e0.mark).toBeCloseTo(100, 9);
    expect(e0.ret_1h).toBeCloseTo(mark(1) / mark(0) - 1, 9);
    expect(e0.ret_4h).toBeCloseTo(mark(4) / mark(0) - 1, 9);
    const e12 = ret('e12');    // received at T0 + 1 h
    expect(e12.ret_1h).toBeCloseTo(mark(2) / mark(1) - 1, 9);
    expect(e12.ret_4h).toBeCloseTo(mark(5) / mark(1) - 1, 9);
    expect(ret('e36').ret_1h).not.toBeNull();
    expect(ret('e36').ret_4h).toBeNull();
    expect(svc.fillMarks()).toBe(0);

    // (c) after the window: one report, one alert, no more model spend, features still logged
    clock.t = T0 + 8 * 24 * H;
    expect(await svc.maybeReport()).toBe(true);
    expect(writeReport).toHaveBeenCalledTimes(1);
    expect(writeReport.mock.calls[0][0]).toContain('# Intake lab report');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toContain('[PERP-LAB]');
    expect(await svc.maybeReport()).toBe(false);
    expect(writeReport).toHaveBeenCalledTimes(1);
    expect(await svc.auditTick()).toBe('inactive');
    expect(await svc.handleEntry({ id: 'late-0', fields: { json: JSON.stringify(item('e-late', 'axios_all', 'Inflation heats up as gas prices surge #late', clock.t)) } })).toBe('logged');
    expect((labDb.prepare('select count(*) as n from items').get() as { n: number }).n).toBe(61);
  });
});
