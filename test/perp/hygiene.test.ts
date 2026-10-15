// test/perp/hygiene.test.ts
import { describe, it, expect } from 'vitest';
import type { Item } from '../../src/item.js';
import { DEFAULT_MAX_AGE_MS, hygieneSkip } from '../../src/perp/intake/hygiene.js';
import { currentCommit } from '../../src/perp/ops/commit.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;
const item = (over: Partial<Item> = {}): Item => ({
  item_id: 'i', dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id: 'axios_all', adapter: 'rss', trust_tier: 3,
  headline: 'h', snippet: null, url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null,
  event_time: null, source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0, provenance_gaps: [],
  amends_item_id: null, amendment_kind: null, ...over,
});

describe('hygieneSkip', () => {
  it('passes a fresh ordinary item', () => {
    expect(hygieneSkip(item(), NOW)).toBeNull();
  });
  it('flags replays, amendments, stale and bad times, in that order', () => {
    expect(hygieneSkip(item({ replay: true, event_type: 'item_amended' }), NOW)).toBe('skipped_replay');
    expect(hygieneSkip(item({ event_type: 'item_amended' }), NOW)).toBe('skipped_amended');
    expect(hygieneSkip(item({ source_publish_ts: new Date(NOW - 7 * H).toISOString() }), NOW)).toBe('skipped_old');
    expect(hygieneSkip(item({ source_publish_ts: new Date(NOW + 11 * 60_000).toISOString() }), NOW)).toBe('skipped_bad_time');
    expect(hygieneSkip(item({ source_publish_ts: 'garbage', first_seen_ts: 'also garbage' }), NOW)).toBe('skipped_bad_time');
  });
  it('falls back to first_seen_ts when the publish time is missing, and honours maxAgeMs', () => {
    expect(hygieneSkip(item({ source_publish_ts: null }), NOW)).toBeNull();
    expect(hygieneSkip(item({ source_publish_ts: new Date(NOW - 2 * H).toISOString() }), NOW, H)).toBe('skipped_old');
    expect(DEFAULT_MAX_AGE_MS).toBe(6 * H);
  });
});

describe('currentCommit', () => {
  it('returns a short sha inside a repo and "unknown" outside one', () => {
    expect(currentCommit(process.cwd())).toMatch(/^[0-9a-f]{7,40}$/);
    expect(currentCommit('/')).toBe('unknown');
  });
});
