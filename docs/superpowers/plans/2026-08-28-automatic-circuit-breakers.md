# Automatic Circuit Breakers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three independent, automatic triggers (repeated failed/ambiguous order
outcomes, repeated reconciliation divergences, a burst of Kalshi API errors) that halt
all new order placement system-wide, on top of the existing manual kill switch and
slice 5's per-market blocking.

**Architecture:** A new `circuit_breaker_trips` events-log table plus a new
`kalshi_errors` log table in the ledger; three small "check recent history, trip if
over threshold" functions, each called immediately after the write that could trigger
it (an order resolving, a market getting blocked, a Kalshi API error being logged);
one new global halt check (`isTradingHalted`) ORed into the pipeline's existing
`EXECUTOR_TRADING_HALTED` check; a manual clear script matching the existing
`clear-market-block.ts` pattern.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, better-sqlite3, no new
dependencies.

**Spec:** `docs/superpowers/specs/2026-08-28-automatic-circuit-breakers-design.md`

## Global Constraints

- Entry-only system: nothing in this plan closes, cancels, or modifies an existing
  order. Every check only gates whether a *new* decision proceeds to `placeOrder`.
- No market-specific keyword/rule/resolution-condition logic anywhere in this plan —
  every signal operates on execution/infrastructure state (order status, block
  counts, API errors), never on market content.
- Thresholds/windows are hardcoded constants, not environment-configurable: failed
  orders 3-within-30-minutes, divergences 2-within-60-minutes, Kalshi errors
  5-within-15-minutes.
- Only `rejected`, `unknown`, and `error` count as a "failed/ambiguous order
  outcome". `unfilled`, `partial`, `pending`, `filled`, and `declined-at-execution`
  never count.
- A breaker check's own failure (a DB error inside the count-and-trip logic) must be
  caught and logged, never allowed to propagate and crash the write it's attached to.
- Recovery from a trip is manual only (a clear script) — no auto-expiry, no
  auto-clear timer.
- `EXECUTOR_TRADING_HALTED` (the existing env-var kill switch) and slice 5's
  `market_blocks` (per-`market_ticker` blocking) are both unchanged by this plan.

---

### Task 1: Ledger schema and circuit-breaker primitives

**Files:**
- Modify: `src/decide/ledger.ts`
- Test: `test/decide/ledger.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `Database.Database` type already imported
  in `ledger.ts`).
- Produces (used by every later task):
  - `export type CircuitBreakerSignal = 'failed-orders' | 'divergences' | 'kalshi-errors';`
  - `export const CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD = 3;`
  - `export const CIRCUIT_BREAKER_FAILED_ORDERS_WINDOW_MINUTES = 30;`
  - `export const CIRCUIT_BREAKER_DIVERGENCES_THRESHOLD = 2;`
  - `export const CIRCUIT_BREAKER_DIVERGENCES_WINDOW_MINUTES = 60;`
  - `export const CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD = 5;`
  - `export const CIRCUIT_BREAKER_KALSHI_ERRORS_WINDOW_MINUTES = 15;`
  - `export function isTradingHalted(db: Database.Database): boolean`
  - `export function tripBreaker(db: Database.Database, signal: CircuitBreakerSignal, reason: string): void`
  - `export function clearAllTrips(db: Database.Database): number`
  - `export function recordKalshiError(db: Database.Database, callSite: string, errorMessage: string): void`
  - `export function checkFailedOrdersSignal(db: Database.Database, status: OrderStatus): void`
  - `export function checkDivergencesSignal(db: Database.Database): void`

- [ ] **Step 1: Write the failing tests**

Add to `test/decide/ledger.test.ts` (find the existing `describe('ledger', ...)` block
and add a new nested `describe('circuit breakers', ...)` alongside the existing
`describe('settlement tracking', ...)` block — same file, same `beforeEach`/`afterEach`
setup already in that file opening a fresh temp `openLedger` per test):

```typescript
import {
  isTradingHalted, tripBreaker, clearAllTrips, recordKalshiError,
  checkFailedOrdersSignal, checkDivergencesSignal,
  CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD, CIRCUIT_BREAKER_DIVERGENCES_THRESHOLD,
  CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD,
  recordPendingDecision, recordPendingOrder, resolveOrder, blockMarket,
} from '../../src/decide/ledger.js';
// tradeRecord and nextItemId are this file's own existing local helpers (defined
// near the top of test/decide/ledger.test.ts already) -- no new import needed for
// either; reuse them exactly as every other test in this file already does.

describe('circuit breakers', () => {
  it('isTradingHalted is false with no trips', () => {
    expect(isTradingHalted(db)).toBe(false);
  });

  it('tripBreaker halts trading, and clearAllTrips un-halts it', () => {
    tripBreaker(db, 'failed-orders', 'test reason');
    expect(isTradingHalted(db)).toBe(true);
    const cleared = clearAllTrips(db);
    expect(cleared).toBe(1);
    expect(isTradingHalted(db)).toBe(false);
  });

  it('does not insert a second trip row for the same signal while it is still open', () => {
    tripBreaker(db, 'failed-orders', 'first reason');
    tripBreaker(db, 'failed-orders', 'second reason');
    const rows = db.prepare('SELECT * FROM circuit_breaker_trips').all();
    expect(rows).toHaveLength(1);
  });

  it('trips a second, distinct signal independently while the first is still open', () => {
    tripBreaker(db, 'failed-orders', 'reason A');
    tripBreaker(db, 'divergences', 'reason B');
    const rows = db.prepare('SELECT signal FROM circuit_breaker_trips ORDER BY signal').all();
    expect(rows).toEqual([{ signal: 'divergences' }, { signal: 'failed-orders' }]);
  });

  it('clearAllTrips clears every currently-open row when multiple signals are tripped, and returns 0 when none are open', () => {
    tripBreaker(db, 'failed-orders', 'reason A');
    tripBreaker(db, 'divergences', 'reason B');
    expect(clearAllTrips(db)).toBe(2);
    expect(isTradingHalted(db)).toBe(false);
    expect(clearAllTrips(db)).toBe(0);
  });

  it('recordKalshiError logs a row and trips kalshi-errors at exactly the threshold', () => {
    for (let i = 0; i < CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD - 1; i++) {
      recordKalshiError(db, 'getPositions', `error ${i}`);
    }
    expect(isTradingHalted(db)).toBe(false);
    recordKalshiError(db, 'getPositions', 'the final straw');
    expect(isTradingHalted(db)).toBe(true);
    const trip = db.prepare('SELECT signal FROM circuit_breaker_trips').get() as { signal: string };
    expect(trip.signal).toBe('kalshi-errors');
  });

  it('a kalshi_errors row outside the lookback window does not count toward the threshold', () => {
    for (let i = 0; i < CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD; i++) {
      recordKalshiError(db, 'getPositions', `error ${i}`);
    }
    clearAllTrips(db);
    // Backdate every logged row well outside the 15-minute window.
    db.prepare("UPDATE kalshi_errors SET occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')").run();
    recordKalshiError(db, 'getPositions', 'one fresh error');
    expect(isTradingHalted(db)).toBe(false);
  });

  it('checkFailedOrdersSignal trips failed-orders at exactly the threshold, counting only rejected/unknown/error', () => {
    let coidSeq = 0;
    const makeOrder = () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      return recordPendingOrder(db, {
        decisionId, clientOrderId: `coid-${++coidSeq}`, marketTicker: 'TICK', side: 'yes',
        requestedContracts: 10, positionBeforeContracts: 0,
      });
    };
    const resolveWith = (orderId: number, status: 'unfilled' | 'rejected' | 'unknown') =>
      resolveOrder(db, orderId, {
        filledContracts: 0, avgFillPriceCents: null, status,
        kalshiOrderId: null, kalshiOrderStatus: null, errorDetail: null,
      });

    // Two unfilled orders (normal outcome) never count, however many there are.
    resolveWith(makeOrder(), 'unfilled');
    checkFailedOrdersSignal(db, 'unfilled');
    resolveWith(makeOrder(), 'unfilled');
    checkFailedOrdersSignal(db, 'unfilled');
    expect(isTradingHalted(db)).toBe(false);

    // Now CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD real failures.
    for (let i = 0; i < CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD - 1; i++) {
      const id = makeOrder();
      resolveWith(id, 'rejected');
      checkFailedOrdersSignal(db, 'rejected');
    }
    expect(isTradingHalted(db)).toBe(false);
    const lastId = makeOrder();
    resolveWith(lastId, 'unknown');
    checkFailedOrdersSignal(db, 'unknown');
    expect(isTradingHalted(db)).toBe(true);
  });

  it('checkDivergencesSignal trips divergences at exactly the threshold, ignoring blocks outside the window', () => {
    blockMarket(db, 'TICKER-A', 'reason A', 10, 5);
    checkDivergencesSignal(db);
    expect(isTradingHalted(db)).toBe(false);

    blockMarket(db, 'TICKER-B', 'reason B', 8, 2);
    checkDivergencesSignal(db);
    expect(isTradingHalted(db)).toBe(true);
  });

  it('a market_blocks row outside the divergences window does not count', () => {
    blockMarket(db, 'TICKER-A', 'reason A', 10, 5);
    db.prepare("UPDATE market_blocks SET blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours') WHERE market_ticker = 'TICKER-A'").run();
    blockMarket(db, 'TICKER-B', 'reason B', 8, 2);
    checkDivergencesSignal(db);
    expect(isTradingHalted(db)).toBe(false);
  });

  it('a breaker check failure is caught and logged, never propagated', () => {
    const brokenDb = { prepare: () => { throw new Error('simulated DB failure'); } } as unknown as Database.Database;
    expect(() => checkFailedOrdersSignal(brokenDb, 'rejected')).not.toThrow();
    expect(() => checkDivergencesSignal(brokenDb)).not.toThrow();
    expect(() => recordKalshiError(brokenDb, 'getPositions', 'boom')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: FAIL — `isTradingHalted`, `tripBreaker`, etc. are not exported yet.

- [ ] **Step 3: Add the schema and implementation**

In `src/decide/ledger.ts`, add to the end of the `SCHEMA` template string (find the
closing backtick of `SCHEMA` — the `market_blocks` table is the last one defined
there today, per slice 5):

```sql
CREATE TABLE IF NOT EXISTS kalshi_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  call_site TEXT NOT NULL,
  error_message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS circuit_breaker_trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal TEXT NOT NULL CHECK (signal IN ('failed-orders','divergences','kalshi-errors')),
  reason TEXT NOT NULL,
  tripped_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cleared_at TEXT
);
```

These are brand-new tables (unlike slice 5's `settled_at` column-on-an-existing-table
case), so `CREATE TABLE IF NOT EXISTS` correctly creates them on any pre-existing
database with no migration needed.

Then add, anywhere after the `SCHEMA` constant and the existing `openLedger`/ledger
functions (a reasonable spot is right after `blockMarket`, since these two areas are
conceptually related — both are ledger-driven safety mechanisms):

```typescript
export type CircuitBreakerSignal = 'failed-orders' | 'divergences' | 'kalshi-errors';

export const CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD = 3;
export const CIRCUIT_BREAKER_FAILED_ORDERS_WINDOW_MINUTES = 30;
export const CIRCUIT_BREAKER_DIVERGENCES_THRESHOLD = 2;
export const CIRCUIT_BREAKER_DIVERGENCES_WINDOW_MINUTES = 60;
export const CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD = 5;
export const CIRCUIT_BREAKER_KALSHI_ERRORS_WINDOW_MINUTES = 15;

/**
 * True if EITHER the manual kill switch or any automatic circuit breaker is
 * currently tripped. Checked once per decision in pipeline.ts, alongside the
 * existing EXECUTOR_TRADING_HALTED env var -- this only ever gates a NEW decision
 * from proceeding to placeOrder; nothing already in flight is affected.
 */
export function isTradingHalted(db: Database.Database): boolean {
  const row = db.prepare(`SELECT 1 FROM circuit_breaker_trips WHERE cleared_at IS NULL LIMIT 1`).get();
  return row !== undefined;
}

/**
 * Trips one signal. Deliberately per-signal, not global: if 'failed-orders' is
 * already open and 'divergences' independently crosses its own threshold, both
 * must be visible as their own trip rows -- collapsing them into "something is
 * already tripped, don't bother" would hide that a second, distinct problem also
 * fired. isTradingHalted (used by callers to decide whether to halt) only cares
 * that ANY row is open; this function's own dedup is scoped to ONE signal.
 */
export function tripBreaker(db: Database.Database, signal: CircuitBreakerSignal, reason: string): void {
  const alreadyOpen = db
    .prepare(`SELECT 1 FROM circuit_breaker_trips WHERE signal = ? AND cleared_at IS NULL LIMIT 1`)
    .get(signal);
  if (alreadyOpen) return;
  db.prepare(`INSERT INTO circuit_breaker_trips (signal, reason) VALUES (?, ?)`).run(signal, reason);
  console.error(`[CIRCUIT-BREAKER-TRIPPED] signal=${signal} reason=${reason}`);
}

/**
 * Clears EVERY currently-open trip, not just one -- an operator clearing the
 * breaker is confirming the whole situation is resolved, not one signal among
 * several in isolation. Returns the number of rows cleared (0 if none were open),
 * for the manual clear script to report back to the operator.
 */
export function clearAllTrips(db: Database.Database): number {
  const info = db
    .prepare(`UPDATE circuit_breaker_trips SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cleared_at IS NULL`)
    .run();
  return info.changes;
}

/**
 * Logs one Kalshi API error (from any call site -- order placement, position/status
 * reads, market data) and immediately checks whether the kalshi-errors signal
 * should trip. Deliberately swallows its OWN failures entirely (both the insert and
 * the count-and-trip check): this is called from inside an existing catch block
 * that is about to rethrow the REAL error, and this logging is purely auxiliary
 * observability that must never interfere with that rethrow.
 */
export function recordKalshiError(db: Database.Database, callSite: string, errorMessage: string): void {
  try {
    db.prepare(`INSERT INTO kalshi_errors (call_site, error_message) VALUES (?, ?)`).run(callSite, errorMessage);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM kalshi_errors
         WHERE occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
      )
      .get(`-${CIRCUIT_BREAKER_KALSHI_ERRORS_WINDOW_MINUTES} minutes`) as { n: number };
    if (row.n >= CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD) {
      tripBreaker(
        db, 'kalshi-errors',
        `${row.n} Kalshi API errors within ${CIRCUIT_BREAKER_KALSHI_ERRORS_WINDOW_MINUTES} minutes (latest: ${callSite}: ${errorMessage})`
      );
    }
  } catch (err) {
    console.error('[recordKalshiError] failed to log/evaluate a Kalshi API error (not fatal):', err);
  }
}

/**
 * Call immediately after resolveOrder writes. Only rejected/unknown/error are real
 * anomalies -- unfilled/partial are normal IOC outcomes and declined-at-execution is
 * the system correctly refusing to trade, so none of those should ever count.
 * Failure-isolated: the resolveOrder write this follows is already committed by the
 * time this runs, so a failure here must never propagate back into the caller.
 */
export function checkFailedOrdersSignal(db: Database.Database, status: OrderStatus): void {
  if (status !== 'rejected' && status !== 'unknown' && status !== 'error') return;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM orders
         WHERE status IN ('rejected','unknown','error')
           AND resolved_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
      )
      .get(`-${CIRCUIT_BREAKER_FAILED_ORDERS_WINDOW_MINUTES} minutes`) as { n: number };
    if (row.n >= CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD) {
      tripBreaker(
        db, 'failed-orders',
        `${row.n} failed/ambiguous order outcomes within ${CIRCUIT_BREAKER_FAILED_ORDERS_WINDOW_MINUTES} minutes`
      );
    }
  } catch (err) {
    console.error('[checkFailedOrdersSignal] failed to evaluate the failed-orders signal (not fatal):', err);
  }
}

/**
 * Call immediately after blockMarket writes. market_blocks is keyed one row per
 * market_ticker (an UPSERT), so this naturally counts DISTINCT tickers with a
 * recent divergence, not raw event volume -- exactly the intended "how many
 * different markets are showing a problem" signal, not "how many times has the
 * same ticker re-triggered". Failure-isolated, same reasoning as
 * checkFailedOrdersSignal.
 */
export function checkDivergencesSignal(db: Database.Database): void {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM market_blocks
         WHERE blocked_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
      )
      .get(`-${CIRCUIT_BREAKER_DIVERGENCES_WINDOW_MINUTES} minutes`) as { n: number };
    if (row.n >= CIRCUIT_BREAKER_DIVERGENCES_THRESHOLD) {
      tripBreaker(
        db, 'divergences',
        `${row.n} reconciliation divergences within ${CIRCUIT_BREAKER_DIVERGENCES_WINDOW_MINUTES} minutes`
      );
    }
  } catch (err) {
    console.error('[checkDivergencesSignal] failed to evaluate the divergences signal (not fatal):', err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: PASS (all new tests, plus every pre-existing test in this file still green).

- [ ] **Step 5: Commit**

```bash
git add src/decide/ledger.ts test/decide/ledger.test.ts
git commit -m "feat: add circuit-breaker schema and trip/clear/signal primitives"
```

---

### Task 2: KalshiClient logs its own errors

**Files:**
- Modify: `src/execute/kalshiClient.ts`
- Test: `test/execute/kalshiClient.test.ts`

**Interfaces:**
- Consumes: `recordKalshiError`, `isTradingHalted` from Task 1
  (`src/decide/ledger.ts`).
- Produces: `KalshiClient`'s constructor accepts an optional `db` in its existing
  `opts` parameter — `new KalshiClient(config, { db })`. No change to any existing
  public method signature.

- [ ] **Step 1: Write the failing test**

Add to `test/execute/kalshiClient.test.ts` (find the existing test setup that
constructs a `KalshiClient` and injects `_fetchFn` — this file already does that for
other tests; match its exact pattern for creating a client and a temp ledger):

```typescript
import { openLedger, isTradingHalted, CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD } from '../../src/decide/ledger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('KalshiClient error logging', () => {
  let dir: string;
  let db: ReturnType<typeof openLedger>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-client-errors-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs a kalshi_errors row (call_site without the query string) and still rethrows the original error', async () => {
    const client = new KalshiClient(
      { apiKeyId: 'k', privateKeyPath: PRIVATE_KEY_PATH_FIXTURE },
      { db }
    );
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () =>
      new Response('server exploded', { status: 500, statusText: 'Internal Server Error' });

    await expect(client.getBalance()).rejects.toThrow(/500/);

    const row = db.prepare('SELECT call_site, error_message FROM kalshi_errors').get() as
      { call_site: string; error_message: string };
    expect(row.call_site).toBe('/portfolio/balance');
    expect(row.error_message).toMatch(/500/);
  });

  it('trips the kalshi-errors circuit breaker after enough real errors, driving the real call site', async () => {
    const client = new KalshiClient(
      { apiKeyId: 'k', privateKeyPath: PRIVATE_KEY_PATH_FIXTURE },
      { db }
    );
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () =>
      new Response('down', { status: 500, statusText: 'Internal Server Error' });

    for (let i = 0; i < CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD; i++) {
      await expect(client.getBalance()).rejects.toThrow();
    }
    expect(isTradingHalted(db)).toBe(true);
  });

  it('without a db, an error still throws normally and nothing is logged', async () => {
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: PRIVATE_KEY_PATH_FIXTURE });
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () =>
      new Response('down', { status: 500, statusText: 'Internal Server Error' });
    await expect(client.getBalance()).rejects.toThrow(/500/);
  });
});
```

Use whatever existing fixture this test file already has for a valid PEM private key
path (check the top of `test/execute/kalshiClient.test.ts` for how existing tests
construct a `KalshiClient` — reuse that exact constant/fixture rather than inventing a
new one).

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/execute/kalshiClient.test.ts`
Expected: FAIL — the second constructor argument doesn't accept `db` yet (or the test
compiles but no row is ever logged).

- [ ] **Step 3: Implement**

In `src/execute/kalshiClient.ts`:

1. Add the import at the top:
```typescript
import type Database from 'better-sqlite3';
import { recordKalshiError } from '../decide/ledger.js';
```

2. Add a private field and extend the constructor's `opts` parameter:
```typescript
  private readonly db?: Database.Database;
```
Change the constructor signature from
`constructor(config: KalshiClientConfig, opts: { now?: () => number } = {})` to:
```typescript
  constructor(config: KalshiClientConfig, opts: { now?: () => number; db?: Database.Database } = {}) {
    this.apiKeyId = config.apiKeyId;
    this.privateKeyPath = config.privateKeyPath;
    this.now = opts.now ?? (() => Date.now());
    this.minIntervalMs = Math.max(1, Math.ceil(1000 / Math.max(1, config.requestsPerSecond ?? 5)));
    this.db = opts.db;
  }
```

3. In `request()`'s error path, log before rethrowing. The method currently throws
directly on `!res.ok`:
```typescript
    if (!res.ok) {
      throw new KalshiRequestError(
        `Kalshi ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        retryAfterMsFromHeader(res)
      );
    }
```
Change this whole block, and also wrap the `_fetchFn` call itself (a network-level
throw, e.g. connection refused, never reaches the `!res.ok` check at all) so BOTH
failure shapes are logged:
```typescript
    const callSite = endpoint.split('?')[0];
    let res: Response;
    try {
      res = await this._fetchFn(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.db) recordKalshiError(this.db, callSite, message);
      throw err;
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
    }

    if (!res.ok) {
      const message = `Kalshi ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 500)}`;
      if (this.db) recordKalshiError(this.db, callSite, message);
      throw new KalshiRequestError(message, res.status, retryAfterMsFromHeader(res));
    }
    return (json ?? {}) as T;
```
(This replaces the existing `const res = await this._fetchFn(...)` line and
everything after it through the existing `return (json ?? {}) as T;` — read the
surrounding code in full before editing so the replacement lines up exactly with
what's already there, including the existing `AbortSignal.timeout` line from a prior
slice's fix.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/execute/kalshiClient.test.ts`
Expected: PASS (new tests plus every pre-existing test in this file).

- [ ] **Step 5: Commit**

```bash
git add src/execute/kalshiClient.ts test/execute/kalshiClient.test.ts
git commit -m "feat: log KalshiClient errors to kalshi_errors and trip the breaker"
```

---

### Task 3: fetchMarketStatus and fetchActiveLadder log their own errors

**Files:**
- Modify: `src/decide/kalshi.ts`
- Test: `test/decide/kalshi.test.ts`

**Interfaces:**
- Consumes: `recordKalshiError` from Task 1.
- Produces: `fetchMarketStatus(ticker: string, db?: Database.Database):
  Promise<MarketStatus>` and `fetchActiveLadder(seriesTicker: string, db?:
  Database.Database): Promise<ActiveLadder | null>` — both gain an optional second
  parameter; existing single-argument callers/tests continue to compile and behave
  identically (db simply stays `undefined`, and no logging happens without it, mirroring
  Task 2's `KalshiClient` behavior).

- [ ] **Step 1: Write the failing test**

Add to `test/decide/kalshi.test.ts`. This file's existing tests call the real Kalshi
API directly (no injection seam) — use `vi.spyOn(globalThis, 'fetch')` to force an
error path without adding any new production-code injection point:

```typescript
import { openLedger } from '../../src/decide/ledger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

describe('fetchMarketStatus / fetchActiveLadder error logging', () => {
  let dir: string;
  let db: ReturnType<typeof openLedger>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-errors-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    fetchSpy?.mockRestore();
  });

  it('fetchMarketStatus logs to kalshi_errors and still throws, given a db', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('down', { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(fetchMarketStatus('SOME-TICKER', db)).rejects.toThrow();

    const row = db.prepare('SELECT call_site FROM kalshi_errors').get() as { call_site: string };
    expect(row.call_site).toBe('fetchMarketStatus');
  });

  it('fetchMarketStatus without a db still throws normally (no crash from the missing db)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('down', { status: 500, statusText: 'Internal Server Error' })
    );
    await expect(fetchMarketStatus('SOME-TICKER')).rejects.toThrow();
  });

  it('fetchActiveLadder logs to kalshi_errors and still throws, given a db', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('down', { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(fetchActiveLadder('KXAPRPOTUS', db)).rejects.toThrow();

    const row = db.prepare('SELECT call_site FROM kalshi_errors').get() as { call_site: string };
    expect(row.call_site).toBe('fetchActiveLadder');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/kalshi.test.ts`
Expected: FAIL — neither function accepts a second argument or logs anything yet.

- [ ] **Step 3: Implement**

In `src/decide/kalshi.ts`, add the import:
```typescript
import type Database from 'better-sqlite3';
import { recordKalshiError } from './ledger.js';
```

Change `fetchActiveLadder`'s signature and wrap its body in a try/catch that logs
once (on either failure shape) and rethrows:
```typescript
export async function fetchActiveLadder(seriesTicker: string, db?: Database.Database): Promise<ActiveLadder | null> {
  try {
    const eventsUrl = `${KALSHI_API_BASE}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open`;
    const eventsRes = await fetch(eventsUrl);
    if (!eventsRes.ok) {
      throw new Error(`Kalshi events fetch failed: ${eventsRes.status} ${eventsRes.statusText}`);
    }
    const eventsBody = (await eventsRes.json()) as KalshiEventsResponse;
    if (eventsBody.events.length === 0) {
      return null;
    }

    const active = [...eventsBody.events].sort((a, b) => a.strike_date.localeCompare(b.strike_date))[0];

    const marketsUrl = `${KALSHI_API_BASE}/markets?event_ticker=${encodeURIComponent(active.event_ticker)}&status=open`;
    const marketsRes = await fetch(marketsUrl);
    if (!marketsRes.ok) {
      throw new Error(`Kalshi markets fetch failed: ${marketsRes.status} ${marketsRes.statusText}`);
    }
    const marketsBody = (await marketsRes.json()) as KalshiMarketsResponse;

    const bands: BandMarket[] = marketsBody.markets.map((m) => ({
      ticker: m.ticker,
      floorStrike: m.floor_strike ?? null,
      capStrike: m.cap_strike ?? null,
      strikeType: m.strike_type,
      status: m.status,
      yesAskCents: priceCentsOrNull(m.yes_ask_dollars),
      yesBidCents: priceCentsOrNull(m.yes_bid_dollars),
      yesAskSizeContracts: sizeContracts(m.yes_ask_size_fp),
      yesBidSizeContracts: sizeContracts(m.yes_bid_size_fp),
    }));

    return { eventTicker: active.event_ticker, strikeDate: active.strike_date, bands };
  } catch (err) {
    if (db) {
      const message = err instanceof Error ? err.message : String(err);
      recordKalshiError(db, 'fetchActiveLadder', message);
    }
    throw err;
  }
}
```
(Keep every line of the existing body exactly as it is today — this only adds the
`db` parameter, the surrounding `try`, and the `catch` block.)

Change `fetchMarketStatus` the same way:
```typescript
export async function fetchMarketStatus(ticker: string, db?: Database.Database): Promise<MarketStatus> {
  try {
    const url = `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Kalshi market status fetch failed for ${ticker}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as KalshiSingleMarketResponse;
    return { status: body.market.status, result: body.market.result };
  } catch (err) {
    if (db) {
      const message = err instanceof Error ? err.message : String(err);
      recordKalshiError(db, 'fetchMarketStatus', message);
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/kalshi.test.ts`
Expected: PASS (new tests, plus the existing real-API test for `fetchActiveLadder`
unaffected since it doesn't pass a `db` and the real API call still succeeds
normally).

- [ ] **Step 5: Commit**

```bash
git add src/decide/kalshi.ts test/decide/kalshi.test.ts
git commit -m "feat: log fetchMarketStatus/fetchActiveLadder errors to kalshi_errors"
```

---

### Task 4: Thread db through to real call sites; wire the global halt check

**Files:**
- Modify: `src/main.ts`
- Modify: `src/decide/pipeline.ts`
- Modify: `src/execute/reconcileOpenPositions.ts`
- Test: `test/main.test.ts`, `test/decide/pipeline.test.ts`

**Interfaces:**
- Consumes: `isTradingHalted` (Task 1), the now-optional `db` parameters on
  `KalshiClient`'s constructor (Task 2), `fetchActiveLadder`/`fetchMarketStatus`
  (Task 3).
- Produces: every real (non-test) call site now passes its already-in-scope `db`
  through, and `pipeline.ts`'s existing halt check also honors an automatic trip.

- [ ] **Step 1: Write the failing tests**

Add to `test/decide/pipeline.test.ts` (this file already constructs a real ledger via
`openLedger` and calls `runDecisionPipeline` directly — match its existing setup):

```typescript
import { tripBreaker } from '../../src/decide/ledger.js';

it('records a skip with a "circuit breaker tripped" reason when a breaker is tripped, distinct from the manual kill switch, and makes no model calls', async () => {
  tripBreaker(db, 'failed-orders', 'test trip');
  const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
  const item = baseItem();

  await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

  expect(synopsisModule.synopsize).not.toHaveBeenCalled();
  expect(fetchLadder).not.toHaveBeenCalled();
  const row = onlyRowFor(db, item.item_id);
  expect(row.reason).toBe('circuit breaker tripped');
  expect(row.would_trade).toBe(0);
});
```

This mirrors the existing `'records a skip when the kill switch is set...'` test in
this same file exactly (same fixtures, same assertions) — the only differences are
`tripBreaker(...)` instead of setting `process.env.EXECUTOR_TRADING_HALTED`, and the
expected reason string. Check `onlyRowFor`'s actual return shape (raw `decisions` row
columns, e.g. `would_trade` as `0`/`1`, not a camelCased `wouldTrade` boolean — match
whatever the existing kill-switch test asserts against exactly).

**No new test is needed in `test/main.test.ts` for this task.** Confirmed by reading
that file: it never calls `main()` and never constructs a real `KalshiClient` from
`main.ts`'s own code — every test there injects its own stub/mock client directly
into `makeOnItem`/`reconcilePendingOrders` (e.g. `kalshiClient: stubKalshiClient()`,
or a locally-built `{ getOrders, getPositions }` object). This is an existing,
deliberate project pattern (this file already has no test driving `main()` end to
end for the exact same reason). `main.ts`'s `new KalshiClient(..., { db })` change is
verified by direct code review during this task's review step instead, the same way
`main.ts`'s startup-reconciliation wiring has always been verified.

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts test/main.test.ts`
Expected: the new pipeline.test.ts test FAILs (reason string doesn't match yet,
since `isTradingHalted` isn't wired into the halt check).

- [ ] **Step 3: Implement**

In `src/decide/pipeline.ts`:
1. Add `isTradingHalted` to the existing import from `./ledger.js`.
2. Change the halt check (currently `if (process.env.EXECUTOR_TRADING_HALTED === 'true') { ... }`):
```typescript
    const manualHalt = process.env.EXECUTOR_TRADING_HALTED === 'true';
    if (manualHalt || isTradingHalted(db)) {
      const reason = manualHalt ? 'kill switch active' : 'circuit breaker tripped';
      recordDecision(db, skipRecord(item, reason, { rung, orderStatus: 'resolved' }));
      return;
    }
```
3. Change the `fetchLadder` call site (currently `const ladder: ActiveLadder | null = await fetchLadder(KALSHI_SERIES_TICKER);`):
```typescript
    const ladder: ActiveLadder | null = await fetchLadder(KALSHI_SERIES_TICKER, db);
```

In `src/execute/reconcileOpenPositions.ts`, change the `fetchMarketStatus` call site
(currently `const marketStatus = await fetchMarketStatus(marketTicker);`):
```typescript
      const marketStatus = await fetchMarketStatus(marketTicker, db);
```
(`db` is already destructured at the top of `reconcileOpenPositions` via `const { db, client } = deps;` — no new parameter needed here.)

In `src/main.ts`, change the `KalshiClient` construction (currently
`const kalshiClient = new KalshiClient({ apiKeyId: ..., privateKeyPath: ... });`):
```typescript
  const kalshiClient = new KalshiClient(
    { apiKeyId: mustGetEnv('KALSHI_API_KEY_ID'), privateKeyPath: mustGetEnv('KALSHI_PRIVATE_KEY_PATH') },
    { db }
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts test/main.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `direnv exec . npm test`
Expected: PASS — no regression in `reconcileOpenPositions.test.ts`'s existing
`mockFetchMarketStatus` tests (an extra `db` argument is silently ignored by a JS
function that only declares one parameter).

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/decide/pipeline.ts src/execute/reconcileOpenPositions.ts test/decide/pipeline.test.ts test/main.test.ts
git commit -m "feat: thread db into real Kalshi call sites, honor the circuit breaker in the halt check"
```

---

### Task 5: Wire the failed-orders signal into both resolveOrder call sites

**Files:**
- Modify: `src/decide/pipeline.ts`
- Modify: `src/execute/order.ts`
- Test: `test/decide/pipeline.test.ts`, `test/execute/order.test.ts`

**Interfaces:**
- Consumes: `checkFailedOrdersSignal` (Task 1).
- Produces: nothing new for later tasks — this is the last piece needed for the
  failed-orders signal to be live end-to-end.

- [ ] **Step 1: Write the failing tests**

Add to `test/execute/order.test.ts`, near the existing `reconcilePendingOrders` tests
(reuse this file's existing fixtures for a pending order and a mocked
`reconcileOrder`/client — check the top of the file for how those are already built):

```typescript
import { isTradingHalted, CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD } from '../../src/decide/ledger.js';

it('reconcilePendingOrders trips the failed-orders breaker after enough real startup-reconcile failures', async () => {
  // Same fixture shape as this file's existing "resolves a crash-orphaned pending
  // order that never filled" test just above -- an empty getOrders/getPositions
  // response makes reconcileOrder return status 'unknown' for every row.
  for (let i = 0; i < CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD; i++) {
    pendingSetup({ clientOrderId: `cid-startup-${i}` });
  }
  const client = mockClient({
    getOrders: async () => ({ orders: [] }),
    getPositions: async () => ({ market_positions: [] }),
  });

  await reconcilePendingOrders(db, client);

  expect(isTradingHalted(db)).toBe(true);
});
```

Add to `test/decide/pipeline.test.ts`, in the same `describe('runDecisionPipeline',
...)` block as the kill-switch test above (reuse `baseItem`, `stubLadder`,
`stubKalshiClient`, `client`, `db` exactly as every other test in this block does):

```typescript
it('trips the failed-orders breaker after enough real would-trade decisions resolve to rejected', async () => {
  vi.spyOn(orderModule, 'placeOrder').mockResolvedValue({
    clientOrderId: 'rejected-mock-client-order-id',
    kalshiOrderId: null,
    kalshiOrderStatus: null,
    filledContracts: 0,
    avgFillPriceCents: null,
    status: 'rejected',
    dryRun: false,
    errorDetail: 'simulated 400 for this test',
  });

  for (let i = 0; i < CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD; i++) {
    const item = baseItem({
      item_id: `item-rejected-${i}`, dedup_id: `dedup-rejected-${i}`, story_key: `story-rejected-${i}`,
    });
    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });
  }

  expect(isTradingHalted(db)).toBe(true);
});
```

A distinct `story_key` per iteration matters here: `hasOpenPosition` dedups by
`story_key` + `eventTicker`, and every iteration must independently reach
`placeOrder` (not get skipped as a duplicate) for this test to actually drive
`CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD` real failures through the real call site.

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts test/execute/order.test.ts`
Expected: FAIL — nothing calls `checkFailedOrdersSignal` yet.

- [ ] **Step 3: Implement**

In `src/decide/pipeline.ts`, add `checkFailedOrdersSignal` to the existing import
from `./ledger.js`. Right after the transaction that calls `resolveOrder`/
`resolveDecision` (the `})();` line that closes it, immediately before the
`} catch (err) {` line), add:
```typescript
    checkFailedOrdersSignal(db, placed.status);
```

In `src/execute/order.ts`, add `checkFailedOrdersSignal` to the existing import from
`../decide/ledger.js`. Inside `reconcilePendingOrders`'s loop, right after the
transaction that calls `resolveOrder`/`resolveDecision` (the `})();` line that closes
it, immediately before the `} catch (err) {` line), add:
```typescript
      checkFailedOrdersSignal(db, reconciled.status);
```
(`reconciled.status` is typed `'filled' | 'partial' | 'unfilled' | 'unknown'` here —
narrower than the full `OrderStatus` union, but `checkFailedOrdersSignal` already
only reacts to `'rejected'`/`'unknown'`/`'error'`, so passing any of the other three
values is a safe no-op; no cast or special-casing needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts test/execute/order.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `direnv exec . npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/decide/pipeline.ts src/execute/order.ts test/decide/pipeline.test.ts test/execute/order.test.ts
git commit -m "feat: trip the failed-orders breaker from both resolveOrder call sites"
```

---

### Task 6: Wire the divergences signal into reconcileOpenPositions

**Files:**
- Modify: `src/execute/reconcileOpenPositions.ts`
- Test: `test/execute/reconcileOpenPositions.test.ts`

**Interfaces:**
- Consumes: `checkDivergencesSignal` (Task 1).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Add to `test/execute/reconcileOpenPositions.test.ts`, in the existing
`describe('reconcileOpenPositions', ...)` block (reuse `recordOpenDecision`/
`mockClient`/`mockFetchMarketStatus` exactly as the existing divergence tests in this
file already do):

```typescript
import { isTradingHalted } from '../../src/decide/ledger.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `direnv exec . npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: FAIL — nothing calls `checkDivergencesSignal` yet.

- [ ] **Step 3: Implement**

In `src/execute/reconcileOpenPositions.ts`, add `checkDivergencesSignal` to the
existing import from `../decide/ledger.js`. Right after the `blockMarket(db,
marketTicker, reason, expected, real);` call inside the divergence branch (before or
after the existing `console.error('[RECONCILE-DIVERGENCE] ...')` line — either
ordering is fine), add:
```typescript
        checkDivergencesSignal(db);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `direnv exec . npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `direnv exec . npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/execute/reconcileOpenPositions.ts test/execute/reconcileOpenPositions.test.ts
git commit -m "feat: trip the divergences breaker from reconcileOpenPositions"
```

---

### Task 7: Manual clear script and operator documentation

**Files:**
- Create: `scripts/clear-breaker.ts`
- Modify: `package.json`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: `openLedger`, `clearAllTrips` (Task 1).
- Produces: `npm run clear-breaker`, a manual-only CLI tool. Not part of the
  automated test suite (matching `scripts/clear-market-block.ts`'s existing
  precedent — that script also has no automated test, since it's a thin, directly
  auditable wrapper over one already-tested ledger function).

- [ ] **Step 1: Write the script**

Read `scripts/clear-market-block.ts` in full first, and match its exact style
(shebang-free `.ts` run via `tsx`, `mustGetEnv`-free since it only needs the ledger
path, same `DEFAULT_LEDGER_PATH` resolution precedent noted in that file's own
comment about matching `main.ts`, not `smoke.ts`).

Create `scripts/clear-breaker.ts`:

```typescript
// scripts/clear-breaker.ts
//
// Manual operator tool: clears every currently-tripped automatic circuit breaker.
// Run this only after confirming the underlying problem is actually resolved --
// clearing does not investigate anything, it only un-halts trading.
//   direnv exec . npx tsx scripts/clear-breaker.ts

import path from 'node:path';
import { openLedger, clearAllTrips } from '../src/decide/ledger.js';

const DEFAULT_LEDGER_PATH = path.join(process.cwd(), 'data', 'decisions.db');

function main(): void {
  const db = openLedger(DEFAULT_LEDGER_PATH);
  const cleared = clearAllTrips(db);
  db.close();

  if (cleared === 0) {
    console.error('[clear-breaker] no circuit breaker is currently tripped -- nothing to clear');
    process.exit(1);
  }
  console.log(`[clear-breaker] cleared ${cleared} trip(s). Trading will resume on the next decision.`);
}

main();
```

(If `scripts/clear-market-block.ts` resolves `DEFAULT_LEDGER_PATH` differently than
shown above — e.g. importing a shared constant instead of redefining it — match
whatever that file actually does instead of this snippet, so the two scripts stay
consistent with each other.)

- [ ] **Step 2: Add the npm script**

In `package.json`, add a `"clear-breaker"` entry alongside the existing
`"clear-block"` entry (find it in the `"scripts"` object and match its exact form,
substituting the new file):
```json
    "clear-breaker": "tsx scripts/clear-breaker.ts"
```

- [ ] **Step 3: Manually verify the script runs**

Run: `direnv exec . npm run clear-breaker`
Expected output (against a fresh/no-trip database): `[clear-breaker] no circuit
breaker is currently tripped -- nothing to clear`, exit code 1.

To verify the clearing path itself works, temporarily trip a breaker from a REPL or
a throwaway script using `tripBreaker` against the same `data/decisions.db` (or a
copy of it), then re-run `npm run clear-breaker` and confirm it reports one cleared
and exits 0. Delete any throwaway verification script afterward — it's not part of
this plan's deliverables.

- [ ] **Step 4: Add operator documentation**

In `HANDOFF.md`, add a new subsection right after the existing `### 5a.2 Pre-go-live
checklist` section's numbered list (before `### 5a.3 Operational notes`) — read the
existing structure of that file's §5a first so this reads consistently with it:

```markdown
### 5a.2a Automatic circuit breakers (added in slice 6)

Three independent automatic triggers halt ALL new order placement, the same global
effect as `EXECUTOR_TRADING_HALTED`, when recent history crosses a fixed threshold:

- **Failed/ambiguous orders**: 3 orders resolving to `rejected`/`unknown`/`error`
  within 30 minutes.
- **Reconciliation divergences**: 2 distinct markets blocked by slice 5's
  reconciliation within 60 minutes.
- **Kalshi API errors**: 5 errors from any Kalshi API call (order placement,
  position/status reads, market data) within 15 minutes.

A trip is visible in the `circuit_breaker_trips` table and logged loudly as
`[CIRCUIT-BREAKER-TRIPPED]`. It halts only NEW decisions (matching this system's
entry-only scope) — nothing already in flight is affected, and slice 5's per-market
`market_blocks` mechanism is completely independent of this.

**Recovery is manual only** — there is no auto-expiry. Investigate the real cause
(check `circuit_breaker_trips.reason`, and the underlying `orders`/`market_blocks`/
`kalshi_errors` rows it references) before clearing. To clear:

```
direnv exec . npm run clear-breaker
```

This clears every currently-open trip, not just one — if more than one signal
tripped, clearing is a statement that the whole situation is resolved, not just one
signal among several.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/clear-breaker.ts package.json HANDOFF.md
git commit -m "feat: add manual circuit-breaker clear script and operator runbook section"
```
