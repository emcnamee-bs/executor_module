import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { loadPrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { formatReplay, replayItems } from '../../src/perp/ops/replay.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
let n = 0;
const item = (source_id: string, headline: string, over: Partial<Item> = {}): Item => ({
  item_id: `r${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline,
  snippet: null, url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0, provenance_gaps: [],
  amends_item_id: null, amendment_kind: null, ...over,
});
const cfg = () => loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));

describe('replayItems', () => {
  it('summarises the funnel by reason and by source, keeping dedup state across items', () => {
    const items = [
      item('bluesky_geopolitics', 'Inflation and the Fed'),
      item('axios_all', 'Inflation heats up as gas prices surge'),
      item('thehill_news', 'Inflation heats up as gas prices surge again'),
      item('ukrinform_news', 'Zelensky briefs Burnham on Russian attacks against Ukraine'),
      item('axios_all', 'Replay item', { replay: true }),
    ];
    const s = replayItems(items, cfg(), () => NOW);
    expect(s.total).toBe(5);
    expect(s.hygiene).toBe(1);
    expect(s.evaluated).toBe(4);
    expect(s.passed).toBe(1);
    expect(s.byReason).toMatchObject({ source_class_drop: 1, pass: 1, duplicate: 1, low_score: 1 });
    expect(s.bySource.axios_all).toEqual({ evaluated: 1, passed: 1 });
    expect(s.bySource.bluesky_geopolitics).toEqual({ evaluated: 1, passed: 0 });
  });
  it('formats a readable table', () => {
    const s = replayItems([item('axios_all', 'Inflation heats up as gas prices surge')], cfg(), () => NOW);
    const text = formatReplay(s);
    expect(text).toContain('items 1');
    expect(text).toContain('passed to Haiku 1');
    expect(text).toContain('axios_all');
  });
});
