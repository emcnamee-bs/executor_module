# Kalshi Execution Client — Design (Slice 4)

## Goal

Slice 3 (the decision engine) ends at a durably-recorded would-trade-or-skip
decision in a local SQLite ledger; it never places a real order. This slice
adds the missing last step: given a `wouldTrade: true` sizing result, place a
real Kalshi order and durably record what actually happened to it.

This slice is **entry-only**, matching slice 3's own scope decision: it opens
positions. It never closes, cancels an already-resting, or exits one early.
Positions are held to Kalshi's own weekly settlement. Exit/close logic, if
ever wanted, is a future slice with its own brainstorm.

Real money moves once this slice ships, by default (matching HANDOFF.md's
stated intent: "nothing here is a simulation by default"). A `DRY_RUN`
switch exists for deliberate opt-in testing before that point, not as the
shipped default behavior.

## Prior art surveyed (per this project's non-negotiables)

Before designing this from scratch, four sibling projects under `~/Downloads/`
were surveyed for a reusable, already-signed Kalshi client:

- **`kalshi-spine`** — the canonical, currently-live, correctly-signed client
  (`node/kalshiClient.js`). RSA-PSS/SHA-256 request signing, targets the
  *current* `POST /portfolio/events/orders` endpoint, has a built-in
  `DRY_RUN` simulated-fill switch, and good credential hygiene (env/`.env`
  only, `.gitignore`d keys, never committed). This is the client this slice
  ports from — plain CommonJS with zero deps, so it's re-implemented in
  TypeScript rather than imported as-is (see Decision 1 below).
- **`Fast99Follower`** — vendors `kalshi-spine`'s client byte-identical, and
  layers a real, production-proven execution module on top of it
  (`src/executor.js`): idempotency against already-resting orders, a
  spend-cap veto callback immediately before each live call, and a
  deterministic `client_order_id` (MD5 hash) for dedupe-safe retries. Its own
  incident log documents a real production bug — the *legacy*
  `POST /portfolio/orders` endpoint was deprecated and started returning
  `410` — fixed by migrating to the current endpoint. This project's
  execution design borrows the idempotency/veto/deterministic-id patterns.
- **`InsiderTradeFollower`** and **`Personal_Fingerprinter`** — both still
  target the deprecated, now-broken `POST /portfolio/orders` endpoint for
  order placement. **Not reused as a source for order-placement code.**
  InsiderTradeFollower's separate (read-only) `HistoricalClient` has a real
  exponential-backoff-with-jitter-and-`Retry-After` pattern worth reusing for
  this slice's retry policy, even though it's never been applied to order
  placement anywhere.

## Decisions made during brainstorming

1. **Port `kalshi-spine`'s signing/HTTP logic to native TypeScript**, rather
   than a git submodule + CJS/ESM interop, or a raw file copy. Loses
   automatic upstream bugfixes; gains type safety and consistency with the
   rest of this strict-TS/ESM codebase.
2. **Execution is inline in `runDecisionPipeline`** — after `evaluateSizing`
   returns `wouldTrade: true`, the same async call places the order and
   records the outcome. No separate poller process.
3. **`DRY_RUN` is wired in from day one, default OFF.** `KALSHI_DRY_RUN=true`
   simulates a fill instead of calling the exchange, for a first manual
   smoke test before going live. Neither `DRY_RUN` nor unset is the same as
   `EXECUTOR_TRADING_HALTED` (the existing kill switch) — the kill switch
   still means "make no decision at all," checked first, before any model
   call, unchanged from slice 3.
4. **Order type: IOC limit at `sizing.entryPriceCents`.** Never rests on the
   book — fills up to available depth immediately or cancels the remainder.
   The price/depth picture `evaluateSizing` validated can't go stale waiting
   for a fill.
5. **A new `orders` table, separate from `decisions`.** `decisions` is
   updated in place to reflect the *actual* fill (not the originally sized
   amount) before it's considered resolved; `orders` is the append-only
   audit trail of every order attempt (requested vs. filled, status,
   timestamps).
6. **`would_trade` reflects the outcome, not the decision.** A 0-fill order
   flips `would_trade` to `0` before the row is considered resolved — this
   keeps `hasOpenPosition` and the exposure-cap trigger meaning exactly what
   their names say ("a real position exists"), with no added caveat. The
   fact that the engine *decided* to trade is still fully auditable via the
   decision's own `direction`/`magnitudePts`/`reasoning` fields plus the
   `orders` row's `requested_contracts`.
7. **Ambiguous HTTP failures (timeout, connection reset, 5xx after retries)
   are never guessed at.** A deterministic `client_order_id` (hash of
   `item_id` alone) lets the client query `getOrders`/`getFills` for ground
   truth before recording anything. Fail closed: if genuinely not found,
   record `status: 'unknown'`, contracts 0, notional 0 — never assume a fill
   that can't be confirmed.
8. **Bounded retry: 3 attempts, exponential backoff + jitter, honors
   `Retry-After`** — tighter than InsiderTradeFollower's `HistoricalClient`
   precedent (`maxRetries = 4`), since each retry re-submits against an
   aging price/depth picture. Reconciliation (point 7) runs after the bound
   is exhausted, not resubmission.
9. **Entry-only scope** (see Goal) — no exit/close/cancel-a-resting-order
   logic in this slice.
10. **A third, independent exposure-cap check immediately before the live
    Kalshi call** — re-queries `totalExposureCents(db, eventTicker)` and
    aborts (`declined-at-execution`, no Kalshi call) if this order would
    breach $40, even though `evaluateSizing` already checked this moments
    earlier in the same call. Matches this project's established
    defense-in-depth pattern (sizing.ts's `contractsWithinCaps` + the
    ledger's DB-level CHECK/trigger, both already redundant on purpose).
11. **Crash-safe ordering: write a `pending` decision row *before* calling
    `placeOrder`.** `recordDecision` gains an update-in-place capability.
    The pending row's existence alone is what makes I4's existing
    `hasDecisionForItem` dedup cover the entire execution step, the same way
    it already covers every other outcome — no new dedup mechanism needed.
12. **Orphaned pending rows are reconciled automatically at startup**, using
    the exact same `client_order_id`-lookup reconciliation function that
    ambiguous mid-request failures use (point 7). A pending row can never
    survive past the next process start.

## Architecture

New/changed files:

- **`src/execute/kalshiClient.ts`** (new) — signing + HTTP calls. Ported
  from `kalshi-spine`'s `node/kalshiClient.js`: `_sign(timestampMs, method,
  path)` (RSA-PSS/SHA-256, `KALSHI-ACCESS-KEY/TIMESTAMP/SIGNATURE` headers,
  message = `${timestampMs}${METHOD}${pathname}`), `createOrder`,
  `cancelOrder` (present for completeness/future use, not called by this
  slice), `getOrders`, `getFills`, `getBalance`, `getPositions`. Fixed
  request-interval throttle matching `kalshi-spine`. `KALSHI_DRY_RUN`
  env-gated simulated-fill path in `createOrder`.
- **`src/execute/order.ts`** (new) — order-placement orchestration:
  `buildOrderBody`, `deriveClientOrderId(itemId)`, `placeOrder(decision,
  deps)` (final exposure recheck → build body → DRY_RUN check → retry loop →
  reconcile-on-failure), `reconcileOrder(client, clientOrderId)` (shared by
  both the mid-request-failure path and startup pending-row recovery).
- **`src/decide/ledger.ts`** (modified) — new `orders` table; `decisions`
  gains `order_status`; `recordDecision` supports an update-in-place variant
  (`resolveDecision`, or similar — exact naming decided at plan time); new
  `reconcilePendingOrders(db, client)` scanning for `order_status='pending'`
  rows.
- **`src/decide/pipeline.ts`** (modified) — after `evaluateSizing` returns
  `wouldTrade: true`: write the pending row, call `placeOrder`, then resolve
  the row with the real outcome. Every other branch (kill switch, rumor,
  verify-rejected, ladder-null, dedup, should-trade-false,
  `evaluateSizing`-declines) is unchanged from slice 3.
- **`src/main.ts`** (modified) — at startup, after the existing Redis PEL
  drain and before `runOnce` begins consuming, call
  `reconcilePendingOrders(db, kalshiClient)`.
- **`scripts/smoke.ts`** (new, manual-run only, not part of the automated
  suite) — read-only `getBalance`/`getPositions` check against the real
  Kalshi API, no order placement, matching Fast99Follower's `scripts/smoke.js`
  pattern. Run once before ever unsetting `KALSHI_DRY_RUN`.

## Data flow

```
evaluateSizing(...) -> { wouldTrade: true, contracts, entryPriceCents, notionalCents, ... }
  |
  v
recordDecision(db, { ...sized values, would_trade: 0, order_status: 'pending' })
  |  <- I4's hasDecisionForItem now covers everything from here on;
  |     a crash here just means this row is picked up by reconcilePendingOrders next boot
  v
placeOrder(decision, deps):
  1. re-check totalExposureCents(db, eventTicker) + notionalCents <= 4000
     -> breach: resolve decision as declined-at-execution, STOP (no Kalshi call)
  2. build IOC-limit order body at entryPriceCents; client_order_id = hash(item_id)
  3. KALSHI_DRY_RUN=true -> simulate a fill, skip to step 5
  4. createOrder(...), retry up to 3x (exp backoff + jitter, honors Retry-After)
     on 429/5xx; on final failure or any ambiguous error -> reconcileOrder(...)
  5. write `orders` row (requested/filled/avg_price/status)
  |
  v
resolve decisions row: would_trade = (filled_contracts > 0),
                        contracts/entryPriceCents/notionalCents = ACTUAL fill,
                        order_status = 'resolved'
```

At `main()` startup (after existing Redis PEL drain, before stream
consumption resumes):

```
reconcilePendingOrders(db, kalshiClient):
  for each decisions row WHERE order_status = 'pending':
    reconcileOrder(client, row.client_order_id)  -- same function as above
    resolve the row with whatever's actually true (found filled/partial/unfilled, or
    genuinely never placed -> 'unknown', 0 contracts)
```

## Ledger schema

`decisions` table additions (all other columns unchanged from slice 3):

```sql
ALTER TABLE decisions ADD COLUMN order_status TEXT NOT NULL DEFAULT 'resolved'
  CHECK (order_status IN ('pending', 'resolved'));
```

(Existing slice-3-only rows, if any existed, would all be `'resolved'` by
default — moot in practice since no ledger DB predates this branch, per
slice 3's final adjudication.)

New `orders` table:

```sql
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  client_order_id TEXT NOT NULL UNIQUE,
  kalshi_order_id TEXT,
  requested_contracts INTEGER NOT NULL CHECK (requested_contracts > 0),
  filled_contracts INTEGER NOT NULL DEFAULT 0 CHECK (filled_contracts >= 0),
  avg_fill_price_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'filled', 'partial', 'unfilled', 'rejected', 'error', 'unknown',
    'declined-at-execution'
  )),
  error_detail TEXT,
  placed_at TEXT,
  resolved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

`client_order_id` is `UNIQUE` and derived from `item_id` alone (not decision
content) — this is what makes both Kalshi's own dedup and this project's
reconciliation lookup correct across a crash-and-redeliver, independent of
whether a re-run would compute a different decision.

Both the exposure-cap trigger and `hasOpenPosition` continue to key off
`decisions.would_trade = 1` exactly as slice 3 built them — no change to
their queries, since `would_trade` now only ever becomes `1` once a fill is
confirmed.

## Testing plan

Matching this project's standing law — every value that travels from a
decision to an order needs at least one test driving the real call site,
not just the function in isolation:

- **Signing** (`kalshiClient.ts`): unit-tested against a real generated RSA
  key pair, verifying the signature cryptographically (same technique as
  InsiderTradeFollower's `orderClient.test.ts`).
- **Order building / retry / reconciliation** (`order.ts`): unit-tested with
  a mocked HTTP layer. Required cases: full fill, partial fill, zero fill,
  a rejected order, 429-then-success-within-the-retry-bound,
  retries-exhausted-then-reconciliation-finds-the-real-fill,
  retries-exhausted-then-reconciliation-finds-nothing (genuinely never
  placed), and the final-exposure-recheck declining before any HTTP call is
  made at all.
- **Pipeline integration** (`pipeline.ts`): a real SQLite ledger (temp file,
  `openLedger`), Anthropic calls mocked (as slice 3 established),
  `placeOrder` mocked at the pipeline-test level but exercised for real in
  `order.test.ts`. Must include: a test proving the pending-row-first
  ordering (write pending → simulate a crash before `placeOrder` resolves →
  confirm the row is picked up correctly by `reconcilePendingOrders`, not
  re-decided from scratch).
- **`reconcilePendingOrders`** (`ledger.ts` or `order.ts`, wherever it lands
  at plan time): a real SQLite ledger with a hand-inserted `pending` row,
  mocked Kalshi client, asserting the row resolves correctly for each of:
  found-and-filled, found-and-unfilled, genuinely-not-found.
- **No automated test ever places a real order.** The only real-API contact
  point is the manual `scripts/smoke.ts`, run by a human, read-only, before
  ever unsetting `KALSHI_DRY_RUN`.

## Credential hygiene (per this project's non-negotiables, unchanged)

- `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY_PATH` read from env or a
  git-ignored `.envrc`/`.env` — same convention `kalshi-spine` and this
  project's existing `ANTHROPIC_API_KEY` already use.
- No hardcoded key ID or path as a fallback default, anywhere.
- `.gitignore` entries for any credential-adjacent path (e.g. a local
  `kalshi_key.pem` if ever copied into this repo, though the preferred
  pattern — matching `Personal_Fingerprinter`'s corrected approach — is to
  point `KALSHI_PRIVATE_KEY_PATH` at a key stored outside any git working
  tree) are added *before* any credential-adjacent code is written, not
  after.
- Never commit `-----BEGIN` content under any filename.

## Non-negotiables reaffirmed

- Nothing in this slice touches `Internet_Info_Plug` — Fast99Follower's code
  was read for design inspiration only, per HANDOFF's existing framing that
  reading (not modifying) sibling projects is fair game.
- No market-specific keyword/rule/resolution-condition logic is introduced
  here — this slice is pure execution mechanics on top of slice 3's already
  market-agnostic sizing output.
- The manual kill switch (`EXECUTOR_TRADING_HALTED`) is unchanged and still
  checked first, before any model call — this slice adds no new kill-switch
  logic, since the existing one already gates everything upstream of
  `evaluateSizing`.
