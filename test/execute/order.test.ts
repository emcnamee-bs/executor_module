import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deriveClientOrderId, buildOrderBody, reconcileOrder, placeOrder, reconcilePendingOrders, reconcileOrphanedPendingDecisions, signedFillDelta } from '../../src/execute/order.js';
import { KalshiClient, KalshiRequestError } from '../../src/execute/kalshiClient.js';
import { openLedger, recordPendingDecision, resolveDecision, findPendingOrders, recordPendingOrder, resolveOrder, totalExposureCents, isMarketBlocked, blockMarket, type DecisionRecord } from '../../src/decide/ledger.js';
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

describe('signedFillDelta', () => {
  it('reads a YES fill as an INCREASE in the signed position', () => {
    expect(signedFillDelta('yes', 0, 83)).toBe(83);
    expect(signedFillDelta('yes', 20, 60)).toBe(40);
  });

  it('reads a NO fill as a DECREASE in the signed position (Kalshi\'s position field is signed: negative = a NO holding)', () => {
    expect(signedFillDelta('no', 0, -83)).toBe(83);
    expect(signedFillDelta('no', -10, -93)).toBe(83);
  });

  it('floors at zero rather than reporting a negative fill, on either side', () => {
    expect(signedFillDelta('yes', 50, 10)).toBe(0);
    expect(signedFillDelta('no', -50, -10)).toBe(0);
  });
});

describe('reconcileOrder', () => {
  it('reports "filled" when the position diff meets or exceeds the requested contracts', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 83 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 'yes', 0, 83);
    expect(result).toEqual({ filledContracts: 83, status: 'filled' });
  });

  it('reports "partial" when the position diff is positive but less than requested', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 40 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 'yes', 0, 83);
    expect(result).toEqual({ filledContracts: 40, status: 'partial' });
  });

  it('reports "unfilled" when the order is found but the position never changed', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 10 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 'yes', 10, 83);
    expect(result).toEqual({ filledContracts: 0, status: 'unfilled' });
  });

  it('reports "unknown" when getOrders has no record AND the position never changed', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 5 }] }),
    });
    const result = await reconcileOrder(client, 'cid-missing', 'T', 'yes', 5, 83);
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
    const result = await reconcileOrder(client, 'cid-1', 'T', 'yes', 20, 40);
    expect(result).toEqual({ filledContracts: 40, status: 'filled' });
  });

  // --- C1: Kalshi's `position` is SIGNED; a NO fill moves it DOWN ---------------

  it('detects a full NO-side fill, where the position went MORE NEGATIVE (-10 -> -93)', async () => {
    // REGRESSION GUARD for the C1 defect. The pre-fix math was
    // `Math.max(0, positionNow - positionBeforeContracts)`, i.e. -93 - -10 = -83,
    // clamped to 0 -- a real, fully-executed 83-contract NO position recorded as
    // filledContracts 0 / status 'unfilled' / zero exposure. Since evaluateSizing
    // picks whichever side has the better edge, this is roughly half of all trades.
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-no', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: -93 }] }),
    });
    const result = await reconcileOrder(client, 'cid-no', 'T', 'no', -10, 83);
    expect(result).toEqual({ filledContracts: 83, status: 'filled' });
  });

  it('detects a partial NO-side fill from a flat (zero) starting position', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-no', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: -40 }] }),
    });
    const result = await reconcileOrder(client, 'cid-no', 'T', 'no', 0, 83);
    expect(result).toEqual({ filledContracts: 40, status: 'partial' });
  });

  it('reports a NO order whose position never moved as unfilled, not as a phantom fill', async () => {
    // The mirror-image error: a side-agnostic `Math.abs(diff)` "fix" would also
    // pass the tests above while inventing fills out of unrelated YES-direction
    // movement. The direction of the move has to match the side that was bought.
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-no', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 30 }] }), // moved the WRONG way for a NO buy
    });
    const result = await reconcileOrder(client, 'cid-no', 'T', 'no', 0, 83);
    expect(result).toEqual({ filledContracts: 0, status: 'unfilled' });
  });

  // --- I4: an IOC order can never fill more than it requested -------------------

  it('clamps the computed fill to requestedContracts when the position moved further than this order could account for', async () => {
    // An unrelated position move between the two snapshots. Recording 50 here would
    // inflate notional_cents and can trip the ledger's own per-trade CHECK.
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 50 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 'yes', 0, 10);
    expect(result).toEqual({ filledContracts: 10, status: 'filled' });
  });

  it('clamps an over-large NO-side diff to requestedContracts too', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-no', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: -50 }] }),
    });
    const result = await reconcileOrder(client, 'cid-no', 'T', 'no', 0, 10);
    expect(result).toEqual({ filledContracts: 10, status: 'filled' });
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

  it('declines at execution (no Kalshi call at all) when the market_ticker is blocked', async () => {
    blockMarket(db, 'KXAPRPOTUS-26AUG28-40.6', 'reconciliation divergence: expected 10, real 0', 10, 0);
    let createOrderCalled = false;
    let getPositionsCalled = false;
    const client = mockClient({
      createOrder: async () => { createOrderCalled = true; return { order: { order_id: 'x', status: 'executed' } }; },
      getPositions: async () => { getPositionsCalled = true; return { market_positions: [] }; },
    });

    const result = await placeOrder(baseInput({ marketTicker: 'KXAPRPOTUS-26AUG28-40.6' }), { client, db });

    expect(createOrderCalled).toBe(false);
    expect(getPositionsCalled).toBe(false);
    expect(result.status).toBe('declined-at-execution');
    expect(result.errorDetail).toMatch(/blocked/);
    expect(result.filledContracts).toBe(0);
  });

  it('places normally when the market_ticker has never been blocked', async () => {
    // Regression guard: the new check must not accidentally decline every order.
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-1', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), { client, db });

    expect(result.status).toBe('filled');
  });

  it('places normally when a PREVIOUS block on this market_ticker was cleared', async () => {
    blockMarket(db, 'KXAPRPOTUS-26AUG28-40.6', 'old divergence', 10, 0);
    db.prepare(`UPDATE market_blocks SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE market_ticker = ?`).run('KXAPRPOTUS-26AUG28-40.6');
    expect(isMarketBlocked(db, 'KXAPRPOTUS-26AUG28-40.6')).toBe(false);

    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-2', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), { client, db });

    expect(result.status).toBe('filled');
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
    // I3: Kalshi's own word for the order is captured, not discarded -- the only
    // persisted evidence of what the exchange itself said about this order.
    expect(result.kalshiOrderStatus).toBe('executed');
    expect(result.dryRun).toBe(false);
  });

  // --- C1: a NO-side fill moves the SIGNED position DOWN ------------------------

  it('places a full NO-side fill: the position went from -10 to -93, i.e. 83 contracts of NO', async () => {
    // REGRESSION GUARD for C1 at placeOrder's direct-success branch. The pre-fix
    // math was `Math.max(0, positionAfter - input.positionBeforeContracts)`:
    // -93 - -10 = -83 -> clamped to 0 -> a real 83-contract NO position recorded
    // as 'unfilled', 0 contracts, 0 notional. Both preceding assertions below
    // (status and filledContracts) go red against that old logic.
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-no-1', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: -93 }] }),
    });

    const result = await placeOrder(
      baseInput({ side: 'no', positionBeforeContracts: -10, contracts: 83 }),
      { client, db }
    );

    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
    expect(result.avgFillPriceCents).toBe(12);
  });

  it('places a partial NO-side fill from a flat position', async () => {
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-no-2', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: -15 }] }),
    });

    const result = await placeOrder(baseInput({ side: 'no', positionBeforeContracts: 0 }), { client, db });
    expect(result.status).toBe('partial');
    expect(result.filledContracts).toBe(15);
  });

  it('does not invent a fill for a NO order when the position moved the WRONG way (upward)', async () => {
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-no-3', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 30 }] }),
    });

    const result = await placeOrder(baseInput({ side: 'no', positionBeforeContracts: 0 }), { client, db });
    expect(result.status).toBe('unfilled');
    expect(result.filledContracts).toBe(0);
    expect(result.avgFillPriceCents).toBeNull();
  });

  it('reconciles an ambiguous NO-side failure against the SIGNED position diff, not an unsigned one', async () => {
    const client = mockClient({
      createOrder: async () => { throw new KalshiRequestError('server error', 500, null); },
      getOrders: async () => ({ orders: [{ client_order_id: deriveClientOrderId('item-1'), ticker: 'KXAPRPOTUS-26AUG28-40.6' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: -83 }] }),
    });

    const result = await placeOrder(
      baseInput({ side: 'no', positionBeforeContracts: 0 }),
      { client, db, sleepFn: async () => {} }
    );
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
  });

  // --- I4: clamp the fill to what was actually requested ------------------------

  it('clamps filledContracts to requestedContracts when the position moved further than this order requested', async () => {
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-clamp', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 50 }] }),
    });

    // 10 requested, but the raw diff computes to 50 (an unrelated position move).
    const result = await placeOrder(
      baseInput({ contracts: 10, notionalCents: 120, positionBeforeContracts: 0 }),
      { client, db }
    );
    expect(result.filledContracts).toBe(10);
    expect(result.status).toBe('filled');
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
    // I3: no createOrder response was ever received, so there is nothing Kalshi
    // itself said about an order -- this must be null, never a fabricated status.
    expect(result.kalshiOrderStatus).toBeNull();
  });

  it('leaves kalshiOrderStatus null on an ambiguous failure, where no createOrder response was ever received', async () => {
    const client = mockClient({
      createOrder: async () => { throw new KalshiRequestError('timeout', 503, null); },
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [] }),
    });

    const result = await placeOrder(baseInput(), { client, db, sleepFn: async () => {} });
    expect(result.kalshiOrderStatus).toBeNull();
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
      // I5: the simulated fill is flagged, so the caller can record it as a skip
      // rather than a phantom real position in the production ledger.
      expect(result.dryRun).toBe(true);
      // The "response" was synthesised locally, so there is no exchange status.
      expect(result.kalshiOrderStatus).toBeNull();
    } finally {
      if (originalDryRun === undefined) delete process.env.KALSHI_DRY_RUN;
      else process.env.KALSHI_DRY_RUN = originalDryRun;
    }
  });
});

describe('reconcilePendingOrders', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'reconcile-startup-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function pendingSetup(
    overrides: {
      requestedContracts?: number;
      positionBeforeContracts?: number;
      side?: 'yes' | 'no';
      clientOrderId?: string;
    } = {}
  ) {
    const side = overrides.side ?? 'yes';
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending', side }));
    const orderId = recordPendingOrder(db, {
      decisionId, clientOrderId: overrides.clientOrderId ?? 'cid-startup', marketTicker: 'T', side,
      requestedContracts: overrides.requestedContracts ?? 83,
      positionBeforeContracts: overrides.positionBeforeContracts ?? 0,
    });
    return { decisionId, orderId };
  }

  it('resolves a crash-orphaned pending order that actually filled', async () => {
    pendingSetup();
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-startup', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 83 }] }),
    });

    await reconcilePendingOrders(db, client);

    expect(findPendingOrders(db)).toHaveLength(0);
    const decisionRow = db.prepare('SELECT would_trade, contracts, order_status FROM decisions').get() as {
      would_trade: number; contracts: number; order_status: string;
    };
    expect(decisionRow.would_trade).toBe(1);
    expect(decisionRow.contracts).toBe(83);
    expect(decisionRow.order_status).toBe('resolved');
  });

  it('resolves a crash-orphaned pending order that never filled', async () => {
    pendingSetup();
    const client = mockClient({
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [] }),
    });

    await reconcilePendingOrders(db, client);

    const decisionRow = db.prepare('SELECT would_trade, order_status FROM decisions').get() as {
      would_trade: number; order_status: string;
    };
    expect(decisionRow.would_trade).toBe(0);
    expect(decisionRow.order_status).toBe('resolved');
  });

  it('uses the STORED positionBeforeContracts from the pending row, not a fresh zero, so a different decision\'s intervening fill on the same ticker cannot corrupt this reconciliation', async () => {
    pendingSetup({ positionBeforeContracts: 20, requestedContracts: 40 });
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-startup', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 60 }] }), // 20 (this order's before) + 40 (this order's real fill)
    });

    await reconcilePendingOrders(db, client);

    const decisionRow = db.prepare('SELECT contracts FROM decisions').get() as { contracts: number };
    expect(decisionRow.contracts).toBe(40);
  });

  it('is a no-op when there are no pending orders', async () => {
    const client = mockClient();
    await expect(reconcilePendingOrders(db, client)).resolves.toBeUndefined();
  });

  // --- C1: recovery reads the stored side, so a NO fill is not lost -------------

  it('resolves a crash-orphaned NO-side order that really filled, reading the side off the stored orders row', async () => {
    // REGRESSION GUARD for C1 at the crash-recovery path -- the one place that has
    // ONLY the DB row to work from. Before the fix the orders table had no `side`
    // column at all, so this fill (position -10 -> -93) was computed as
    // max(0, -93 - -10) = 0 and the decision row was resolved to would_trade=0.
    pendingSetup({ side: 'no', positionBeforeContracts: -10, requestedContracts: 83 });
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-startup', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: -93 }] }),
    });

    await reconcilePendingOrders(db, client);

    expect(findPendingOrders(db)).toHaveLength(0);
    const decisionRow = db.prepare('SELECT would_trade, contracts, side, order_status FROM decisions').get() as {
      would_trade: number; contracts: number; side: string; order_status: string;
    };
    expect(decisionRow.would_trade).toBe(1);
    expect(decisionRow.contracts).toBe(83);
    expect(decisionRow.side).toBe('no');
    expect(decisionRow.order_status).toBe('resolved');
  });

  // --- I1: one bad row must not kill the whole startup pass --------------------

  it('isolates a per-row failure: a transient Kalshi error on one pending row still lets the others resolve, and does not throw', async () => {
    // Without per-row fault isolation, ONE 500 here kills the whole process before
    // the Redis consumer ever starts -- and if the failure is deterministic (an
    // expired key), the identical retry on every restart is a permanent boot loop.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = pendingSetup({ clientOrderId: 'cid-bad', requestedContracts: 83 });
    const second = pendingSetup({ clientOrderId: 'cid-good', requestedContracts: 83 });
    const client = mockClient({
      getOrders: async (query) => {
        if (query?.client_order_id === 'cid-bad') throw new KalshiRequestError('server error', 500, null);
        return { orders: [{ client_order_id: 'cid-good', ticker: 'T' }] };
      },
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 83 }] }),
    });

    await expect(reconcilePendingOrders(db, client)).resolves.toBeUndefined();

    // The failing row is left pending, exactly so the next startup pass retries it.
    const stillPending = findPendingOrders(db);
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].clientOrderId).toBe('cid-bad');
    expect(stillPending[0].id).toBe(first.orderId);

    // The healthy row resolved normally despite its neighbour blowing up.
    const goodOrder = db.prepare('SELECT status, filled_contracts FROM orders WHERE id = ?').get(second.orderId) as {
      status: string; filled_contracts: number;
    };
    expect(goodOrder.status).toBe('filled');
    expect(goodOrder.filled_contracts).toBe(83);
    const goodDecision = db.prepare('SELECT would_trade, order_status FROM decisions WHERE id = ?').get(second.decisionId) as {
      would_trade: number; order_status: string;
    };
    expect(goodDecision.would_trade).toBe(1);
    expect(goodDecision.order_status).toBe('resolved');

    // ...and the failing row's decision is untouched, still pending for next time.
    const badDecision = db.prepare('SELECT order_status FROM decisions WHERE id = ?').get(first.decisionId) as {
      order_status: string;
    };
    expect(badDecision.order_status).toBe('pending');

    // The failure is loud in the log, never silent.
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0][0]).toMatch(/cid-bad/);
    errorLog.mockRestore();
  });

  // --- C2: the two resolve writes are one atomic unit --------------------------

  it('rolls the orders row back too when the decision half of the resolve fails, so recovery can still see the row', async () => {
    // If resolveOrder committed a terminal status on its own while resolveDecision
    // failed, findPendingOrders (which scans ONLY status='pending') would never see
    // this row again -- a real filled position permanently reported as zero
    // exposure. Forced here by filling the event's $40 cap so the decision-side
    // UPDATE trips enforce_total_exposure_on_resolve.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { decisionId, orderId } = pendingSetup({ requestedContracts: 83 });
    for (const storyKey of ['s-a', 's-b', 's-c', 's-d']) {
      const filler = recordPendingDecision(db, tradeRecord({ storyKey, contracts: 1000, entryPriceCents: 1, notionalCents: 1000 }));
      resolveDecision(db, filler, tradeRecord({ storyKey, contracts: 1000, entryPriceCents: 1, notionalCents: 1000, wouldTrade: true, orderStatus: 'resolved' }));
    }

    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-startup', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 83 }] }),
    });

    // I1's per-row catch swallows the failure -- the point here is the STATE.
    await reconcilePendingOrders(db, client);

    const orderRow = db.prepare('SELECT status, filled_contracts, resolved_at FROM orders WHERE id = ?').get(orderId) as {
      status: string; filled_contracts: number; resolved_at: string | null;
    };
    expect(orderRow.status).toBe('pending');
    expect(orderRow.filled_contracts).toBe(0);
    expect(orderRow.resolved_at).toBeNull();
    // ...so it is still visible to the next recovery pass, which is the whole point.
    expect(findPendingOrders(db).map((r) => r.id)).toContain(orderId);

    const decisionRow = db.prepare('SELECT would_trade, order_status FROM decisions WHERE id = ?').get(decisionId) as {
      would_trade: number; order_status: string;
    };
    expect(decisionRow.would_trade).toBe(0);
    expect(decisionRow.order_status).toBe('pending');

    expect(errorLog).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });
});

describe('reconcileOrphanedPendingDecisions', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'orphan-sweep-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('case (a): resolves a pending decision that has NO orders row at all as never-submitted', async () => {
    // e.g. getPositions or recordPendingOrder itself threw before any orders row
    // was created. Nothing was ever sent to Kalshi, so this is not a position.
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending', reason: '10 contracts, 3c edge' }));

    reconcileOrphanedPendingDecisions(db);

    const row = db.prepare('SELECT would_trade, contracts, notional_cents, order_status, reason FROM decisions WHERE id = ?').get(decisionId) as {
      would_trade: number; contracts: number; notional_cents: number; order_status: string; reason: string;
    };
    expect(row.would_trade).toBe(0);
    expect(row.contracts).toBe(0);
    expect(row.notional_cents).toBe(0);
    expect(row.order_status).toBe('resolved');
    expect(row.reason).toMatch(/order never submitted/);
    expect(row.reason).toMatch(/10 contracts, 3c edge/); // the original reason is preserved
  });

  it('case (b): resolves a pending decision whose orders row already reached a terminal status, using that row\'s real fill', async () => {
    // The exact state C2's non-atomic writes could leave behind: resolveOrder
    // committed a real fill, resolveDecision never did. findPendingOrders can never
    // see this row again, so without this sweep a REAL filled position is reported
    // as would_trade=0 / zero exposure forever.
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    const orderId = recordPendingOrder(db, {
      decisionId, clientOrderId: 'cid-orphan', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'no',
      requestedContracts: 40, positionBeforeContracts: 0,
    });
    resolveOrder(db, orderId, {
      filledContracts: 40, avgFillPriceCents: 12, status: 'filled',
      kalshiOrderId: 'kalshi-orphan', kalshiOrderStatus: 'executed', errorDetail: null,
    });

    reconcileOrphanedPendingDecisions(db);

    const row = db.prepare('SELECT would_trade, contracts, entry_price_cents, notional_cents, order_status, reason FROM decisions WHERE id = ?').get(decisionId) as {
      would_trade: number; contracts: number; entry_price_cents: number; notional_cents: number; order_status: string; reason: string;
    };
    expect(row.would_trade).toBe(1);
    expect(row.contracts).toBe(40);
    expect(row.entry_price_cents).toBe(12);
    expect(row.notional_cents).toBe(480);
    expect(row.order_status).toBe('resolved');
    expect(row.reason).toMatch(/already-terminal order row \(filled\)/);
  });

  it('never resurrects a DRY_RUN simulation as a real position, even when its orders row is orphaned pending', async () => {
    // placeOrder's DRY_RUN branch writes a real-looking terminal orders row for
    // audit (status='filled', a real filled_contracts count) marked only by the
    // DRYRUN- kalshi_order_id prefix. Without this guard, case (b) above would
    // treat that simulated row as a genuine fill and resolve the decision to
    // would_trade=1 -- exactly the phantom exposure I5's fix exists to prevent,
    // just reached via orphaned/legacy data instead of the live path.
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending', reason: '2 contracts, 29c edge' }));
    const orderId = recordPendingOrder(db, {
      decisionId, clientOrderId: 'cid-dryrun-orphan', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'no',
      requestedContracts: 2, positionBeforeContracts: 0,
    });
    resolveOrder(db, orderId, {
      filledContracts: 2, avgFillPriceCents: 42, status: 'filled',
      kalshiOrderId: 'DRYRUN-cid-dryrun-orphan', kalshiOrderStatus: null, errorDetail: null,
    });

    reconcileOrphanedPendingDecisions(db);

    const row = db.prepare('SELECT would_trade, contracts, notional_cents, order_status, reason FROM decisions WHERE id = ?').get(decisionId) as {
      would_trade: number; contracts: number; notional_cents: number; order_status: string; reason: string;
    };
    expect(row.would_trade).toBe(0);
    expect(row.contracts).toBe(0);
    expect(row.notional_cents).toBe(0);
    expect(row.order_status).toBe('resolved');
    expect(row.reason).toMatch(/DRY_RUN simulation/);
    expect(totalExposureCents(db, 'KXAPRPOTUS-26AUG28')).toBe(0);
  });

  it('leaves a decision whose orders row is still genuinely pending alone -- that is reconcilePendingOrders\' job, not this sweep\'s', async () => {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    recordPendingOrder(db, {
      decisionId, clientOrderId: 'cid-live', marketTicker: 'T', side: 'yes',
      requestedContracts: 10, positionBeforeContracts: 0,
    });

    reconcileOrphanedPendingDecisions(db);

    const row = db.prepare('SELECT order_status FROM decisions WHERE id = ?').get(decisionId) as { order_status: string };
    expect(row.order_status).toBe('pending');
  });

  it('runs as part of reconcilePendingOrders, so main.ts\'s single startup call covers both orphan shapes', async () => {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));

    await reconcilePendingOrders(db, mockClient());

    const row = db.prepare('SELECT order_status, reason FROM decisions WHERE id = ?').get(decisionId) as {
      order_status: string; reason: string;
    };
    expect(row.order_status).toBe('resolved');
    expect(row.reason).toMatch(/order never submitted/);
  });
});
