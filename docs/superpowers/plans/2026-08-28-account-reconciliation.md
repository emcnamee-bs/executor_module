# Account Reconciliation (Slice 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Periodically compare the ledger's believed open positions against Kalshi's real account state, and block further trading on any specific market where they disagree — closing the gap slice 4 left (crash recovery only, never ongoing drift detection).

**Architecture:** A 10-minute background timer in `main.ts`, independent of item processing, calls a new `reconcileOpenPositions` pass: for every not-yet-settled would-trade decision, check the market's real status (settled markets get marked and permanently excluded); for everything still open, compare Kalshi's real signed position against the expected count, and block that one `market_ticker` on a mismatch. `placeOrder` gains a redundant pre-flight check against that block list.

**Tech Stack:** Node.js ≥20, TypeScript (strict, ESM, NodeNext), vitest, `better-sqlite3`, native `fetch` (no new npm dependencies).

**Spec:** `docs/superpowers/specs/2026-08-28-account-reconciliation-design.md`

## Global Constraints

- **Cadence: every 10 minutes**, independent of item processing, with an in-memory guard so a slow pass never overlaps with the next timer tick (skip, don't queue).
- **Comparison scope: per-market signed position counts only** — no account-balance reconciliation in this slice.
- **Settlement vocabulary, confirmed live against the real API (not assumed):** a genuinely resolved market's `status` field is literally `"finalized"` (not `"settled"` — that string is only the *query-parameter* spelling for filtering a market list, never the field value). `result` is `"yes"` or `"no"` on a finalized market, `""` otherwise. A market can remain `status: "closed"` indefinitely without ever finalizing (observed live on a real market with zero open interest) — this needs no special handling; a stuck row is simply rechecked every pass, forever, which is safe.
- **Divergence response: block by `market_ticker` only**, never a global or per-story halt. This system is entry-only, so the only lever is preventing a *new* order from compounding an already-detected problem on that one market.
- **A block never auto-clears.** Only a human, via the new manual `scripts/clear-market-block.ts`, can clear one — matching the existing manual-kill-switch philosophy.
- **No new authentication surface.** Market-status checks are public/unauthenticated (`src/decide/kalshi.ts`, same file as the existing `fetchActiveLadder`); position checks reuse the existing signed `KalshiClient`. No task in this plan places, closes, or modifies any order.
- **No automated test calls the real Kalshi API for anything this plan adds** — market-status checks are mocked in all tests except the one real-API test proving the live response shape (matching `fetchActiveLadder`'s own precedent in `test/decide/kalshi.test.ts`).
- **`DecisionRecord`, `PendingOrderInput`, `PlaceOrderInput`, `PlaceOrderResult`, `signedFillDelta`, `positionForTicker`, `KalshiClient`, `BandMarket`, `ActiveLadder`** and every other slice 1–4 type are unchanged by this plan except where a task explicitly says otherwise (`decisions` gains one column; `placeOrder` gains one new decline branch).

---

### Task 1: Public market-status check

**Files:**
- Modify: `src/decide/kalshi.ts`
- Test: `test/decide/kalshi.test.ts`

**Interfaces:**
- Consumes: nothing new (native `fetch`, same as `fetchActiveLadder`).
- Produces (consumed by Task 3):
  ```typescript
  export interface MarketStatus {
    status: string;
    result: string;
  }

  export async function fetchMarketStatus(ticker: string): Promise<MarketStatus>;
  ```

This is a single-market, public, unauthenticated fetch (`GET /markets/{ticker}`) —
confirmed live during this plan's own brainstorm (not assumed): the response wraps a
`market` object with (among many other fields this task does not need) `status` and
`result`. Two real, verified cases: a finalized market returns `status: "finalized"`,
`result: "yes"` or `"no"`; a market that closed but never finalized (real observed
case: zero open interest, over a year past its strike date) returns
`status: "closed"`, `result: ""`.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to test/decide/kalshi.test.ts

import { fetchMarketStatus } from '../../src/decide/kalshi.js';

describe('fetchMarketStatus (real Kalshi API)', () => {
  it('returns "finalized" with a yes/no result for a market that has actually resolved', async () => {
    // KXAPRPOTUS-26AUG28-39.8 finalized with result "yes" -- a real, confirmed
    // historical market from this project's own live API research. If Kalshi ever
    // purges old market data such that this ticker 404s, replace it with any current
    // event's finalized band (query
    // `/markets?series_ticker=KXAPRPOTUS&status=settled` for a fresh one).
    const status = await fetchMarketStatus('KXAPRPOTUS-26AUG28-39.8');
    expect(status.status).toBe('finalized');
    expect(['yes', 'no']).toContain(status.result);
  }, 15000);

  it('returns "closed" with an empty result for a market that closed but never finalized', async () => {
    // A real market over a year past its strike date with zero open interest --
    // confirmed live to still be stuck at status "closed", result "". Proves this
    // function reads the raw field verbatim rather than assuming "closed" implies
    // resolved.
    const status = await fetchMarketStatus('KXAPRPOTUS-25JAN31-40.0');
    expect(status.status).toBe('closed');
    expect(status.result).toBe('');
  }, 15000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/kalshi.test.ts`
Expected: FAIL — `fetchMarketStatus is not a function`.

- [ ] **Step 3: Write the implementation**

Add to `src/decide/kalshi.ts`:

```typescript
export interface MarketStatus {
  status: string;
  result: string;
}

interface KalshiSingleMarketResponse {
  market: {
    status: string;
    result: string;
  };
}

export async function fetchMarketStatus(ticker: string): Promise<MarketStatus> {
  const url = `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Kalshi market status fetch failed for ${ticker}: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as KalshiSingleMarketResponse;
  return { status: body.market.status, result: body.market.result };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/kalshi.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`

```bash
git add src/decide/kalshi.ts test/decide/kalshi.test.ts
git commit -m "feat: add public market-status check (finalized vs. closed-but-unresolved)"
```

---

### Task 2: Ledger schema — settlement tracking and market blocks

**Files:**
- Modify: `src/decide/ledger.ts`
- Test: `test/decide/ledger.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `ledger.ts` additively (every slice
  1–4 function and schema element is unchanged).
- Produces (consumed by Task 3 and Task 4):
  ```typescript
  export function markDecisionSettled(db: Database.Database, decisionId: number): void;

  export interface OpenUnsettledDecision {
    id: number;
    marketTicker: string;
    side: 'yes' | 'no';
    contracts: number;
  }
  export function findOpenUnsettledDecisions(db: Database.Database): OpenUnsettledDecision[];

  export function isMarketBlocked(db: Database.Database, marketTicker: string): boolean;
  export function blockMarket(
    db: Database.Database,
    marketTicker: string,
    reason: string,
    expectedContracts: number,
    realContracts: number
  ): void;
  ```

`decisions` gains `settled_at TEXT NULL` — a would-trade row starts with it `NULL`
and it is set exactly once, by `markDecisionSettled`, when Task 3 confirms the
market finalized. `findOpenUnsettledDecisions` only ever returns rows where
`would_trade = 1 AND settled_at IS NULL` — real would-trade rows always carry a
non-null `market_ticker`/`side` (every code path that sets `wouldTrade: true`
already requires both, per the existing `assertNotionalIsConsistent` invariant), so
this function casts them non-null rather than re-deriving nullability slice 1–4
already established.

`market_blocks` is a new, small table keyed by `market_ticker`. `blockMarket` is an
UPSERT: blocking an already-blocked ticker updates its reason/counts and
`blocked_at`; blocking a previously-cleared ticker re-activates the block
(`cleared_at` reset to `NULL`) rather than silently no-op-ing, since a market can
legitimately diverge again after a human clears an earlier block.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to test/decide/ledger.test.ts

import {
  markDecisionSettled,
  findOpenUnsettledDecisions,
  isMarketBlocked,
  blockMarket,
} from '../../src/decide/ledger.js';

describe('settlement tracking', () => {
  it('findOpenUnsettledDecisions returns only would_trade=1 rows with settled_at still null', () => {
    const openId = (() => {
      const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));
      return id;
    })();
    recordDecision(db, skipRecord()); // a skip -- would_trade=0, must not appear

    const open = findOpenUnsettledDecisions(db);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      id: openId,
      marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
      side: 'yes',
      contracts: 10,
    });
  });

  it('markDecisionSettled removes a row from findOpenUnsettledDecisions afterward', () => {
    const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));
    expect(findOpenUnsettledDecisions(db)).toHaveLength(1);

    markDecisionSettled(db, id);

    expect(findOpenUnsettledDecisions(db)).toHaveLength(0);
    const row = db.prepare('SELECT settled_at FROM decisions WHERE id = ?').get(id) as { settled_at: string | null };
    expect(row.settled_at).not.toBeNull();
  });
});

describe('market_blocks', () => {
  it('isMarketBlocked is false for a market never blocked', () => {
    expect(isMarketBlocked(db, 'KXAPRPOTUS-26AUG28-40.6')).toBe(false);
  });

  it('blockMarket makes isMarketBlocked true, recording the reason and counts', () => {
    blockMarket(db, 'KXAPRPOTUS-26AUG28-40.6', 'reconciliation divergence: expected 10, real 0', 10, 0);

    expect(isMarketBlocked(db, 'KXAPRPOTUS-26AUG28-40.6')).toBe(true);
    const row = db.prepare('SELECT reason, expected_contracts, real_contracts, cleared_at FROM market_blocks WHERE market_ticker = ?')
      .get('KXAPRPOTUS-26AUG28-40.6') as { reason: string; expected_contracts: number; real_contracts: number; cleared_at: string | null };
    expect(row.reason).toMatch(/expected 10, real 0/);
    expect(row.expected_contracts).toBe(10);
    expect(row.real_contracts).toBe(0);
    expect(row.cleared_at).toBeNull();
  });

  it('a cleared block reports isMarketBlocked as false, but blocking the same ticker again reactivates it', () => {
    blockMarket(db, 'T', 'first divergence', 5, 0);
    db.prepare(`UPDATE market_blocks SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE market_ticker = 'T'`).run();
    expect(isMarketBlocked(db, 'T')).toBe(false);

    blockMarket(db, 'T', 'second divergence', 8, 2);

    expect(isMarketBlocked(db, 'T')).toBe(true);
    const row = db.prepare('SELECT reason, cleared_at FROM market_blocks WHERE market_ticker = ?').get('T') as {
      reason: string; cleared_at: string | null;
    };
    expect(row.reason).toBe('second divergence');
    expect(row.cleared_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/ledger.test.ts`
Expected: FAIL — the new functions don't exist yet.

- [ ] **Step 3: Extend the schema and add the new functions**

In `src/decide/ledger.ts`, add `settled_at TEXT` to the `decisions` `CREATE TABLE`
statement (any position in the column list; add it right after `resolved_at`-style
trailing columns, before the closing constraints, to match this file's existing
style of grouping plain columns before `CHECK`/derived clauses):

```sql
  order_status TEXT NOT NULL DEFAULT 'resolved' CHECK (order_status IN ('pending','resolved')),
  settled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
```

Add a new table to `SCHEMA`, after the existing `orders` table:

```sql
CREATE TABLE IF NOT EXISTS market_blocks (
  market_ticker TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  expected_contracts INTEGER NOT NULL,
  real_contracts INTEGER NOT NULL,
  blocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cleared_at TEXT
);
```

Add the new functions (place them near the end of the file, after `findPendingOrders`):

```typescript
export function markDecisionSettled(db: Database.Database, decisionId: number): void {
  db.prepare(`UPDATE decisions SET settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(decisionId);
}

export interface OpenUnsettledDecision {
  id: number;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
}

/**
 * Every would-trade position the ledger still believes is open and not yet
 * confirmed finalized by Kalshi -- the working set Task 3's periodic reconciliation
 * pass checks each tick. market_ticker/side are cast non-null: every code path that
 * sets would_trade=true already requires both (the same invariant
 * assertNotionalIsConsistent enforces for entry_price_cents/event_ticker).
 */
export function findOpenUnsettledDecisions(db: Database.Database): OpenUnsettledDecision[] {
  const rows = db
    .prepare(
      `SELECT id, market_ticker AS marketTicker, side, contracts
       FROM decisions WHERE would_trade = 1 AND settled_at IS NULL`
    )
    .all();
  return rows as OpenUnsettledDecision[];
}

export function isMarketBlocked(db: Database.Database, marketTicker: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM market_blocks WHERE market_ticker = ? AND cleared_at IS NULL`)
    .get(marketTicker);
  return row !== undefined;
}

/**
 * Blocks a market_ticker from further NEW order placement (checked by placeOrder).
 * An UPSERT: blocking an already-active block updates its reason/counts; blocking a
 * PREVIOUSLY-CLEARED ticker reactivates it (cleared_at reset to NULL) rather than
 * silently no-op-ing -- a market can legitimately diverge again after a human clears
 * an earlier block.
 */
export function blockMarket(
  db: Database.Database,
  marketTicker: string,
  reason: string,
  expectedContracts: number,
  realContracts: number
): void {
  db.prepare(
    `INSERT INTO market_blocks (market_ticker, reason, expected_contracts, real_contracts)
     VALUES (@marketTicker, @reason, @expectedContracts, @realContracts)
     ON CONFLICT(market_ticker) DO UPDATE SET
       reason = @reason, expected_contracts = @expectedContracts, real_contracts = @realContracts,
       blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cleared_at = NULL`
  ).run({ marketTicker, reason, expectedContracts, realContracts });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/ledger.test.ts`
Expected: all PASS, including every pre-existing slice 1–4 ledger test (unaffected
by this additive schema change).

- [ ] **Step 5: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`

```bash
git add src/decide/ledger.ts test/decide/ledger.test.ts
git commit -m "feat: add settlement tracking and market-block ledger schema"
```

---

### Task 3: The reconciliation pass

**Files:**
- Create: `src/execute/reconcileOpenPositions.ts`
- Test: `test/execute/reconcileOpenPositions.test.ts`

**Interfaces:**
- Consumes: `findOpenUnsettledDecisions`, `markDecisionSettled`, `blockMarket`
  (Task 2); `fetchMarketStatus` (Task 1); `positionForTicker`, `KalshiClient`
  (existing, slice 4).
- Produces (consumed by Task 5):
  ```typescript
  export interface ReconcileOpenPositionsDeps {
    db: Database.Database;
    client: KalshiClient;
    /** Injectable for tests; defaults to the real src/decide/kalshi.ts function. */
    fetchMarketStatus?: typeof fetchMarketStatus;
  }

  export async function reconcileOpenPositions(deps: ReconcileOpenPositionsDeps): Promise<void>;
  ```

This is a NEW file, separate from `src/execute/order.ts`, since it's a genuinely
distinct concern (ongoing drift detection against real account state, vs. order
placement and crash-recovery reconciliation of pending orders) — `order.ts` is
already large with three responsibilities of its own; this keeps each file to one
clear job.

`getPositions()` is called exactly ONCE per pass (not once per open row) — every
open row's real position is looked up from that single snapshot, both to avoid
redundant API calls and so every row in one pass is compared against the same
instant, not a slightly different one per row. If that one call fails, the whole
pass is deferred to the next tick (no partial state written) rather than retried
inline — this pass already runs again in 10 minutes.

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: FAIL — `Cannot find module '../../src/execute/reconcileOpenPositions.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/execute/reconcileOpenPositions.ts
import type Database from 'better-sqlite3';
import type { KalshiClient } from './kalshiClient.js';
import { positionForTicker } from './kalshiClient.js';
import { fetchMarketStatus as realFetchMarketStatus } from '../decide/kalshi.js';
import { findOpenUnsettledDecisions, markDecisionSettled, blockMarket } from '../decide/ledger.js';

export interface ReconcileOpenPositionsDeps {
  db: Database.Database;
  client: KalshiClient;
  /** Injectable for tests; defaults to the real public market-status check. */
  fetchMarketStatus?: typeof realFetchMarketStatus;
}

/**
 * Periodic drift check between the ledger's believed open positions and Kalshi's
 * real account state (called every 10 minutes from main.ts, independent of item
 * processing -- see Task 5). A market that has genuinely finalized (result "yes" or
 * "no") is marked settled and never checked again; a market merely "closed" (Kalshi
 * can leave a market in this state indefinitely without ever finalizing it) is
 * still checked normally, since its position is still real and unpaid.
 *
 * getPositions() is called ONCE per pass, not once per row: avoids redundant API
 * calls, and keeps every row in the same pass compared against the same instant. If
 * that one call fails, the whole pass defers to the next tick rather than writing
 * any partial state -- there is no cost to waiting 10 more minutes.
 */
export async function reconcileOpenPositions(deps: ReconcileOpenPositionsDeps): Promise<void> {
  const { db, client } = deps;
  const fetchMarketStatus = deps.fetchMarketStatus ?? realFetchMarketStatus;

  const openRows = findOpenUnsettledDecisions(db);
  if (openRows.length === 0) return;

  let positionsResp;
  try {
    positionsResp = await client.getPositions();
  } catch (err) {
    console.error('[reconcile-open-positions] failed to fetch positions for this pass, deferring to the next tick:', err);
    return;
  }

  for (const row of openRows) {
    try {
      const marketStatus = await fetchMarketStatus(row.marketTicker);
      if (marketStatus.status === 'finalized') {
        markDecisionSettled(db, row.id);
        continue;
      }

      const real = positionForTicker(positionsResp, row.marketTicker);
      const expected = row.side === 'yes' ? row.contracts : -row.contracts;
      if (real !== expected) {
        const reason = `reconciliation divergence: expected ${expected}, real ${real}`;
        blockMarket(db, row.marketTicker, reason, expected, real);
        console.error(
          `[RECONCILE-DIVERGENCE] market_ticker=${row.marketTicker} decisionId=${row.id} ${reason}`
        );
      }
    } catch (err) {
      console.error(
        `[reconcile-open-positions] failed to reconcile decisionId=${row.id} marketTicker=${row.marketTicker}, will retry next pass:`,
        err
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`

```bash
git add src/execute/reconcileOpenPositions.ts test/execute/reconcileOpenPositions.test.ts
git commit -m "feat: add periodic reconciliation of open positions against Kalshi's real state"
```

---

### Task 4: `placeOrder` honors a market block

**Files:**
- Modify: `src/execute/order.ts`
- Modify: `test/execute/order.test.ts`

**Interfaces:**
- Consumes: `isMarketBlocked` (Task 2).
- Produces: no new exports — `placeOrder`'s existing signature and `PlaceOrderResult`
  shape are unchanged; this task only adds one new early-return branch.

Read the current `src/execute/order.ts` in full before editing (it already has the
exposure-cap recheck this new check sits alongside). The check goes immediately
after the existing exposure-cap recheck and before `buildOrderBody` is called —
before any Kalshi call of any kind, matching the exposure check's own placement.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to test/execute/order.test.ts, in the `describe('placeOrder', ...)` block

import { isMarketBlocked, blockMarket } from '../../src/decide/ledger.js';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/execute/order.test.ts`
Expected: FAIL — the block is never checked, so the first new test's `createOrderCalled`/`getPositionsCalled` assertions fail (the order goes through instead of declining).

- [ ] **Step 3: Add the check to `placeOrder`**

In `src/execute/order.ts`, add the import and the new check immediately after the
existing exposure-cap recheck (find the exact current line via reading the file
first — this goes between the exposure-cap `if` block and the `buildOrderBody` call):

```typescript
import { totalExposureCents, MAX_TOTAL_EXPOSURE_CENTS, isMarketBlocked, /* ...existing imports... */ } from '../decide/ledger.js';

// ... inside placeOrder, immediately after the existing exposure-cap recheck block:

  if (isMarketBlocked(db, input.marketTicker)) {
    return {
      clientOrderId, kalshiOrderId: null, kalshiOrderStatus: null, filledContracts: 0,
      avgFillPriceCents: null, status: 'declined-at-execution', dryRun: false,
      errorDetail: `market_ticker ${input.marketTicker} is blocked pending manual review (reconciliation divergence) -- see market_blocks`,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/execute/order.test.ts`
Expected: all PASS, including every pre-existing slice 4 `placeOrder` test.

- [ ] **Step 5: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`

```bash
git add src/execute/order.ts test/execute/order.test.ts
git commit -m "feat: decline placeOrder at execution when the market_ticker is blocked"
```

---

### Task 5: `main.ts` wiring — the periodic timer

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `reconcileOpenPositions` (Task 3).
- Produces: nothing new exported — this task only adds startup wiring.

Read the current `src/main.ts` in full before editing. Add the timer after the
existing startup `reconcilePendingOrders` call and before `runOnce` begins
consuming, alongside the existing `kalshiClient`/`db` construction.

- [ ] **Step 1: Wire the timer**

```typescript
// Additions to src/main.ts -- exact placement depends on the current file's
// structure (read it first per the instruction above); this is the logic to add.

import { reconcileOpenPositions } from './execute/reconcileOpenPositions.js';

const RECONCILE_OPEN_POSITIONS_INTERVAL_MS = 10 * 60 * 1000;

// Inside main(), after the existing startup reconcilePendingOrders call and before
// the AbortController/runOnce block:

  let reconciliationInProgress = false;
  const reconciliationTimer = setInterval(() => {
    if (reconciliationInProgress) return; // a slow pass skips the next tick, never overlaps
    reconciliationInProgress = true;
    reconcileOpenPositions({ db, client: kalshiClient })
      .catch((err) => console.error('[reconcile-open-positions] pass failed:', err))
      .finally(() => { reconciliationInProgress = false; });
  }, RECONCILE_OPEN_POSITIONS_INTERVAL_MS);

// At the end of main(), alongside the existing shutdown sequence (client.quit()/db.close()):

  clearInterval(reconciliationTimer);
```

This plan does not add a test driving `main()` end-to-end (the existing `main.test.ts`
tests `makeOnItem`/`runOnce` directly, not `main()` itself, matching the established
testing boundary from slice 4 — a live timer firing every 10 minutes isn't something
a unit test should wait out). Confirm by reading `test/main.test.ts` that this
remains true after this change; if it has grown a `main()`-level test since slice 4,
note it in your report rather than guessing how to extend it.

- [ ] **Step 2: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`
Expected: everything passes (no test exercises the new timer directly, so no new
test failures are expected from this task specifically).

```bash
git add src/main.ts
git commit -m "feat: wire a 10-minute periodic account-reconciliation timer into main.ts"
```

---

### Task 6: Manual block-clearing script

**Files:**
- Create: `scripts/clear-market-block.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `openLedger` (existing).
- Produces: nothing consumed by other code — a standalone, manually-invoked script,
  never imported or run by the automated suite. Matches `scripts/smoke.ts`'s
  existing precedent from slice 4.

- [ ] **Step 1: Write the script**

```typescript
// scripts/clear-market-block.ts
//
// Manually clears a market_blocks entry after a human has investigated and
// confirmed it's safe to resume trading that market_ticker. Not part of `npm test`
// -- invoke directly:
//   direnv exec . npx tsx scripts/clear-market-block.ts <market_ticker>

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLedger } from '../src/decide/ledger.js';

const DEFAULT_LEDGER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/decisions.db'
);

function main(): void {
  const marketTicker = process.argv[2];
  if (!marketTicker) {
    console.error('Usage: npm run clear-block -- <market_ticker>');
    process.exit(1);
  }

  const db = openLedger(DEFAULT_LEDGER_PATH);
  const result = db
    .prepare(
      `UPDATE market_blocks SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE market_ticker = ? AND cleared_at IS NULL`
    )
    .run(marketTicker);

  if (result.changes === 0) {
    console.error(`No active block found for market_ticker=${marketTicker}`);
    db.close();
    process.exit(1);
  }

  console.log(`Cleared block for market_ticker=${marketTicker}`);
  db.close();
}

main();
```

- [ ] **Step 2: Add an npm script**

In `package.json`'s `scripts`, add: `"clear-block": "tsx scripts/clear-market-block.ts"`.

- [ ] **Step 3: Run typecheck**

Run: `direnv exec . npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/clear-market-block.ts package.json
git commit -m "feat: add manual script to clear a market_blocks entry"
```

---

## Self-Review Notes

- **Spec coverage:** every Decision point (1–7) maps to a task: 1/2→Task 5, 3→Task 3,
  4→Tasks 1/3, 5→Task 2/3, 6→Tasks 2/4, 7→Tasks 2/6. The "real API research" section
  maps to Task 1's exact field values and test fixtures.
- **Placeholder scan:** none found — every step has runnable code or an exact command.
- **Type consistency:** `MarketStatus` (Task 1) is used identically in Task 3's
  `ReconcileOpenPositionsDeps.fetchMarketStatus` and its mocked-test fixtures.
  `OpenUnsettledDecision` (Task 2) matches exactly what Task 3's `reconcileOpenPositions`
  destructures (`id`, `marketTicker`, `side`, `contracts`). `isMarketBlocked`/
  `blockMarket` (Task 2) are called with the same argument order and types in both
  Task 3 (writing a block) and Task 4 (reading one) — cross-checked field by field.
  `ReconcileOpenPositionsDeps` (Task 3) matches exactly how Task 5 constructs it in
  `main.ts` (`{ db, client: kalshiClient }`, `fetchMarketStatus` omitted to use the
  real default). Unit-naming discipline (`Cents` for money, `Pts` for percentage
  points, plain `contracts`/`position` for signed counts) holds throughout — no task
  here introduces a money or points quantity, only signed contract counts, matching
  slice 4's own established convention for those.
