// test/perp/labFeatures.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { loadPrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { evaluate, makeEvaluator, toItemRow, variantConfigs } from '../../src/perp/lab/features.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const cfg = () => loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));
let n = 0;
const item = (source_id: string, headline: string, snippet: string | null = null, over: Partial<Item> = {}): Item => ({
  item_id: `f${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline, snippet,
  url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0, provenance_gaps: [], amends_item_id: null, amendment_kind: null, ...over,
});

describe('variants', () => {
  it('derives loose1 (press threshold 1) and social_ok (no social class) from production', () => {
    const v = variantConfigs(cfg());
    expect(v.strict3.threshold).toBe(3);
    expect(v.loose1.threshold).toBe(1);
    expect(Object.values(v.social_ok.sources)).not.toContain('social');
    expect(v.social_ok.sources.oilprice_main).toBe('market_wire');
  });
});

describe('evaluate', () => {
  it('a social macro post: production drops it, social_ok and loose1 would have passed it, and its lexicon score is kept', () => {
    const ev = makeEvaluator(cfg());
    const e = evaluate(ev, item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall'), NOW);
    expect(e.verdict).toMatchObject({ pass: false, reason: 'source_class_drop' });
    expect(e.variants).toEqual({ strict3: false, loose1: false, social_ok: true });
    expect(e.lexScore).toBeGreaterThanOrEqual(3);
    expect(e.lexHits).toContain('inflation');
  });
  it('a score-2 press item is dropped in production but passes under loose1', () => {
    const ev = makeEvaluator(cfg());
    const e = evaluate(ev, item('ukrinform_news', 'Zelensky briefs Burnham on Russian attacks against Ukraine'), NOW);
    expect(e.verdict).toMatchObject({ pass: false, reason: 'low_score' });
    expect(e.variants).toEqual({ strict3: false, loose1: true, social_ok: false }); // social_ok only un-drops social; threshold stays 3
    expect(e.lexScore).toBe(2);
  });
  it('each variant keeps its own dedup state, and production commits its passes', () => {
    const ev = makeEvaluator(cfg());
    evaluate(ev, item('axios_all', 'Inflation heats up as gas prices surge'), NOW);
    const dup = evaluate(ev, item('thehill_news', 'Inflation heats up as gas prices surge again'), NOW);
    expect(dup.verdict.reason).toBe('duplicate');
    expect(dup.variants.loose1).toBe(false); // its own state saw the first one too
  });
});

describe('toItemRow', () => {
  it('builds a row with the lexicon score, JSON hits and variants, cut text, and the mark', () => {
    const ev = makeEvaluator(cfg());
    const it = item('axios_all', 'Inflation heats up as gas prices surge ' + 'x'.repeat(400), 's'.repeat(2000));
    const e = evaluate(ev, it, NOW);
    const r = toItemRow(it, e, NOW, 'abc1234', { tsMs: NOW - 1000, mark: 13.55 });
    expect(r).toMatchObject({ item_id: it.item_id, received_ms: NOW, source_id: 'axios_all', tier: 3, commit_sha: 'abc1234', class: 'unknown', prod_pass: 1, prod_reason: 'pass', mark_at_ms: NOW - 1000, mark: 13.55 });
    expect(r.headline).toHaveLength(300);
    expect(r.snippet).toHaveLength(1200);
    expect(JSON.parse(r.hits)).toContain('inflation');
    expect(JSON.parse(r.variants)).toEqual({ strict3: true, loose1: true, social_ok: true });
    expect(r.published_ms).toBe(NOW - 60_000);
  });
  it('null publish time and null mark are stored as null', () => {
    const ev = makeEvaluator(cfg());
    const it = item('axios_all', 'Quiet day', null, { source_publish_ts: 'garbage' });
    const r = toItemRow(it, evaluate(ev, it, NOW), NOW, 'c', null);
    expect(r.published_ms).toBeNull();
    expect(r.mark).toBeNull();
    expect(r.mark_at_ms).toBeNull();
  });
});
