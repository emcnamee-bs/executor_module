import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../src/redis/client.js';
import { runOnce, type ItemOutcome } from '../src/main.js';
import { compilePhrases } from '../src/keyphrases/match.js';
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

async function runOnceForOneEntry(
  client: RedisClientType,
  streamKey: string,
  groupName: string,
  consumerName: string,
  compiledPhrases: ReturnType<typeof compilePhrases>
): Promise<ItemOutcome> {
  const outcomes: ItemOutcome[] = [];
  const controller = new AbortController();

  await runOnce(
    client,
    { streamKey, groupName, consumerName, blockMs: 500, count: 10 },
    compiledPhrases,
    (outcome) => {
      outcomes.push(outcome);
      controller.abort();
    },
    controller.signal
  );

  expect(outcomes).toHaveLength(1);
  return outcomes[0];
}

describe('runOnce with keyphrase matching (end-to-end)', () => {
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

  it('reports a matched phrase found in the headline', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ headline: 'Trump approval rating drops sharply' })),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-1',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual(['trump approval rating']);
    }
  });

  it('reports no matched phrases when none appear', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ headline: 'Local weather stays mild this week' })),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-2',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual([]);
    }
  });

  it('matches against snippet only for a synthetic-headline item', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          headline: 'ofac_recent_actions: watched page region changed',
          snippet: 'New sanctions announced amid trump approval rating criticism',
          provenance_gaps: ['synthetic_headline'],
        })
      ),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-3',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual(['trump approval rating']);
    }
  });

  it('does not match a phrase that appears only in a synthetic item\'s templated headline', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          headline: 'special approval board: watched page region changed',
          snippet: 'Unrelated content with no keyphrase here',
          provenance_gaps: ['synthetic_headline'],
        })
      ),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-4',
      compilePhrases(['special approval board'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual([]);
    }
  });

  it('reports multiple matched phrases together', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          headline: 'Trump approval rating steady',
          snippet: 'A new Rasmussen poll was released today',
        })
      ),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-5',
      compilePhrases(['trump approval rating', 'new rasmussen poll'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases.sort()).toEqual(
        ['new rasmussen poll', 'trump approval rating'].sort()
      );
    }
  });

  it('still reports a parse error for malformed JSON, unaffected by keyphrase matching', async () => {
    await client.xAdd(streamKey, '*', { json: '{not valid json' });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-6',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).not.toContain('\n');
      expect(outcome.raw).not.toContain('\n');
    }
  });
});
