import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { deriveClientOrderId, buildOrderBody, reconcileOrder, placeOrder, type PlaceOrderDeps } from '../../src/execute/order.js';
import { KalshiClient, KalshiRequestError } from '../../src/execute/kalshiClient.js';
import { openLedger, recordPendingDecision, resolveDecision, type DecisionRecord } from '../../src/decide/ledger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

function mockClient(overrides: Partial<KalshiClient> = {}): KalshiClient {
  return { createOrder: async () => { throw new Error('not stubbed'); }, getOrders: async () => ({ orders: [] }), getPositions: async () => ({ market_positions: [] }), getBalance: async () => ({ balance: 0 }), ...overrides } as unknown as KalshiClient;
}

/**
 * Local fixture mirroring test/decide/ledger.test.ts's own tradeRecord() (not
 * exported from there, so duplicated here rather than reached across test files).
 */
let itemSeq = 0;
function tradeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: `item-${++itemSeq}`,
    storyKey: 'story-1',
    eventTicker: 'KXAPRPOTUS-26AUG28',
    marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
    side: 'yes',
    rung: 'reported',
    direction: 'up',
    magnitudePts: 0.3,
    contracts: 10,
    entryPriceCents: 10,
    notionalCents: 100,
    edgeCents: 3,
    wouldTrade: true,
    reason: '10 contracts, 3c edge',
    orderStatus: 'resolved',
    ...overrides,
  };
}

describe('deriveClientOrderId', () => {
  it('is deterministic: the same itemId always produces the same id', () => {
    expect(deriveClientOrderId('item-123')).toBe(deriveClientOrderId('item-123'));
  });

  it('is UUID-shaped (matches Kalshi\'s expected client_order_id format)', () => {
    expect(deriveClientOrderId('item-123')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('differs for different itemIds', () => {
    expect(deriveClientOrderId('item-1')).not.toBe(deriveClientOrderId('item-2'));
  });
});

describe('buildOrderBody', () => {
  it('builds a YES order as a bid at entryPriceCents', () => {
    const body = buildOrderBody({
      itemId: 'item-1', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'yes', contracts: 83, entryPriceCents: 12,
    });
    expect(body).toEqual({
      ticker: 'KXAPRPOTUS-26AUG28-40.6',
      side: 'bid',
      count: '83',
      price: '0.1200',
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      client_order_id: deriveClientOrderId('item-1'),
    });
  });

  it('builds a NO order as an ask at the YES-equivalent price (100 - entryPriceCents)', () => {
    const body = buildOrderBody({
      itemId: 'item-2', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'no', contracts: 5, entryPriceCents: 42,
    });
    expect(body.side).toBe('ask');
    expect(body.price).toBe('0.5800'); // (100 - 42) / 100
    expect(body.count).toBe('5');
  });

  it('always sets IOC time_in_force and taker_at_cross self-trade prevention', () => {
    const body = buildOrderBody({ itemId: 'i', marketTicker: 'T', side: 'yes', contracts: 1, entryPriceCents: 50 });
    expect(body.time_in_force).toBe('immediate_or_cancel');
    expect(body.self_trade_prevention_type).toBe('taker_at_cross');
  });
});

describe('reconcileOrder', () => {
  it('reports "filled" when the position diff meets or exceeds the requested contracts', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 83 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 0, 83);
    expect(result).toEqual({ filledContracts: 83, status: 'filled' });
  });

  it('reports "partial" when the position diff is positive but less than requested', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 40 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 0, 83);
    expect(result).toEqual({ filledContracts: 40, status: 'partial' });
  });

  it('reports "unfilled" when the order is found but the position never changed', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 10 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 10, 83);
    expect(result).toEqual({ filledContracts: 0, status: 'unfilled' });
  });

  it('reports "unknown" when getOrders has no record AND the position never changed', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 5 }] }),
    });
    const result = await reconcileOrder(client, 'cid-missing', 'T', 5, 83);
    expect(result).toEqual({ filledContracts: 0, status: 'unknown' });
  });

  it('uses the STORED positionBeforeContracts, not a fresh read -- proves a different decision\'s fill on the same ticker in between does not corrupt this reconciliation', async () => {
    // Suppose this order's own before-snapshot was 20, but by the time we reconcile,
    // a completely different decision on the same market_ticker has also filled,
    // pushing the CURRENT position to 60. The diff against the ORIGINAL 20 (not a
    // fresh "before" of 0, and not confused by attributing the other decision's
    // contracts to this one) must still be computed correctly as 40.
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 60 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 20, 40);
    expect(result).toEqual({ filledContracts: 40, status: 'filled' });
  });
});

describe('placeOrder', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'placeorder-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseInput = (overrides: Partial<Parameters<typeof placeOrder>[0]> = {}) => ({
    itemId: 'item-1', eventTicker: 'KXAPRPOTUS-26AUG28', marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
    side: 'yes' as const, contracts: 83, entryPriceCents: 12, notionalCents: 996,
    positionBeforeContracts: 0, ...overrides,
  });

  it('declines at execution (no Kalshi call at all, not even a position read) when the final exposure recheck would breach the $40 cap', async () => {
    let createOrderCalled = false;
    let getPositionsCalled = false;
    const client = mockClient({
      createOrder: async () => { createOrderCalled = true; return { order: { order_id: 'x', status: 'executed' } }; },
      getPositions: async () => { getPositionsCalled = true; return { market_positions: [] }; },
    });
    // Insert existing resolved would-trade rows that already consume $39.50 of the
    // same event's cap. Split across four rows (1000+1000+1000+950 cents) because
    // MAX_NOTIONAL_CENTS_PER_TRADE (1000c) caps any single would-trade row's
    // notional_cents -- the brief's own single-row 10 x 395 example would violate
    // both that per-trade cap AND the entry_price_cents < 100 CHECK directly
    // against the Task 2 schema; verified by running it.
    for (const notionalCents of [1000, 1000, 1000, 950]) {
      const decisionId = recordPendingDecision(db, tradeRecord({ eventTicker: 'KXAPRPOTUS-26AUG28', notionalCents, contracts: notionalCents, entryPriceCents: 1 }));
      resolveDecision(db, decisionId, tradeRecord({ eventTicker: 'KXAPRPOTUS-26AUG28', notionalCents, contracts: notionalCents, entryPriceCents: 1, wouldTrade: true, orderStatus: 'resolved' }));
    }

    const result = await placeOrder(baseInput({ notionalCents: 996 }), { client, db });

    expect(createOrderCalled).toBe(false);
    expect(getPositionsCalled).toBe(false);
    expect(result.status).toBe('declined-at-execution');
    expect(result.filledContracts).toBe(0);
  });

  it('places a full fill: position (relative to the CALLER-supplied positionBeforeContracts) moves by exactly the requested contracts', async () => {
    let getPositionsCalls = 0;
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-1', status: 'executed' } }),
      getPositions: async () => {
        getPositionsCalls += 1;
        return { market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] };
      },
    });

    const result = await placeOrder(baseInput({ positionBeforeContracts: 0 }), { client, db });

    expect(getPositionsCalls).toBe(1); // only the "after" snapshot -- "before" comes from the input, not a fresh read
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
    expect(result.avgFillPriceCents).toBe(12); // the limit price -- never worse
    expect(result.kalshiOrderId).toBe('kalshi-1');
  });

  it('places a partial fill correctly, diffed against a non-zero positionBeforeContracts', async () => {
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-2', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 25 }] }),
    });

    const result = await placeOrder(baseInput({ positionBeforeContracts: 10 }), { client, db }); // 25 - 10 = 15 filled
    expect(result.status).toBe('partial');
    expect(result.filledContracts).toBe(15);
  });

  it('retries on a 429 and succeeds on the second attempt', async () => {
    let attempts = 0;
    const client = mockClient({
      createOrder: async () => {
        attempts += 1;
        if (attempts === 1) throw new KalshiRequestError('rate limited', 429, 1);
        return { order: { order_id: 'kalshi-3', status: 'executed' } };
      },
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), { client, db });
    expect(attempts).toBe(2);
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
  });

  it('gives up after 3 attempts and reconciles via position diff, finding a real fill', async () => {
    let attempts = 0;
    const client = mockClient({
      createOrder: async () => { attempts += 1; throw new KalshiRequestError('server error', 500, null); },
      getOrders: async () => ({ orders: [{ client_order_id: deriveClientOrderId('item-1'), ticker: 'KXAPRPOTUS-26AUG28-40.6' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), { client, db, sleepFn: async () => {} });
    expect(attempts).toBe(3);
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
    expect(result.errorDetail).toMatch(/server error/);
  });

  it('gives up after 3 attempts and reconciles via position diff, finding genuinely nothing', async () => {
    const client = mockClient({
      createOrder: async () => { throw new KalshiRequestError('timeout', 503, null); },
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [] }),
    });

    const result = await placeOrder(baseInput(), { client, db, sleepFn: async () => {} });
    expect(result.status).toBe('unknown');
    expect(result.filledContracts).toBe(0);
  });

  it('retries a network-level error with no HTTP status at all (e.g. ECONNRESET), and reconciles on exhaustion', async () => {
    let attempts = 0;
    const client = mockClient({
      createOrder: async () => { attempts += 1; throw new Error('ECONNRESET'); },
      getOrders: async () => ({ orders: [{ client_order_id: deriveClientOrderId('item-1'), ticker: 'KXAPRPOTUS-26AUG28-40.6' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), { client, db, sleepFn: async () => {} });
    expect(attempts).toBe(3);
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
    expect(result.errorDetail).toMatch(/ECONNRESET/);
  });

  it('sleeps for exactly the Retry-After duration when Kalshi supplies one, not a backoff-computed value', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const client = mockClient({
      createOrder: async () => {
        attempts += 1;
        if (attempts === 1) throw new KalshiRequestError('rate limited', 429, 1000);
        return { order: { order_id: 'kalshi-retry-after', status: 'executed' } };
      },
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), {
      client, db, sleepFn: async (ms) => { delays.push(ms); },
    });

    expect(delays).toEqual([1000]);
    expect(result.status).toBe('filled');
  });

  it('sleeps a growing exponential-backoff-plus-jitter sequence when no Retry-After header is present', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const baseDelayMs = 500;
    const client = mockClient({
      createOrder: async () => {
        attempts += 1;
        throw new KalshiRequestError('server error', 500, null);
      },
    });

    const result = await placeOrder(baseInput(), {
      client, db, baseDelayMs, sleepFn: async (ms) => { delays.push(ms); },
    });

    // 2 sleeps between 3 attempts (none after the last, exhausted attempt).
    expect(delays).toHaveLength(2);
    delays.forEach((delay, attempt) => {
      const floor = baseDelayMs * 2 ** attempt;
      expect(delay).toBeGreaterThanOrEqual(floor);
      expect(delay).toBeLessThanOrEqual(floor + baseDelayMs);
    });
    // The per-attempt ranges are disjoint (attempt 0 tops out below 1000, attempt
    // 1 starts at 1000), so this alone proves a real growing backoff schedule is
    // in force, not a flat or shrinking one.
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(result.status).toBe('unknown'); // getOrders/getPositions default to empty in mockClient()
  });

  it('does not retry a definite 4xx rejection (not 429), and records it as rejected without reconciling', async () => {
    let attempts = 0;
    let getOrdersCalled = false;
    const client = mockClient({
      createOrder: async () => { attempts += 1; throw new KalshiRequestError('insufficient balance', 400, null); },
      getOrders: async () => { getOrdersCalled = true; return { orders: [] }; },
    });

    const result = await placeOrder(baseInput(), { client, db });
    expect(attempts).toBe(1);
    expect(getOrdersCalled).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.filledContracts).toBe(0);
  });

  it('simulates a full fill under KALSHI_DRY_RUN without calling getPositions at all', async () => {
    const originalDryRun = process.env.KALSHI_DRY_RUN;
    process.env.KALSHI_DRY_RUN = 'true';
    try {
      let getPositionsCalls = 0;
      const client = mockClient({
        createOrder: async (body) => ({ order: { order_id: `DRYRUN-${body.client_order_id}`, status: 'dryrun' } }),
        getPositions: async () => { getPositionsCalls += 1; return { market_positions: [] }; },
      });

      const result = await placeOrder(baseInput(), { client, db });
      expect(result.status).toBe('filled');
      expect(result.filledContracts).toBe(83);
      expect(result.avgFillPriceCents).toBe(12);
      expect(getPositionsCalls).toBe(0);
    } finally {
      if (originalDryRun === undefined) delete process.env.KALSHI_DRY_RUN;
      else process.env.KALSHI_DRY_RUN = originalDryRun;
    }
  });
});
