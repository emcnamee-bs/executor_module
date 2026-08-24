import { describe, it, expect } from 'vitest';
import { formatSummaryLine } from '../src/log.js';
import type { Item } from '../src/item.js';

function baseItem(overrides: Partial<Item> = {}): Item {
  return {
    item_id: '1755999999999-a1b2c3d4e5f6',
    dedup_id: 'dedup-1',
    story_key: null,
    event_type: 'item',
    replay: false,
    source_id: 'bbc_world',
    adapter: 'feed',
    trust_tier: 1,
    headline: 'A real headline',
    snippet: null,
    url: null,
    raw_url: null,
    enrich_url: null,
    author: null,
    lang: null,
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: null,
    first_seen_ts: '2026-08-24T10:01:00Z',
    emitted_ts: '2026-08-24T10:01:05Z',
    latency_ms: 5000,
    is_first_sighting: true,
    corroborations: 0,
    provenance_gaps: [],
    amends_item_id: null,
    amendment_kind: null,
    ...overrides,
  };
}

describe('formatSummaryLine', () => {
  it('includes item id, source, trust tier, event type, and headline', () => {
    const line = formatSummaryLine(baseItem());
    expect(line).toContain('1755999999999-a1b2c3d4e5f6');
    expect(line).toContain('bbc_world');
    expect(line).toContain('trust=1');
    expect(line).toContain('event=item');
    expect(line).toContain('A real headline');
  });

  it('marks a synthetic headline', () => {
    const line = formatSummaryLine(
      baseItem({ provenance_gaps: ['synthetic_headline'] })
    );
    expect(line).toContain('[synthetic]');
  });

  it('tags a replayed item', () => {
    const line = formatSummaryLine(baseItem({ replay: true }));
    expect(line).toContain('REPLAY');
  });

  it('does not tag a non-replayed item', () => {
    const line = formatSummaryLine(baseItem({ replay: false }));
    expect(line).not.toContain('REPLAY');
  });
});
