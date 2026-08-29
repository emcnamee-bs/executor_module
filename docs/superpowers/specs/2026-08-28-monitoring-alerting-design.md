# Monitoring / Alerting — Design (Slice 7)

## Goal

Every safety mechanism this project has built so far — the manual kill switch, slice
5's per-market reconciliation blocking, slice 6's automatic circuit breakers — only
communicates through `console.log`/`console.error`. Nothing pages a human. On a
live, real-money system, a tripped circuit breaker or a blocked market that nobody
sees is functionally equivalent to having no safety mechanism at all: trading has
either halted (losing opportunity silently) or a market is sitting in a known-bad
state (risk silently persisting) until someone happens to read the logs.

This slice adds a Slack alert for three specific, high-signal events — a circuit
breaker trip, a new market divergence block, and a process restart following an
unclean exit — and nothing else. It is explicitly **not** a dashboard, **not** a
general-purpose event bus, and **not** an alert for every order placed (that last
one was considered during brainstorming and deliberately excluded: it's a
high-volume, low-urgency signal that would bury the three that actually need a
human's attention).

## Decisions made during brainstorming

1. **Three trigger events, chosen for urgency and rarity, not comprehensiveness.**
   A circuit breaker trip (global halt, slice 6), a new `market_blocks` divergence
   (per-market halt, slice 5), and a process restart following an unclean exit.
   Every real order placement was explicitly considered and excluded — a
   passive per-trade feed is a different, lower-urgency feature this slice does
   not build.
2. **Channel: a single Slack incoming webhook**, not email, not both. Simplest
   option with no new credential class beyond one more env var, and no mail-relay
   configuration to maintain alongside the Kalshi signing key.
3. **Detection reuses existing state; nothing new is added to `ledger.ts`'s core
   trip/block functions.** `tripBreaker`/`blockMarket`/`checkFailedOrdersSignal`/
   `checkDivergencesSignal` all stay exactly as slice 6 left them — fully
   synchronous (matching `better-sqlite3`'s deliberately sync API, an
   architectural invariant this project has held since slice 1) and returning
   `void`. Making any of them async to fire an alert directly would ripple an
   async signature change through every one of their callers across
   `pipeline.ts`, `order.ts`, `kalshiClient.ts`, and `kalshi.ts` — a large,
   invasive refactor for a small feature. Instead:
   - **Breaker trips**: at each of the three existing signal-check call sites
     (`pipeline.ts`'s two `resolveOrder` sites, `reconcileOpenPositions.ts`'s
     `blockMarket` site), capture `isTradingHalted(db)` immediately before and
     immediately after the check call. A `false → true` transition means *this*
     call is what just tripped it.
   - **Market blocks**: `reconcileOpenPositions.ts` already computes
     `wasAlreadyBlocked` before calling `blockMarket` (slice 6's own
     un-clearable-halt fix) — the exact boolean needed, already in hand with no
     new plumbing.
   - **Crash/restart**: cannot reuse existing state, since none currently
     distinguishes a clean shutdown from a crash — see decision 4.
4. **Crash detection: a clean-shutdown marker in the ledger, checked at the NEXT
   startup — not a handler that tries to fire from inside a dying process.** A
   genuine crash (an uncaught exception mid-async-operation, an OOM kill, a
   `SIGKILL`) cannot reliably complete an async Slack POST before the process
   exits — `process.on('uncaughtException')` handlers are unreliable for exactly
   this reason and were explicitly rejected. Instead: a one-row
   `process_lifecycle` table with a `state` of `'running'` or
   `'stopped_cleanly'`. On startup, if the row says `'running'` (meaning the
   previous run's own clean-shutdown code never executed), this run alerts
   "restarted after an unclean exit" — then immediately marks itself
   `'running'`. The existing SIGINT/SIGTERM handler in `main.ts` marks
   `'stopped_cleanly'` right before tearing down the reconciliation timer, the
   Kalshi client, and the Redis connection. No row yet (the very first boot
   ever) is not treated as a crash.
5. **Webhook delivery: one retry with a short delay before giving up** (an
   explicit override of the initially-recommended "log and swallow immediately"
   option). Reconciled with this project's standing rule that an auxiliary check
   must never delay or crash the real work it's attached to: every call site
   invokes `sendAlert(...)` **without awaiting it** (fire-and-forget), and the
   retry-with-delay logic lives entirely inside `sendAlert`'s own promise, whose
   rejection is caught internally. The trading code path that triggered the
   alert continues immediately regardless of whether the Slack POST, its retry,
   or both fail.
6. **`SLACK_WEBHOOK_URL` is optional at the environment level, not required.** If
   unset, `sendAlert` logs a warning and no-ops rather than throwing — this keeps
   local development and the automated test suite from ever needing a real
   webhook configured, matching how `KalshiClient`'s optional `db` parameter
   already works. The pre-go-live checklist gains an item to confirm it's set
   before trading with real money.
7. **Message format: plain text, one line, Slack's basic `{"text": "..."}"`
   incoming-webhook body.** No Block Kit, no rich formatting — YAGNI for a
   three-event alert. Each message names the specific signal/ticker/condition and
   the exact command to run after investigating (`npm run clear-breaker` /
   `npm run clear-block <ticker>`), so an operator reading the alert on a phone
   knows the next action without opening a terminal to look it up.

## Architecture

New/changed files:

- **`src/alert.ts`** (new) — `sendAlert(message: string): Promise<void>`. Reads
  `SLACK_WEBHOOK_URL` from `process.env` at call time (not at import time, so
  tests can freely set/unset it per-case). POSTs `{"text": message}` as JSON. On
  failure, waits ~2 seconds and retries once; if that also fails, logs loudly via
  `console.error` and resolves (never rejects) — every internal failure path is
  caught inside this function, so no call site ever needs a `.catch()`. No `db`
  dependency, no other side effects.
- **`src/decide/ledger.ts`** (modified) — new `process_lifecycle` table:
  ```sql
  CREATE TABLE IF NOT EXISTS process_lifecycle (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL CHECK (state IN ('running', 'stopped_cleanly'))
  );
  ```
  New functions: `recordProcessStarting(db: Database.Database): boolean` (reads
  the current row if any; returns `true` if it existed and said `'running'`;
  UPSERTs the row to `state = 'running'` either way; returns `false` on first
  boot or after a clean prior shutdown), `recordProcessStoppedCleanly(db:
  Database.Database): void` (UPSERTs `state = 'stopped_cleanly'`).
- **`src/decide/pipeline.ts`** (modified) — around both existing
  `checkFailedOrdersSignal(db, ...)` calls: capture `isTradingHalted(db)` before,
  call the check, capture it again after; if it transitioned `false → true`, call
  `sendAlert(...)` (not awaited) with the breaker-trip message, reading the
  triggering row's `reason` from `circuit_breaker_trips` for the message body.
- **`src/execute/order.ts`** (modified) — same pattern around
  `reconcilePendingOrders`'s `checkFailedOrdersSignal(db, ...)` call.
- **`src/execute/reconcileOpenPositions.ts`** (modified) — same
  before/after-`isTradingHalted` pattern around `checkDivergencesSignal(db)`;
  additionally, alert on the market-block condition itself when
  `!wasAlreadyBlocked` (already computed by slice 6's fix), independent of
  whether that particular block also happens to trip the divergences breaker.
- **`src/main.ts`** (modified) — calls `recordProcessStarting(db)` immediately
  after `openLedger(...)`, alerting if it returns `true`; the existing shutdown
  handler calls `recordProcessStoppedCleanly(db)` before tearing down the
  reconciliation timer, `kalshiClient`, and the Redis client.

## Data flow

```
main() startup:
  db = openLedger(...)
  if (recordProcessStarting(db)):
    sendAlert('[UNCLEAN-EXIT] process restarted after an unclean exit. ...')
  ... existing startup reconciliation, consumer loop ...

main()'s SIGINT/SIGTERM handler (existing):
  recordProcessStoppedCleanly(db)
  ... existing teardown: clearInterval, kalshiClient, redis, db.close() ...

pipeline.ts / order.ts, around each real resolveOrder call site:
  const wasHalted = isTradingHalted(db)
  checkFailedOrdersSignal(db, status)
  if (!wasHalted && isTradingHalted(db)):
    sendAlert('[CIRCUIT-BREAKER-TRIPPED] signal=failed-orders reason=... ' +
              'Run npm run clear-breaker after investigating.')

reconcileOpenPositions.ts, in the divergence branch:
  const wasAlreadyBlocked = isMarketBlocked(db, marketTicker)   // slice 6's existing guard
  blockMarket(db, marketTicker, reason, expected, real)
  if (!wasAlreadyBlocked):
    sendAlert('[RECONCILE-DIVERGENCE] market_ticker=... reason=... ' +
              'Run npm run clear-block <ticker> after investigating.')
    const wasHalted = isTradingHalted(db)
    checkDivergencesSignal(db)
    if (!wasHalted && isTradingHalted(db)):
      sendAlert('[CIRCUIT-BREAKER-TRIPPED] signal=divergences reason=... ' +
                'Run npm run clear-breaker after investigating.')
```

## Testing plan

Matching this project's standing law — every value that travels through this
system needs a test driving the real call site, not just the function in
isolation:

- **`sendAlert`**: a mocked `fetch` failing once then succeeding confirms exactly
  one retry, not zero and not more; failing twice confirms it logs and resolves
  without throwing; `SLACK_WEBHOOK_URL` unset confirms a no-op with a warning log
  and no fetch call at all.
- **Process lifecycle**: `recordProcessStarting` on a fresh ledger (no row)
  returns `false`; called again without an intervening
  `recordProcessStoppedCleanly` returns `true` (simulating a crash); after
  `recordProcessStoppedCleanly`, the next `recordProcessStarting` returns `false`
  again.
- **Breaker-trip alerting**: driving the real `checkFailedOrdersSignal`/
  `checkDivergencesSignal` call sites to cross their thresholds (reusing slice
  6's existing test fixtures) confirms exactly one `sendAlert` call at the
  crossing, and confirms a SECOND already-tripped event (same signal, still
  open) does not alert again.
- **Market-block alerting**: a genuinely new block alerts; a re-block of an
  already-blocked ticker (the exact scenario slice 6's fix addressed) does not
  alert again.
- **No automated test ever posts to a real Slack webhook** — every test mocks
  `fetch`, matching the existing testing posture for `KalshiClient`/
  `fetchMarketStatus`.

## Credential hygiene / non-negotiables reaffirmed

- `SLACK_WEBHOOK_URL` follows the exact same hygiene rules as every Kalshi
  credential: read from an environment variable, added to `.gitignore`'d `.env`
  before any code references it, never hardcoded as a fallback default.
- No market-specific keyword/rule/resolution-condition logic is introduced —
  this slice only observes existing safety-mechanism state (breaker trips,
  market blocks, process lifecycle) and reports it; it makes no trading
  decisions and touches no order-placement logic.
- Entry-only scope is unaffected; this is pure observability layered on top of
  mechanisms slices 5 and 6 already built, with zero new authenticated Kalshi
  API surface.
