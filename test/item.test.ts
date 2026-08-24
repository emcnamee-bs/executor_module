import { describe, it, expect } from 'vitest';
import { parseItemFields, ItemSchema } from '../src/item.js';

function fullItemPayload(overrides: Record<string, unknown> = {}) {
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
    snippet: 'A snippet',
    url: 'https://example.com/article',
    raw_url: 'https://example.com/article',
    enrich_url: null,
    author: 'Jane Reporter',
    lang: 'en',
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: '2026-08-24T10:00:00Z',
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

describe('ItemSchema', () => {
  it('accepts a fully-populated real item', () => {
    const result = ItemSchema.safeParse(fullItemPayload());
    expect(result.success).toBe(true);
  });

  it('accepts an item with a synthetic headline gap', () => {
    const result = ItemSchema.safeParse(
      fullItemPayload({ provenance_gaps: ['synthetic_headline'] })
    );
    expect(result.success).toBe(true);
  });

  it('accepts a replayed item', () => {
    const result = ItemSchema.safeParse(fullItemPayload({ replay: true }));
    expect(result.success).toBe(true);
  });

  it('accepts an amended item', () => {
    const result = ItemSchema.safeParse(
      fullItemPayload({
        event_type: 'item_amended',
        amends_item_id: '1755999999998-000000000000',
        amendment_kind: 'headline_changed',
      })
    );
    expect(result.success).toBe(true);
  });

  it('accepts an item with body absent', () => {
    const result = ItemSchema.safeParse(
      fullItemPayload({ body_state: 'absent', body: null })
    );
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const payload = fullItemPayload() as Record<string, unknown>;
    delete payload.item_id;
    const result = ItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe('parseItemFields', () => {
  it('parses a valid stream entry', () => {
    const fields = { json: JSON.stringify(fullItemPayload()) };
    const result = parseItemFields(fields);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.item_id).toBe('1755999999999-a1b2c3d4e5f6');
    }
  });

  it('fails cleanly when the json field is missing', () => {
    const result = parseItemFields({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing');
    }
  });

  it('fails cleanly on malformed JSON', () => {
    const result = parseItemFields({ json: '{not valid json' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
    }
  });

  it('fails cleanly on schema validation failure', () => {
    const payload = fullItemPayload() as Record<string, unknown>;
    delete payload.headline;
    const result = parseItemFields({ json: JSON.stringify(payload) });
    expect(result.ok).toBe(false);
  });
});
