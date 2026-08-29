# Automatic Circuit Breakers — Design (Slice 6)

## Goal

Slice 5 (account reconciliation) can detect and block a *single-market* divergence,
but nothing in this system reacts when trouble is systemic rather than local — a
persistent execution problem (bad credentials, an API regression, a network issue)
producing repeated failed/ambiguous order outcomes, multiple markets diverging in a
short span, or a burst of Kalshi API errors across any call site. Today each of those
would simply keep happening, one `console.error` at a time, until a human notices.

This slice adds three independent, narrowly-scoped automatic triggers that halt *all*
new order placement — the same global effect as the existing manual
`EXECUTOR_TRADING_HALTED` switch — when recent history crosses a fixed threshold. It
is deliberately **not** a P&L/loss-velocity trigger (no P&L/settlement-outcome
tracking exists anywhere in this system yet — that's a distinct, not-yet-brainstormed
slice) and **not** a replacement for slice 5's per-market blocking (that stays exactly
as it is; this slice's "repeated reconciliation divergences" trigger sits on top of it,
watching for a *pattern* across blocks rather than replacing any single block's logic).

## Decisions made during brainstorming

1. **Three trigger signals**, each independent, each evaluated against a fixed
   lookback window:
   - **Failed/ambiguous order outcomes**: an `orders` row resolves to `rejected`,
     `unknown`, or `error` (see below for why these three and not others).
   - **Repeated reconciliation divergences**: a new `market_blocks` row is written by
     slice 5's `reconcileOpenPositions`.
   - **Kalshi API error rate**: any error from any Kalshi API call, across every call
     site (order placement, position/status reads, market data), not only the ones
     that already surface as an `orders` row.

   An exposure-velocity trigger was considered and explicitly **not** included —
   the existing `MAX_TOTAL_EXPOSURE_CENTS` hard cap already bounds this, and a rate-of
   -climb signal on top of a $40 total cap was judged to add complexity without a
   proportionate safety benefit at this system's scale.

2. **Which `OrderStatus` values count as a failure, precisely.** Checked the real
   values (`ledger.ts`'s `OrderStatus` type) rather than assuming: `unfilled` and
   `partial` are normal IOC trading outcomes (a limit order not filling because the
   market moved is not an anomaly), and `declined-at-execution` is the system
   *correctly* refusing to trade (an exposure cap or an existing market block doing
   its job) — none of these three should ever count toward tripping a breaker. Only
   `rejected` (Kalshi rejected the order outright — a definite 4xx) and `unknown`
   (`reconcileOrder` could find no record of the order at all after retries and a
   position-diff check — the most ambiguous outcome this system produces) are real
   anomalies. `error` is included too for forward-compatibility: it's defined in the
   type but not currently produced by any code path, and clearly meant to represent a
   failure state if one is added later.

3. **A new `kalshi_errors` log table, written from every Kalshi API call site** —
   not folded into the existing `orders` table, and not scoped to order-placement
   errors only. Reconciliation's own `getPositions`/`fetchMarketStatus` calls (and
   `fetchActiveLadder`'s market-data fetch) can fail without ever producing an
   `orders` row, and a systemic API/connectivity problem should be visible regardless
   of which call site happened to hit it first.

4. **The logging seam lives inside the API clients themselves, not at every
   caller.** `KalshiClient` (execute/kalshiClient.ts) and `fetchMarketStatus`/
   `fetchActiveLadder` (decide/kalshi.ts) each gain an optional `db` handle (at
   construction for `KalshiClient`, as a parameter for the two free functions) and log
   to `kalshi_errors` in one place, right before rethrowing. This trades a new DB
   dependency on previously-pure API clients for guaranteeing no call site is ever
   missed as new ones are added later — the alternative (each of `pipeline.ts`,
   `order.ts`, `reconcileOpenPositions.ts`, `main.ts` catching and logging
   independently) was rejected as easy to miss on the next new call site.

5. **Thresholds and windows** (hardcoded constants, matching the existing
   `MAX_NOTIONAL_CENTS_PER_TRADE`/`MAX_TOTAL_EXPOSURE_CENTS` style — not
   env-configurable):
   - Failed/ambiguous orders: **3 within 30 minutes**. `placeOrder` already retries a
     transient failure up to 3 times per order (`order.ts`'s own `maxAttempts`), so 3
     *separate orders* resolving to a real failure status is a persistent problem, not
     one bad attempt.
   - Reconciliation divergences: **2 within 60 minutes**. Reconciliation ticks every
     10 minutes; 2 genuine divergences inside an hour means multiple ticks are
     independently catching something wrong, not one isolated bad market.
   - Kalshi API errors: **5 within 15 minutes**. Deliberately noisier (covers every
     call site, not just order placement) and a shorter window, since a real
     connectivity/API problem should show up fast across many calls.

6. **Evaluation timing: inline, immediately after the triggering write**, not on a
   periodic sweep. Each of the three writes above (`resolveOrder`, `blockMarket`, a
   logged `kalshi_errors` row) is immediately followed by a count query against that
   signal's window; crossing the threshold inserts a trip row right then. This halts
   trading before the *next* order attempt rather than up to 10 minutes later on
   slice 5's reconciliation timer — piggybacking on that timer was considered and
   rejected as too slow for a signal meant to react to an active problem.

7. **Halt mechanism: a new DB-backed table, checked alongside (not instead of) the
   existing `EXECUTOR_TRADING_HALTED` env var.** `EXECUTOR_TRADING_HALTED` is read
   directly as `process.env.EXECUTOR_TRADING_HALTED === 'true'`
   (`pipeline.ts:104`) — a value fixed when the process starts, which the running
   process cannot set itself and which isn't persisted anywhere code can write to.
   An automatic trip therefore needs its own persisted, code-settable state:
   `circuit_breaker_trips`, an events-log table (like `market_blocks`, not a single
   mutable row) — `id`, `signal`, `reason`, `tripped_at`, `cleared_at`. "Currently
   halted" is `isTradingHalted(db)`: true if the env var is `'true'` **or** any row
   exists with `cleared_at IS NULL`. Every past trip stays visible for audit even
   after being cleared, rather than being overwritten.

8. **Scope of the halt: global, exactly like `EXECUTOR_TRADING_HALTED` today** — no
   new orders anywhere, for any market. All three signals indicate a systemic problem
   (execution itself, or a pattern across markets), not a single market's issue —
   slice 5's per-`market_ticker` blocking already exists for that narrower case and is
   untouched by this slice. Only *new* decisions are affected (checked at the same
   point `pipeline.ts` already checks the env var); nothing already in flight is
   touched, matching this system's entry-only scope.

9. **Recovery: manual only, via a clear script — no auto-expiry.** Matches
   `market_blocks`' existing pattern (`npm run clear-block`) and this project's
   established philosophy for anything that trips a safety mechanism: a human
   confirms the real cause before trading resumes. An auto-clearing cooldown was
   considered and rejected — it risks silently flapping (trip → auto-clear →
   immediately re-trip) with no human ever seeing it, or resuming trading into a
   still-bad situation if the underlying cause is intermittent rather than resolved.
   `npm run clear-breaker` clears **every** currently-open trip row, not just one —
   an operator clearing the breaker is confirming the whole situation is resolved,
   not one signal among several in isolation.

10. **A failure inside the breaker's own count-and-trip logic must never crash the
    write it's attached to.** The real write (`resolveOrder`, `blockMarket`, the
    `kalshi_errors` insert) always happens first and is already committed by the time
    the count-and-trip check runs; if that check itself throws (a DB error, for
    instance), it's caught, logged loudly, and does not propagate. A broken breaker
    check must not become a new way to crash order resolution or reconciliation —
    matching the existing "auxiliary safety check fails loud but never crashes the
    primary path" pattern already used elsewhere in this system.

## Architecture

New/changed files:

- **`src/decide/ledger.ts`** (modified) — new `kalshi_errors` table:
  `id INTEGER PRIMARY KEY`, `occurred_at TEXT NOT NULL DEFAULT (strftime(...))`,
  `call_site TEXT NOT NULL`, `error_message TEXT NOT NULL`. New
  `circuit_breaker_trips` table: `id INTEGER PRIMARY KEY`, `signal TEXT NOT NULL
  CHECK (signal IN ('failed-orders','divergences','kalshi-errors'))`, `reason TEXT
  NOT NULL`, `tripped_at TEXT NOT NULL DEFAULT (strftime(...))`, `cleared_at TEXT
  NULL`. New functions: `recordKalshiError(db, callSite, errorMessage): void`
  (inserts, then evaluates the kalshi-errors signal), `isTradingHalted(db): boolean`,
  `tripBreaker(db, signal, reason): void` (no-ops if already tripped — checked via
  `isTradingHalted` first, so a sustained problem doesn't insert duplicate trip rows),
  `clearAllTrips(db): number` (returns count cleared, used by the clear script).
- **`src/execute/kalshiClient.ts`** (modified) — `KalshiClient`'s constructor gains an
  optional `db?: Database.Database`. `request()`'s catch path logs to
  `kalshi_errors` (via `recordKalshiError`, call site = the method name) before
  rethrowing, when `db` is present. After the insert, counts `kalshi_errors` rows in
  the last 15 minutes and trips the `'kalshi-errors'` signal at ≥5.
- **`src/decide/kalshi.ts`** (modified) — `fetchMarketStatus` and `fetchActiveLadder`
  each gain an optional `db` parameter, same logging-then-rethrow treatment as
  `KalshiClient.request`.
- **`src/execute/order.ts`** (modified) — right after `resolveOrder` writes (in both
  the main `placeOrder` path and the startup `reconcilePendingOrders` recovery path),
  if the resolved status is `rejected`/`unknown`/`error`, count `orders` rows with
  those statuses and `resolved_at` in the last 30 minutes; trip `'failed-orders'` at
  ≥3.
- **`src/execute/reconcileOpenPositions.ts`** (modified) — right after `blockMarket`
  writes a new block, count `market_blocks` rows with `blocked_at` in the last 60
  minutes; trip `'divergences'` at ≥2.
- **`src/decide/pipeline.ts`** (modified) — the existing halt check
  (`pipeline.ts:104`) becomes `process.env.EXECUTOR_TRADING_HALTED === 'true' ||
  isTradingHalted(db)`.
- **`src/main.ts`** (modified) — `KalshiClient` construction passes `db`;
  `fetchMarketStatus`/`fetchActiveLadder` call sites pass `db` through.
- **`scripts/clear-breaker.ts`** (new, matching `scripts/clear-market-block.ts`'s
  existing pattern) — calls `clearAllTrips(db)`, reports how many trips were cleared,
  exits non-zero if none were currently open.

## Data flow

```
Any Kalshi API call (KalshiClient.request, fetchMarketStatus, fetchActiveLadder):
  try { ...real call... }
  catch (err) {
    if (db) {
      recordKalshiError(db, callSite, err.message)
        -- inserts into kalshi_errors, then counts rows in last 15 min,
           trips 'kalshi-errors' at >= 5 (swallows its own errors, logs loudly)
    }
    throw err  -- unchanged from today; nothing about existing error handling changes
  }

order.ts, after resolveOrder(db, orderId, resolution):
  if (resolution.status in ('rejected', 'unknown', 'error')):
    count = orders rows WHERE status IN (...) AND resolved_at >= now - 30min
    if (count >= 3): tripBreaker(db, 'failed-orders', reason)

reconcileOpenPositions.ts, after blockMarket(db, marketTicker, ...):
  count = market_blocks rows WHERE blocked_at >= now - 60min
  if (count >= 2): tripBreaker(db, 'divergences', reason)

pipeline.ts (existing halt check, extended):
  if (process.env.EXECUTOR_TRADING_HALTED === 'true' || isTradingHalted(db)):
    return skipRecord(...)  -- unchanged downstream behavior, just a wider condition
```

## Testing plan

Matching this project's standing law — every value that travels through this system
needs at least one test driving the real call site, not just the function in
isolation:

- **Threshold precision**: for each of the three signals, insert real rows (via the
  real recording functions, backdating timestamps via raw SQL where a test needs an
  event placed outside the lookback window — same technique used for slice 5's
  stuck-order test) and assert the breaker trips at exactly the threshold count, not
  one before it, and that an event outside the window doesn't count toward it.
- **Status filtering**: a `orders` row resolving to `unfilled`/`partial`/
  `declined-at-execution` never counts toward the failed-orders signal, even many of
  them within the window — only `rejected`/`unknown`/`error` do.
- **Halt integration**: a would-trade decision is declined once `isTradingHalted`
  returns true, via the real `pipeline.ts` check, not just a unit test of
  `isTradingHalted` in isolation — mirroring how slice 5 tested `placeOrder` honoring
  a market block.
- **No duplicate trips**: tripping an already-tripped signal again (more qualifying
  events arrive while still tripped) does not insert a second `circuit_breaker_trips`
  row.
- **Breaker-check failure isolation**: a forced failure inside the count-and-trip
  logic (e.g. a mocked DB error) does not prevent the triggering write
  (`resolveOrder`/`blockMarket`/`recordKalshiError`'s own insert) from completing, and
  does not propagate out of the caller.
- **Clear script**: `clearAllTrips` clears every currently-open row when more than one
  signal is tripped at once, and reports zero cleared when nothing is open.
- **No automated test ever places a real order or calls the real Kalshi API** for
  breaker logic specifically — all three signals are tested against a real ledger
  with mocked/injected API failures, same testing posture as slices 4 and 5.

## Credential hygiene / non-negotiables reaffirmed

- This slice introduces no new authentication surface — `KalshiClient` gains a `db`
  parameter, not a new credential or endpoint.
- Nothing in this slice places, closes, or modifies an order — it only observes
  outcomes already produced elsewhere and gates *future* order placement at the exact
  same `pipeline.ts` check point already established. Entry-only scope is unchanged.
- No market-specific keyword/rule/resolution-condition logic is introduced — every
  trigger operates on execution/infrastructure signals (order status, block counts,
  API errors), never on market content or resolution conditions.
- `EXECUTOR_TRADING_HALTED` and slice 5's `market_blocks` are both unchanged and
  unaffected by this slice — three independent, redundant safety layers at three
  different scopes (whole-system manual, one-market automatic, whole-system
  automatic) now coexist, matching this project's established defense-in-depth
  pattern.
