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

  it('flattens embedded newlines and tabs in an unparseable payload to spaces', async () => {
    // A one-line-per-item log is only one line per item if the raw preview is
    // flattened. Every other payload in this file is newline-free, so without this
    // test truncateRaw's `.replace(/[\r\n\t]+/g, ' ')` is entirely unpinned.
    const malformedMultiline = '{not valid json\n"headline":\t"x",\r\n"snippet": "y"';

    await client.xAdd(streamKey, '*', { json: malformedMultiline });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-8',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.raw).not.toMatch(/[\r\n\t]/);
      expect(outcome.raw).toBe('{not valid json "headline": "x", "snippet": "y"');
      expect(outcome.raw).not.toContain('...(truncated)');
    }
  });

  it('passes a short newline-free unparseable payload through unchanged and unmarked', async () => {
    const malformedShort = '{not valid json';

    await client.xAdd(streamKey, '*', { json: malformedShort });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-9',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.raw).toBe(malformedShort);
      expect(outcome.raw).not.toContain('...(truncated)');
    }
  });

  it('processes a full multi-item batch in one read: matches, replay, amendment, and a truncated oversized parse failure', async () => {
    const normalMatch = realisticPayload({
      headline: 'Trump approval rating steady this week',
    });
    const replayItem = realisticPayload({
      headline: 'Local weather stays mild this week',
      replay: true,
    });
    const amendedMatch = realisticPayload({
      headline: 'Trump approval rating revised upward',
      event_type: 'item_amended',
      amends_item_id: randomUUID(),
      amendment_kind: 'headline_changed',
    });
    const noMatch = realisticPayload({
      headline: 'City council approves new park budget',
    });
    const malformedOversizedRaw = '{' + 'x'.repeat(600) + ':not valid';

    await client.xAdd(streamKey, '*', { json: JSON.stringify(normalMatch) });
    await client.xAdd(streamKey, '*', { json: JSON.stringify(replayItem) });
    await client.xAdd(streamKey, '*', { json: JSON.stringify(amendedMatch) });
    await client.xAdd(streamKey, '*', { json: JSON.stringify(noMatch) });
    await client.xAdd(streamKey, '*', { json: malformedOversizedRaw });

    const seededCount = 5;
    const outcomes: ItemOutcome[] = [];
    const controller = new AbortController();

    await runOnce(
      client,
      { streamKey, groupName, consumerName: 'consumer-7', blockMs: 500, count: 10 },
      compilePhrases(['trump approval rating']),
      (outcome) => {
        outcomes.push(outcome);
        if (outcomes.length >= seededCount) controller.abort();
      },
      controller.signal
    );

    expect(outcomes).toHaveLength(seededCount);

    const truncatedMarker = '...(truncated)';
    const failed = outcomes.filter((o): o is Extract<ItemOutcome, { ok: false }> => !o.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].raw).toContain(truncatedMarker);
    expect(failed[0].raw.length).toBeLessThanOrEqual(500 + truncatedMarker.length);

    const succeeded = outcomes.filter((o): o is Extract<ItemOutcome, { ok: true }> => o.ok);
    expect(succeeded).toHaveLength(4);

    const trumpMatches = succeeded.filter((o) => o.item.headline.startsWith('Trump approval rating'));
    expect(trumpMatches).toHaveLength(2);
    for (const outcome of trumpMatches) {
      expect(outcome.matchedPhrases).toEqual(['trump approval rating']);
    }

    const replayOutcome = succeeded.find((o) => o.item.replay === true);
    expect(replayOutcome).toBeDefined();
    if (replayOutcome) {
      expect(replayOutcome.matchedPhrases).toEqual([]);
    }

    const amendedOutcome = succeeded.find((o) => o.item.event_type === 'item_amended');
    expect(amendedOutcome).toBeDefined();
    if (amendedOutcome) {
      expect(amendedOutcome.item.amendment_kind).toBe('headline_changed');
      expect(amendedOutcome.item.amends_item_id).toBeTruthy();
      expect(amendedOutcome.matchedPhrases).toEqual(['trump approval rating']);
    }

    const noMatchOutcome = succeeded.find((o) => o.item.headline.startsWith('City council'));
    expect(noMatchOutcome).toBeDefined();
    if (noMatchOutcome) {
      expect(noMatchOutcome.matchedPhrases).toEqual([]);
    }
  });
});
