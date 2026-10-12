// test/paper/exitFixtures.ts
import type { BandMarket } from '../../src/decide/kalshi.js';
import type { Item } from '../../src/item.js';

/** A threshold ("above strike") market quoted around `midCents` with +/- `halfSpread` cents. */
export function thr(strike: number, midCents: number, halfSpread = 1, over: Partial<BandMarket> = {}): BandMarket {
  return {
    ticker: `T-${strike}`, floorStrike: strike, capStrike: null, strikeType: 'greater', status: 'active',
    yesAskCents: midCents + halfSpread, yesBidCents: midCents - halfSpread,
    yesAskSizeContracts: 100, yesBidSizeContracts: 100, ...over,
  };
}

/** Survival curve 0.90 / 0.70 / 0.50 / 0.30 / 0.10 at strikes 90..98: a shift of -2 at strike 94 reads 0.30. */
export function thresholdBands(halfSpread = 1): BandMarket[] {
  return [thr(90, 90, halfSpread), thr(92, 70, halfSpread), thr(94, 50, halfSpread), thr(96, 30, halfSpread), thr(98, 10, halfSpread)];
}

export function makeItem(over: Partial<Item> = {}): Item {
  return {
    item_id: 'news-1', dedup_id: 'dedup-1', story_key: 'story-1', event_type: 'item', replay: false,
    source_id: 'some_feed', adapter: 'feed', trust_tier: 2,
    headline: 'US lifts sanctions on Russian oil exports', snippet: 'Washington eased sanctions on Russian crude on Sunday.',
    url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null,
    event_time: '2026-10-12T01:00:00Z', source_publish_ts: '2026-10-12T01:00:05Z',
    first_seen_ts: '2026-10-12T01:00:20Z', emitted_ts: '2026-10-12T01:00:21Z', latency_ms: 16000,
    is_first_sighting: true, corroborations: 0, provenance_gaps: [], amends_item_id: null, amendment_kind: null,
    ...over,
  };
}
