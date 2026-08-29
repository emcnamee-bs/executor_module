// test/execute/reconcileOpenPositions.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { reconcileOpenPositions, startReconciliationTimer } from '../../src/execute/reconcileOpenPositions.js';
import {
  openLedger, recordPendingDecision, resolveDecision, isMarketBlocked, findOpenUnsettledDecisions,
  recordPendingOrder, resolveOrder, isTradingHalted, clearAllTrips,
  type DecisionRecord,
} from '../../src/decide/ledger.js';
import type { KalshiClient } from '../../src/execute/kalshiClient.js';
import type { MarketStatus } from '../../src/decide/kalshi.js';

let itemSeq = 0;
/**
 * notionalCents is ALWAYS derived from the final contracts/entryPriceCents, computed
 * after merging overrides -- never a fixed default. Several tests below override
 * `contracts` alone (e.g. `{ contracts: 40 }`); a fixed notionalCents default would
 * violate the ledger's own notional-consistency invariant and throw, for a reason
 * unrelated to what the test is actually checking.
 */
function openTradeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  const base = {
    itemId: `item-${++itemSeq}`, storyKey: 'story-1', eventTicker: 'KXAPRPOTUS-26AUG28',
    marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'yes' as const, rung: 'reported' as const,
    direction: 'up' as const, magnitudePts: 0.3, contracts: 10, entryPriceCents: 12, edgeCents: 3,
    wouldTrade: true, reason: '10 contracts, 3c edge', orderStatus: 'resolved' as const,
  };
  const merged = { ...base, ...overrides };
  return { ...merged, notionalCents: merged.contracts * (merged.entryPriceCents ?? 0) };
}

function recordOpenDecision(db: Database.Database, overrides: Partial<DecisionRecord> = {}): number {
  const record = openTradeRecord(overrides);
  const id = recordPendingDecision(db, { ...record, orderStatus: 'pending' });
  resolveDecision(db, id, record);
  return id;
}

function mockClient(positions: Record<string, number>): KalshiClient {
  return {
    getPositions: async () => ({
      market_positions: Object.entries(positions).map(([ticker, position]) => ({ ticker, position })),
    }),
  } as unknown as KalshiClient;
}

function mockFetchMarketStatus(statuses: Record<string, MarketStatus>): typeof import('../../src/decide/kalshi.js').fetchMarketStatus {
  return async (ticker: string) => statuses[ticker] ?? { status: 'active', result: '' };
}

describe('reconcileOpenPositions', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'reconcile-open-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks a genuinely finalized market settled, and does not check its position at all', async () => {
    const id = recordOpenDecision(db);
    let getPositionsCalls = 0;
    const realClient = { getPositions: async () => { getPositionsCalls += 1; return { market_positions: [] }; } } as unknown as KalshiClient;

    await reconcileOpenPositions({
      db, client: realClient,
      fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'finalized', result: 'no' } }),
    });

    expect(findOpenUnsettledDecisions(db)).toHaveLength(0);
    const row = db.prepare('SELECT settled_at FROM decisions WHERE id = ?').get(id) as { settled_at: string | null };
    expect(row.settled_at).not.toBeNull();
    // getPositions IS still called once (the pass fetches it before the per-row loop
    // regardless of how many rows turn out to be finalized) -- what must NOT happen
    // is a real divergence check running against a finalized market's position.
    expect(getPositionsCalls).toBe(1);
    expect(isMarketBlocked(db, 'KXAPRPOTUS-26AUG28-40.6')).toBe(false);
  });

  it('a closed-but-not-finalized market is still checked normally (does not get marked settled)', async () => {
    recordOpenDecision(db);
    const client = mockClient({ 'KXAPRPOTUS-26AUG28-40.6': 10 }); // matches expected -- no divergence

    await reconcileOpenPositions({
      db, client,
      fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'closed', result: '' } }),
    });

    expect(findOpenUnsettledDecisions(db)).toHaveLength(1); // still open, still tracked
    expect(isMarketBlocked(db, 'KXAPRPOTUS-26AUG28-40.6')).toBe(false);
  });

  it('detects a genuine YES-side divergence and blocks only that market_ticker', async () => {
    recordOpenDecision(db, { marketTicker: 'A', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'B', side: 'yes', contracts: 5 }); // unrelated, unaffected
    const client = mockClient({ A: 0, B: 5 }); // A real position vanished; B matches

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'A')).toBe(true);
    expect(isMarketBlocked(db, 'B')).toBe(false);
    const row = db.prepare('SELECT reason, expected_contracts, real_contracts FROM market_blocks WHERE market_ticker = ?').get('A') as {
      reason: string; expected_contracts: number; real_contracts: number;
    };
    expect(row.expected_contracts).toBe(10);
    expect(row.real_contracts).toBe(0);
  });

  it('detects a genuine NO-side divergence using the signed expected count (negative), not an unsigned magnitude', async () => {
    recordOpenDecision(db, { marketTicker: 'C', side: 'no', contracts: 40 });
    // Real position is +5 (a YES holding somehow), but a NO position of -40 was
    // expected -- proves the comparison is signed, not Math.abs-equivalent.
    const client = mockClient({ C: 5 });

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'C')).toBe(true);
    const row = db.prepare('SELECT expected_contracts, real_contracts FROM market_blocks WHERE market_ticker = ?').get('C') as {
      expected_contracts: number; real_contracts: number;
    };
    expect(row.expected_contracts).toBe(-40);
    expect(row.real_contracts).toBe(5);
  });

  it('a matching NO-side position (negative, correct magnitude) is not a divergence', async () => {
    recordOpenDecision(db, { marketTicker: 'D', side: 'no', contracts: 40 });
    const client = mockClient({ D: -40 });

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'D')).toBe(false);
  });

  it('defers the whole pass to the next tick (no partial state written) if getPositions itself fails', async () => {
    recordOpenDecision(db, { marketTicker: 'E' });
    const client = { getPositions: async () => { throw new Error('Kalshi 500'); } } as unknown as KalshiClient;

    await expect(reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) })).resolves.toBeUndefined();

    expect(isMarketBlocked(db, 'E')).toBe(false);
    expect(findOpenUnsettledDecisions(db)).toHaveLength(1); // untouched, will be retried next pass
  });

  it('isolates a per-row failure: one row failing fetchMarketStatus does not stop the others in the same pass', async () => {
    recordOpenDecision(db, { marketTicker: 'F', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'G', side: 'yes', contracts: 20 });
    const client = mockClient({ F: 10, G: 0 }); // G is a genuine divergence
    const flaky = async (ticker: string) => {
      if (ticker === 'F') throw new Error('Kalshi 500 for F');
      return { status: 'active', result: '' };
    };

    await reconcileOpenPositions({ db, client, fetchMarketStatus: flaky });

    expect(isMarketBlocked(db, 'F')).toBe(false); // failed to check, not wrongly blocked
    expect(isMarketBlocked(db, 'G')).toBe(true); // still correctly detected
  });

  it('is a no-op with no live client calls when there are no open unsettled decisions', async () => {
    let called = false;
    const client = { getPositions: async () => { called = true; return { market_positions: [] }; } } as unknown as KalshiClient;

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(called).toBe(false);
  });

  it('calls getPositions exactly once even with multiple open rows on different tickers', async () => {
    recordOpenDecision(db, { marketTicker: 'H', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'I', side: 'yes', contracts: 5 });
    let getPositionsCalls = 0;
    const client = {
      getPositions: async () => {
        getPositionsCalls += 1;
        return { market_positions: [{ ticker: 'H', position: 10 }, { ticker: 'I', position: 5 }] };
      },
    } as unknown as KalshiClient;

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    // With only ONE row per ticker in this test, "once per pass" and "once per row"
    // would be indistinguishable -- this proves it by using two DIFFERENT tickers,
    // each contributing one row, so any "once per row" bug (2 rows -> 2 calls) would
    // be caught here just as surely as a "once per ticker-group" bug would.
    expect(getPositionsCalls).toBe(1);
    expect(isMarketBlocked(db, 'H')).toBe(false);
    expect(isMarketBlocked(db, 'I')).toBe(false);
  });

  it('sums signed expected contracts across multiple decisions sharing one market_ticker, and does not falsely block when the aggregate matches', async () => {
    recordOpenDecision(db, { marketTicker: 'J', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'J', side: 'yes', contracts: 8 });
    // Real position is the correct aggregate (10 + 8 = 18) -- comparing either row
    // individually against 18 would wrongly diverge; the aggregate must not.
    const client = mockClient({ J: 18 });

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'J')).toBe(false);
  });

  it('nets yes and no rows on ONE market_ticker into a single signed expected count, and does not block when it matches', async () => {
    // The one case that pins signed arithmetic and per-ticker aggregation at the
    // same time: 10 YES + 8 YES - 5 NO = 13. Any unsigned sum (23), any
    // per-row comparison, or any sign inversion on the NO leg blocks a market that
    // is in perfect agreement with the exchange.
    recordOpenDecision(db, { marketTicker: 'Q', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'Q', side: 'yes', contracts: 8 });
    recordOpenDecision(db, { marketTicker: 'Q', side: 'no', contracts: 5 });
    const client = mockClient({ Q: 13 });

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'Q')).toBe(false);
  });

  it('blocks once, with the correctly summed expected value, when the aggregate for a shared market_ticker genuinely diverges', async () => {
    recordOpenDecision(db, { marketTicker: 'K', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'K', side: 'yes', contracts: 8 });
    // Aggregate expected is 18, but real is 12 -- a genuine divergence not
    // attributable to either row's individual count (10 or 8).
    const client = mockClient({ K: 12 });

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'K')).toBe(true);
    const row = db.prepare('SELECT reason, expected_contracts, real_contracts FROM market_blocks WHERE market_ticker = ?').get('K') as {
      reason: string; expected_contracts: number; real_contracts: number;
    };
    expect(row.expected_contracts).toBe(18);
    expect(row.real_contracts).toBe(12);
    expect(row.reason).toContain('expected 18');
  });

  it('skips a ticker with an order still in flight, and reconciles it normally on a later pass once that order resolves', async () => {
    const decisionId = recordOpenDecision(db, { marketTicker: 'M', side: 'yes', contracts: 10 });
    const orderId = recordPendingOrder(db, {
      decisionId, clientOrderId: 'coid-in-flight', marketTicker: 'M', side: 'yes',
      requestedContracts: 10, positionBeforeContracts: 0,
    });
    // A REAL divergence by the numbers (expected 10, real 0) -- the only reason not
    // to block is the in-flight order, so this proves the skip rather than a
    // coincidentally-matching comparison.
    const client = mockClient({ M: 0 });
    const checkedTickers: string[] = [];
    const trackingFetchMarketStatus = async (ticker: string) => {
      checkedTickers.push(ticker);
      return { status: 'active', result: '' };
    };

    await reconcileOpenPositions({ db, client, fetchMarketStatus: trackingFetchMarketStatus });

    expect(isMarketBlocked(db, 'M')).toBe(false);
    expect(checkedTickers).not.toContain('M'); // not even status-checked
    expect(findOpenUnsettledDecisions(db)).toHaveLength(1); // still tracked for a later pass

    // The order resolves (however it resolved -- the pending row is gone), so the
    // next pass has nothing in flight and reconciles the ticker for real.
    resolveOrder(db, orderId, {
      filledContracts: 0, avgFillPriceCents: null, status: 'unfilled',
      kalshiOrderId: 'kalshi-in-flight', kalshiOrderStatus: 'canceled', errorDetail: null,
    });

    await reconcileOpenPositions({ db, client, fetchMarketStatus: trackingFetchMarketStatus });

    expect(checkedTickers).toContain('M');
    expect(isMarketBlocked(db, 'M')).toBe(true);
  });

  it('skips only the in-flight ticker: an unrelated diverging ticker in the same pass is still blocked', async () => {
    const decisionId = recordOpenDecision(db, { marketTicker: 'N', side: 'yes', contracts: 10 });
    recordPendingOrder(db, {
      decisionId, clientOrderId: 'coid-n', marketTicker: 'N', side: 'yes',
      requestedContracts: 10, positionBeforeContracts: 0,
    });
    recordOpenDecision(db, { marketTicker: 'O', side: 'yes', contracts: 5 });
    const client = mockClient({ N: 0, O: 0 }); // both diverge by the numbers

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'N')).toBe(false); // in flight -- deferred, not blocked
    expect(isMarketBlocked(db, 'O')).toBe(true); // genuinely diverged
  });

  it('does not settle a finalized market whose ticker still has an order in flight', async () => {
    // Settling is also a write against a ticker whose true state is mid-change --
    // the skip must cover the whole group, not just the comparison branch.
    const decisionId = recordOpenDecision(db, { marketTicker: 'P', side: 'yes', contracts: 10 });
    recordPendingOrder(db, {
      decisionId, clientOrderId: 'coid-p', marketTicker: 'P', side: 'yes',
      requestedContracts: 10, positionBeforeContracts: 0,
    });
    const client = mockClient({ P: 10 });

    await reconcileOpenPositions({
      db, client,
      fetchMarketStatus: mockFetchMarketStatus({ P: { status: 'finalized', result: 'yes' } }),
    });

    expect(findOpenUnsettledDecisions(db)).toHaveLength(1);
  });

  it('does not skip a ticker whose "pending" order has been stuck long past the legitimate in-flight window', async () => {
    const decisionId = recordOpenDecision(db, { marketTicker: 'Q', side: 'yes', contracts: 10 });
    recordPendingOrder(db, {
      decisionId, clientOrderId: 'coid-stuck', marketTicker: 'Q', side: 'yes',
      requestedContracts: 10, positionBeforeContracts: 0,
    });
    // Backdate placed_at well past STUCK_ORDER_THRESHOLD_MS (5 minutes) -- simulates an
    // order left pending across a crash/restart with no next boot yet to resolve it,
    // rather than one genuinely still in flight.
    db.prepare("UPDATE orders SET placed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes') WHERE client_order_id = 'coid-stuck'").run();
    const client = mockClient({ Q: 0 }); // a real divergence -- expected 10, real 0

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    // A stuck order must not permanently silence this ticker's safety check --
    // it is reconciled and blocked like any other diverging ticker, surfacing the
    // problem to a human instead of hiding it behind a "pending" row forever.
    expect(isMarketBlocked(db, 'Q')).toBe(true);
  });

  it('marks every decision settled when a market_ticker shared by multiple rows finalizes', async () => {
    const id1 = recordOpenDecision(db, { marketTicker: 'L', side: 'yes', contracts: 10 });
    const id2 = recordOpenDecision(db, { marketTicker: 'L', side: 'yes', contracts: 8 });
    const client = mockClient({});

    await reconcileOpenPositions({
      db, client,
      fetchMarketStatus: mockFetchMarketStatus({ L: { status: 'finalized', result: 'yes' } }),
    });

    expect(findOpenUnsettledDecisions(db)).toHaveLength(0);
    for (const id of [id1, id2]) {
      const row = db.prepare('SELECT settled_at FROM decisions WHERE id = ?').get(id) as { settled_at: string | null };
      expect(row.settled_at).not.toBeNull();
    }
    expect(isMarketBlocked(db, 'L')).toBe(false);
  });

  it('trips the divergences breaker once enough distinct tickers diverge across passes', async () => {
    recordOpenDecision(db, { marketTicker: 'DIVERGE-A', side: 'yes', contracts: 10 });
    const client = mockClient({ 'DIVERGE-A': 0 }); // real divergence

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
    expect(isTradingHalted(db)).toBe(false); // only one distinct ticker so far

    recordOpenDecision(db, { marketTicker: 'DIVERGE-B', side: 'yes', contracts: 5 });
    const client2 = mockClient({ 'DIVERGE-A': 0, 'DIVERGE-B': 0 });
    await reconcileOpenPositions({ db, client: client2, fetchMarketStatus: mockFetchMarketStatus({}) });
    expect(isTradingHalted(db)).toBe(true);
  });

  it('never trips the divergences breaker off ONE ticker that stays diverged across many passes', async () => {
    // Nothing in this system resolves a divergence, so a genuinely diverged ticker
    // stays diverged pass after pass and gets re-UPSERTed into market_blocks every
    // time. Only a genuinely NEW block is a divergence event -- one market's
    // ongoing problem must never accumulate into a systemic signal on its own.
    recordOpenDecision(db, { marketTicker: 'STUCK-DIVERGED', side: 'yes', contracts: 10 });
    const client = mockClient({ 'STUCK-DIVERGED': 0 }); // diverged, and stays diverged

    for (let pass = 1; pass <= 3; pass += 1) {
      await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
      expect(isMarketBlocked(db, 'STUCK-DIVERGED')).toBe(true);
      expect(isTradingHalted(db)).toBe(false);
    }
  });

  it('stays clearable: re-blocking already-blocked tickers after an operator clears the breaker does not immediately re-trip it', async () => {
    // The operational consequence of counting re-blocks: blockMarket's UPSERT
    // refreshes blocked_at, so two permanently-diverged tickers would keep the
    // 60-minute count at 2 forever and re-trip the breaker within one pass of every
    // `npm run clear-breaker` -- an un-clearable halt with no operator way back to
    // trading short of editing the database by hand.
    recordOpenDecision(db, { marketTicker: 'PERSIST-A', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'PERSIST-B', side: 'yes', contracts: 5 });
    const client = mockClient({ 'PERSIST-A': 0, 'PERSIST-B': 0 });

    // Both diverge for the first time -> two NEW blocks -> the breaker trips.
    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
    expect(isTradingHalted(db)).toBe(true);

    // An operator investigates and clears the halt (the real clear-breaker path).
    expect(clearAllTrips(db)).toBe(1);
    expect(isTradingHalted(db)).toBe(false);

    // Both markets are still diverged and get re-blocked on the next two passes --
    // but neither is a NEW block, so the breaker stays clear.
    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
    expect(isTradingHalted(db)).toBe(false);
    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
    expect(isTradingHalted(db)).toBe(false);

    // Both blocks are still in force, though -- clearing the breaker does not
    // unblock the markets, and placeOrder still declines on them.
    expect(isMarketBlocked(db, 'PERSIST-A')).toBe(true);
    expect(isMarketBlocked(db, 'PERSIST-B')).toBe(true);
  });

  it('still counts a ticker blocked again AFTER an operator cleared its market block', async () => {
    // The guard keys off "is this ticker CURRENTLY blocked", not "has it ever been
    // blocked": a market a human deliberately un-blocked, that then diverges again,
    // is a genuinely new divergence event and must still count toward the signal.
    recordOpenDecision(db, { marketTicker: 'RECUR-A', side: 'yes', contracts: 10 });
    recordOpenDecision(db, { marketTicker: 'RECUR-B', side: 'yes', contracts: 5 });
    const client = mockClient({ 'RECUR-A': 0, 'RECUR-B': 0 });

    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
    expect(isTradingHalted(db)).toBe(true);

    // Operator investigates, clears the halt, and un-blocks RECUR-A specifically
    // (the real clear-market-block path's effect on the ledger).
    clearAllTrips(db);
    db.prepare("UPDATE market_blocks SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE market_ticker = 'RECUR-A'").run();
    expect(isMarketBlocked(db, 'RECUR-A')).toBe(false);
    expect(isTradingHalted(db)).toBe(false);

    // RECUR-A diverges again -- a NEW block, not a re-block of a live one -- so the
    // signal is evaluated and (with RECUR-B still recently blocked) trips again.
    await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });

    expect(isMarketBlocked(db, 'RECUR-A')).toBe(true);
    expect(isTradingHalted(db)).toBe(true);
  });
});

describe('startReconciliationTimer', () => {
  const INTERVAL_MS = 10 * 60 * 1000;
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(tmpdir(), 'reconcile-timer-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A client whose getPositions hangs until the test releases it -- the seam that
   * makes "a pass slower than the interval" reproducible without any real waiting.
   * getPositions is called once per pass, so its call count IS the pass count.
   */
  function controllableClient(): {
    client: KalshiClient;
    calls: () => number;
    releasePending: () => void;
  } {
    let calls = 0;
    let release: (() => void) | null = null;
    const client = {
      getPositions: async () => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return { market_positions: [{ ticker: 'T1', position: 10 }] };
      },
    } as unknown as KalshiClient;
    return {
      client,
      calls: () => calls,
      releasePending: () => { release?.(); release = null; },
    };
  }

  it('skips (never queues) a tick that fires while the previous pass is still running, resumes after it finishes, and stops on stop()', async () => {
    recordOpenDecision(db, { marketTicker: 'T1', side: 'yes', contracts: 10 });
    const { client, calls, releasePending } = controllableClient();

    const handle = startReconciliationTimer(
      { db, client, fetchMarketStatus: mockFetchMarketStatus({}) },
      INTERVAL_MS
    );

    // First tick: one pass starts and hangs inside getPositions.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls()).toBe(1);

    // Two more full intervals pass while that first pass is still in flight. If the
    // guard queued instead of skipping, these would run (now or on release).
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(calls()).toBe(1);

    // The slow pass completes. Nothing was queued behind it...
    releasePending();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);

    // ...but the NEXT tick runs normally, so the guard released rather than latched.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls()).toBe(2);
    releasePending();
    await vi.advanceTimersByTimeAsync(0);

    handle.stop();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(calls()).toBe(2);
  });

  it('keeps ticking after a pass rejects, rather than latching the guard forever', async () => {
    // The guard is cleared in a .finally(); a pass that throws must not wedge it.
    recordOpenDecision(db, { marketTicker: 'T2', side: 'yes', contracts: 10 });
    let calls = 0;
    const client = {
      getPositions: async () => {
        calls += 1;
        throw new Error('Kalshi 500');
      },
    } as unknown as KalshiClient;

    const handle = startReconciliationTimer(
      { db, client, fetchMarketStatus: mockFetchMarketStatus({}) },
      INTERVAL_MS
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(calls).toBe(2);

    handle.stop();
  });

  it('does not run a pass before the first interval elapses', async () => {
    recordOpenDecision(db, { marketTicker: 'T3', side: 'yes', contracts: 10 });
    const { client, calls } = controllableClient();

    const handle = startReconciliationTimer(
      { db, client, fetchMarketStatus: mockFetchMarketStatus({}) },
      INTERVAL_MS
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
    expect(calls()).toBe(0);

    handle.stop();
  });
});
