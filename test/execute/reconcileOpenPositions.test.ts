// test/execute/reconcileOpenPositions.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { reconcileOpenPositions } from '../../src/execute/reconcileOpenPositions.js';
import {
  openLedger, recordPendingDecision, resolveDecision, isMarketBlocked, findOpenUnsettledDecisions,
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
    const client = mockClient({});
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
});
