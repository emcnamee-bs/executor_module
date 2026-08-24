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

  // I1: upstream gives most fields a pydantic default precisely so payloads written
  // before a field existed keep validating. An older archived item does not carry the
  // key at all — it is ABSENT, not null — so these must default rather than reject.
  it('accepts an older payload that omits every optional field entirely', () => {
    const oldPayload = {
      item_id: '1700000000000-aaaaaaaaaaaa',
      dedup_id: 'dedup-old',
      source_id: 'bbc_world',
      adapter: 'feed',
      trust_tier: 2,
      headline: 'An old headline from before the schema grew',
      first_seen_ts: '2023-11-14T22:13:20Z',
      emitted_ts: '2023-11-14T22:13:21Z',
    };

    const result = ItemSchema.safeParse(oldPayload);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Every defaulted value, checked against the exact pydantic default in schema.py.
    expect(result.data.story_key).toBe(null);
    expect(result.data.event_type).toBe('item');
    expect(result.data.replay).toBe(false);
    expect(result.data.snippet).toBe(null);
    expect(result.data.url).toBe(null);
    expect(result.data.raw_url).toBe(null);
    expect(result.data.enrich_url).toBe(null);
    expect(result.data.author).toBe(null);
    expect(result.data.lang).toBe(null);
    expect(result.data.body_state).toBe('absent');
    expect(result.data.body).toBe(null);
    expect(result.data.event_time).toBe(null);
    expect(result.data.source_publish_ts).toBe(null);
    expect(result.data.latency_ms).toBe(null);
    expect(result.data.is_first_sighting).toBe(false);
    expect(result.data.corroborations).toBe(0);
    expect(result.data.provenance_gaps).toEqual([]);
    expect(result.data.amends_item_id).toBe(null);
    expect(result.data.amendment_kind).toBe(null);

    // The required eight survived intact.
    expect(result.data.item_id).toBe('1700000000000-aaaaaaaaaaaa');
    expect(result.data.trust_tier).toBe(2);
  });

  it('accepts a partially-evolved payload (some optional keys present, some absent)', () => {
    const partial = {
      item_id: '1700000000001-bbbbbbbbbbbb',
      dedup_id: 'dedup-partial',
      source_id: 'reuters',
      adapter: 'feed',
      trust_tier: 1,
      headline: 'Mid-evolution payload',
      first_seen_ts: '2024-01-01T00:00:00Z',
      emitted_ts: '2024-01-01T00:00:01Z',
      // present from an earlier phase...
      url: 'https://example.com/a',
      snippet: 'a snippet',
      body_state: 'present',
      body: 'the body',
      // ...but story_key, provenance_gaps, enrich_url, amends_* not yet invented.
    };

    const result = ItemSchema.safeParse(partial);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.url).toBe('https://example.com/a');
    expect(result.data.body_state).toBe('present');
    expect(result.data.story_key).toBe(null);
    expect(result.data.enrich_url).toBe(null);
    expect(result.data.provenance_gaps).toEqual([]);
  });

  it.each([
    'item_id',
    'dedup_id',
    'source_id',
    'adapter',
    'trust_tier',
    'headline',
    'first_seen_ts',
    'emitted_ts',
  ])('still rejects a payload missing the genuinely-required field %s', (field) => {
    const payload = fullItemPayload() as Record<string, unknown>;
    delete payload[field];
    expect(ItemSchema.safeParse(payload).success).toBe(false);
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

  // I5: the parse-error path is the one you read when the upstream schema drifts, so
  // its error string must stay on one line. ZodError.message is a multi-line JSON dump.
  it('reports a schema failure as a single line naming the offending fields', () => {
    const payload = fullItemPayload() as Record<string, unknown>;
    delete payload.headline;
    delete payload.dedup_id;
    const result = parseItemFields({ json: JSON.stringify(payload) });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain('\n');
    expect(result.error).toContain('headline');
    expect(result.error).toContain('dedup_id');
  });

  it('reports a malformed-JSON failure as a single line', () => {
    const result = parseItemFields({ json: '{not\nvalid\njson' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toContain('\n');
  });

  it('carries the raw payload through on failure so it can be logged', () => {
    const result = parseItemFields({ json: '{not valid json' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.raw).toBe('{not valid json');
  });
});
