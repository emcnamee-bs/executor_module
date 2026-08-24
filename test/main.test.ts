import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../src/redis/client.js';
import { runOnce } from '../src/main.js';
import type { RedisClientType } from 'redis';

function realisticPayload(overrides: Record<string, unknown> = {}) {
  return {
    item_id: `${Date.now()}-${randomUUID().slice(0, 12)}`,
    dedup_id: randomUUID(),
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

describe('runOnce (end-to-end)', () => {
  let client: RedisClientType;
  let streamKey: string;
  let groupName: string;

  beforeEach(async () => {
    client = createRedisClient();
    await client.connect();
    streamKey = `test:iip:items:${randomUUID()}`;
    groupName = `test-execmod-${randomUUID()}`;
  });

  afterEach(async () => {
    await client.del(streamKey);
    await client.quit();
  });

  it('logs a real item, a synthetic-headline item, a replay, an amendment, and a body-absent item', async () => {
    await client.xAdd(streamKey, '*', { json: JSON.stringify(realisticPayload()) });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ provenance_gaps: ['synthetic_headline'] })),
    });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ replay: true })),
    });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          event_type: 'item_amended',
          amends_item_id: 'some-prior-id',
          amendment_kind: 'headline_changed',
        })
      ),
    });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ body_state: 'absent', body: null })),
    });
    await client.xAdd(streamKey, '*', { json: '{not valid json' });

    const lines: string[] = [];
    const controller = new AbortController();
    let handled = 0;

    await runOnce(
      client,
      { streamKey, groupName, consumerName: 'test-main-consumer', blockMs: 500, count: 10 },
      (line) => {
        lines.push(line);
        handled += 1;
        if (handled >= 6) controller.abort();
      },
      controller.signal
    );

    expect(lines).toHaveLength(6);
    expect(lines.some((l) => l.includes('[synthetic]'))).toBe(true);
    expect(lines.some((l) => l.includes('REPLAY'))).toBe(true);
    expect(lines.some((l) => l.includes('event=item_amended'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[parse-error]'))).toBe(true);
  });
});
