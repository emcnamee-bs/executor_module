import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createRedisClient } from '../src/redis/client.js';
import { runOnce, makeOnItem, type ItemOutcome } from '../src/main.js';
import { compilePhrases } from '../src/keyphrases/match.js';
import { openLedger, recordPendingDecision, recordPendingOrder } from '../src/decide/ledger.js';
import { reconcilePendingOrders } from '../src/execute/order.js';
import * as orderModule from '../src/execute/order.js';
import type { ActiveLadder } from '../src/decide/kalshi.js';
import * as synopsisModule from '../src/decide/synopsis.js';
import * as verifyModule from '../src/decide/verify.js';
import * as decideModule from '../src/decide/decide.js';
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

/**
 * Same fixture as `test/decide/pipeline.test.ts`'s `stubLadder()`: a ladder whose
 * bands are spaced widely enough that a 0.3pt shift lands inside the fair-value
 * curve and clears `evaluateSizing`'s gates, so the wiring test below exercises the
 * real would-trade path rather than an early decline. Duplicated rather than
 * imported, since importing from another test file would re-run its suite.
 */
function stubLadder(): ActiveLadder {
  return {
    eventTicker: 'KXAPRPOTUS-26AUG28',
    strikeDate: '2026-08-28T16:00:00Z',
    bands: [
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.2',
        floorStrike: 39.8,
        capStrike: 40.2,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 20,
        yesBidCents: 18,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.6',
        floorStrike: 40.2,
        capStrike: 40.6,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 60,
        yesBidCents: 58,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-41.0',
        floorStrike: 40.6,
        capStrike: null,
        strikeType: 'greater',
        status: 'active',
        yesAskCents: 12,
        yesBidCents: 10,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
    ],
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

  it('awaits an async onItem callback before acking the entry', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ headline: 'Trump approval rating drops sharply' })),
    });

    const compiled = compilePhrases(['trump approval rating']);
    const order: string[] = [];
    const controller = new AbortController();

    await runOnce(
      client,
      { streamKey, groupName, consumerName: 'consumer-async', blockMs: 500, count: 10 },
      compiled,
      async (outcome) => {
        order.push('onItem-start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('onItem-end');
        controller.abort();
      },
      controller.signal
    );

    expect(order).toEqual(['onItem-start', 'onItem-end']);
  });
});

/**
 * The pipeline reads a position snapshot directly (via kalshiClient.getPositions())
 * before placeOrder is ever called -- same stub shape as
 * `test/decide/pipeline.test.ts`'s `stubKalshiClient()`, duplicated rather than
 * imported for the same reason `stubLadder()` above is.
 */
function stubKalshiClient(position = 0) {
  return { getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position }] }) } as any;
}

/**
 * The one test that proves the WIRING, not the pieces. `test/decide/pipeline.test.ts`
 * calls `runDecisionPipeline` directly and the suite above drives `runOnce` with its
 * own callback, so before this existed, deleting the `runDecisionPipeline` call from
 * `main.ts` altogether left the whole suite green.
 */
describe('makeOnItem wiring (real Redis entry -> decision pipeline -> real ledger row)', () => {
  let client: RedisClientType;
  let streamKey: string;
  let groupName: string;
  let dir: string;
  let db: ReturnType<typeof openLedger>;

  beforeEach(async () => {
    client = createRedisClient();
    await client.connect();
    streamKey = `test:iip:items:${randomUUID()}`;
    groupName = `test-execmod-${randomUUID()}`;
    dir = mkdtempSync(path.join(tmpdir(), 'main-wiring-test-'));
    db = openLedger(path.join(dir, 'test.db'));
    delete process.env.EXECUTOR_TRADING_HALTED;

    vi.spyOn(synopsisModule, 'synopsize').mockResolvedValue('The unemployment rate fell to 3.9%.');
    vi.spyOn(verifyModule, 'verifySynopsis').mockResolvedValue({ supported: true, note: 'faithful' });
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
      direction: 'up',
      magnitudePts: 0.3,
      shouldTrade: true,
      reasoning: 'stronger-than-expected jobs data typically lifts approval',
    });
    // Default: a clean full fill at the sized price/contracts, matching
    // `test/decide/pipeline.test.ts`'s own default -- this suite tests the WIRING
    // (a real stream entry reaching a real ledger row), not execution specifics,
    // which are already covered by the pipeline's own tests.
    vi.spyOn(orderModule, 'placeOrder').mockImplementation(async (input) => ({
      clientOrderId: 'default-mock-client-order-id',
      kalshiOrderId: 'default-mock-kalshi-order-id',
      filledContracts: input.contracts,
      avgFillPriceCents: input.entryPriceCents,
      status: 'filled',
      errorDetail: null,
    }));
    // The real callback logs a summary line and a [KEYPHRASE-MATCH] line per item;
    // silenced so this test's output stays clean, not to suppress a failure.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await client.del(streamKey);
    await client.quit();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes a real would-trade ledger row for a matched entry consumed off the stream', async () => {
    const payload = realisticPayload({
      headline: 'Trump approval rating drops after new jobs report',
      snippet: 'The unemployment rate declined to 3.9% in July.',
    });
    await client.xAdd(streamKey, '*', { json: JSON.stringify(payload) });

    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    const onItem = makeOnItem({
      anthropicClient: new Anthropic({ apiKey: 'sk-ant-unused-in-these-tests' }),
      db,
      fetchLadder,
      kalshiClient: stubKalshiClient(),
    });

    const controller = new AbortController();
    await runOnce(
      client,
      { streamKey, groupName, consumerName: 'consumer-wiring', blockMs: 500, count: 10 },
      compilePhrases(['trump approval rating']),
      async (outcome) => {
        await onItem(outcome); // the real production callback, unmodified
        controller.abort(); // test-only: stop the consumer after this one entry
      },
      controller.signal
    );

    expect(fetchLadder).toHaveBeenCalledWith('KXAPRPOTUS');

    const rows = db
      .prepare(
        `SELECT item_id, would_trade, event_ticker, market_ticker, contracts,
                entry_price_cents, notional_cents, rung
         FROM decisions WHERE item_id = ?`
      )
      .all(payload.item_id) as Array<{
      item_id: string;
      would_trade: number;
      event_ticker: string | null;
      market_ticker: string | null;
      contracts: number;
      entry_price_cents: number | null;
      notional_cents: number;
      rung: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].would_trade).toBe(1);
    expect(rows[0].event_ticker).toBe('KXAPRPOTUS-26AUG28');
    expect(rows[0].rung).toBe('reported');
    expect(rows[0].contracts).toBeGreaterThan(0);
    expect(rows[0].notional_cents).toBe(rows[0].contracts * rows[0].entry_price_cents!);
    expect(rows[0].notional_cents).toBeLessThanOrEqual(1000);
  });

  it('does not run the decision pipeline for an entry that matched no keyphrase', async () => {
    const payload = realisticPayload({ headline: 'Local weather stays mild this week' });
    await client.xAdd(streamKey, '*', { json: JSON.stringify(payload) });

    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    const onItem = makeOnItem({
      anthropicClient: new Anthropic({ apiKey: 'sk-ant-unused-in-these-tests' }),
      db,
      fetchLadder,
      kalshiClient: stubKalshiClient(),
    });

    const controller = new AbortController();
    await runOnce(
      client,
      { streamKey, groupName, consumerName: 'consumer-wiring-nomatch', blockMs: 500, count: 10 },
      compilePhrases(['trump approval rating']),
      async (outcome) => {
        await onItem(outcome);
        controller.abort();
      },
      controller.signal
    );

    expect(synopsisModule.synopsize).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM decisions`).get()).toEqual({ n: 0 });
  });

  /**
   * This test exercises `reconcilePendingOrders` directly (already fully tested in
   * Task 5) -- its purpose here is only to confirm this file's imports/fixtures line
   * up with the real call, since `main()` itself wires the actual startup call and
   * isn't independently re-tested (no test drives `main()` end-to-end; that would
   * require a real Redis + Kalshi credentials).
   */
  it('startup reconciles an orphaned pending order before consuming any stream entries', async () => {
    // Hand-insert a pending decision+order pair, simulating a prior crash.
    const decisionId = recordPendingDecision(db, {
      itemId: 'orphan-1', storyKey: null, eventTicker: 'KXAPRPOTUS-26AUG28', marketTicker: 'T',
      side: 'yes', rung: 'reported', direction: 'up', magnitudePts: 0.3, contracts: 5,
      entryPriceCents: 12, notionalCents: 60, edgeCents: 3, wouldTrade: true, reason: 'pre-crash', orderStatus: 'pending',
    });
    recordPendingOrder(db, { decisionId, clientOrderId: 'orphan-cid', marketTicker: 'T', requestedContracts: 5, positionBeforeContracts: 0 });

    const kalshiClient = {
      getOrders: async () => ({ orders: [{ client_order_id: 'orphan-cid', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 5 }] }),
    } as any;

    await reconcilePendingOrders(db, kalshiClient);

    const resolved = db.prepare('SELECT would_trade, contracts FROM decisions WHERE item_id = ?').get('orphan-1') as {
      would_trade: number; contracts: number;
    };
    expect(resolved.would_trade).toBe(1);
    expect(resolved.contracts).toBe(5);
  });
});
