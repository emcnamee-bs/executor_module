# Account Reconciliation — Design (Slice 5)

## Goal

Slice 4 (the Kalshi execution client) places real orders and durably records what
happened to them, but nothing after that point ever checks whether the ledger's belief
about currently-open positions still matches Kalshi's real account state. HANDOFF.md's
own build guidance called for exactly this ("position tracking against the account's
actual state ... not just your own database"), and slice 4 only closed the
crash-recovery gap (orphaned pending rows) — a genuinely open, already-resolved
position can still silently drift from reality afterward (a manual account action, a
bug elsewhere in the system, an unexpected Kalshi-side correction) with nothing ever
noticing.

This slice adds a periodic background reconciliation pass, independent of item
processing, that compares the ledger's believed open positions against Kalshi's real
account state and durably blocks further trading on any market where they disagree —
scoped as narrowly as possible (one `market_ticker`, not the whole system) so a real
divergence stops compounding without interrupting everything else.

This slice is explicitly **not** P&L/settlement-outcome tracking (a distinct future
slice with its own brainstorm) and **not** any form of automatic system-wide circuit
breaker (also a distinct future slice) — those were both raised during brainstorming
and deliberately deferred to keep this slice narrowly about reconciliation correctness.

## Decisions made during brainstorming

1. **Trigger: a periodic timer, independent of trading activity**, not tied to item
   processing and not only-at-startup. Drift can occur while the process is otherwise
   quiet (a manually-cancelled order, a market settling, a bug corrupting the ledger),
   and slice 4's existing startup-only reconciliation (`reconcilePendingOrders`) only
   ever addresses crash-orphaned pending rows, not already-resolved open positions.
2. **Cadence: every 10 minutes.** Frequent enough to catch drift within the same
   trading session on a market that resolves weekly with infrequent, bursty trades;
   infrequent enough to be a trivial addition to Kalshi's rate limits. At most a
   handful of open positions exist at any time given the existing $10/$40 caps, so a
   full pass is light (one `getPositions` call plus one market-status check per
   currently-open, not-yet-settled row).
3. **Comparison scope: per-market position counts only**, not account balance. For
   every `decisions` row the ledger believes is open, compare Kalshi's real signed
   position for that `market_ticker` against the expected signed count derived from
   the row's `side`/`contracts`. Account-balance reconciliation would additionally
   require a "starting balance" baseline and fee/settlement modeling this project
   doesn't have anywhere yet — deliberately out of scope.
4. **Settlement awareness is required for reconciliation to work at all, and it must
   distinguish `closed` from `settled`.** Kalshi markets have three real states:
   `active` (trading) → `closed` (trading stopped, but the position is still real and
   unpaid) → `settled` (a resolved `result`, the position has actually paid out or
   expired worthless). Without this distinction, every position would eventually
   trigger a false-positive divergence the moment its market resolves, since Kalshi's
   real position naturally goes to zero at settlement while the ledger's row still
   expects the original count. A sibling project's own incident log documents getting
   this exact distinction wrong once (treating `closed` as `settled` mismarked every
   not-yet-resolved position as a loss) — this slice must not repeat it. Only a
   genuinely `settled` market (a resolved `result`) is exempted from future
   reconciliation; a `closed`-but-unsettled market is still checked normally.
5. **Settlement handling is scoped narrowly: mark it, stop reconciling, nothing more.**
   Once a market is confirmed `settled`, the corresponding `decisions` row gets a new
   `settled_at` timestamp and is excluded from all future reconciliation passes.
   Capturing the actual win/loss outcome or revenue (via Kalshi's separate
   `/portfolio/settlements` endpoint) is deliberately deferred to a future P&L-tracking
   slice — that endpoint isn't touched here at all, keeping this slice's surface area
   to the market-status check already needed for reconciliation itself.
6. **Divergence response: block future trading on that one `market_ticker` only**,
   not a global kill switch and not a story-level block. This system is entry-only (no
   exit/close logic exists anywhere), so a divergence on an already-placed position
   can't be "stopped" in the usual sense — the only real lever is preventing a *new*
   order from compounding the same unresolved problem. `market_ticker` (not
   `story_key`) is the correct scope because dedup is already keyed on `story_key`,
   which is null for the overwhelming majority of real upstream items — a market-level
   block is what actually stops a second story from independently re-trading the exact
   band already in a known-bad state, while every other market, event, and story
   continues trading completely normally.
7. **A blocked market stays blocked until a human clears it — no automatic expiry, no
   automatic re-check-and-clear.** Matches the existing manual kill-switch philosophy:
   a detected ledger/reality mismatch is exactly the class of problem this project's
   own law is about ("a guard that fires correctly and says something it never
   checked"), and continuing to trade against a market already known to be wrong is
   the one thing this must never do silently. Cleared via a small manual script
   matching the existing `scripts/smoke.ts` precedent — no admin UI exists or is
   warranted for this.

## Architecture

New/changed files:

- **`src/decide/kalshi.ts`** (modified) — this is the existing PUBLIC, unauthenticated
  market-data client from slice 3 (`fetchActiveLadder`), not slice 4's signed
  `execute/kalshiClient.ts`. Gains one new function to fetch a single market's current
  `status`/`result` by ticker. Public market data belongs in this file, not the signed
  client, matching the established file-boundary convention (read-only market data vs.
  authenticated portfolio/order operations stay in separate modules).
- **`src/execute/order.ts`** (modified, or a new sibling module if this grows large —
  decided at plan time) — new `reconcileOpenPositions(db, kalshiClient)`:
  for every `would_trade = 1, settled_at IS NULL` row, checks market status (settled →
  mark `settled_at`, stop; otherwise → compare real vs. expected signed position),
  and on a mismatch, blocks the `market_ticker`. Reuses `positionForTicker` and the
  signed-position convention `signedFillDelta` already established from slice 4 (a
  `side='no'` row's expected signed count is negative, matching Kalshi's own
  convention) — no new sign-handling logic invented here.
- **`src/decide/ledger.ts`** (modified) — `decisions` gains `settled_at TEXT NULL`. New
  `market_blocks` table: `market_ticker TEXT PRIMARY KEY`, `reason TEXT NOT NULL`,
  `expected_contracts INTEGER NOT NULL`, `real_contracts INTEGER NOT NULL`,
  `blocked_at TEXT NOT NULL DEFAULT (strftime(...))`, `cleared_at TEXT NULL`. New
  `isMarketBlocked(db, marketTicker): boolean` (true only when a row exists with
  `cleared_at IS NULL`), `blockMarket(db, marketTicker, reason, expectedContracts,
  realContracts): void`, `markDecisionSettled(db, decisionId): void`.
- **`src/execute/order.ts`** (modified) — `placeOrder` gains a new redundant check:
  `isMarketBlocked(db, input.marketTicker)`, checked alongside the existing
  exposure-cap recheck, before any live Kalshi call. On a block, decline as
  `declined-at-execution` with a reason naming the divergence.
- **`src/main.ts`** (modified) — a 10-minute timer (`setInterval` or an equivalent
  scheduled-loop pattern) calling `reconcileOpenPositions(db, kalshiClient)`,
  independent of `runOnce`'s item-processing loop. An in-memory boolean guard prevents
  a slow pass from overlapping with the next tick (skip, don't queue, if the previous
  pass is still running).
- **`scripts/clear-market-block.ts`** (new, manual-run only, matching
  `scripts/smoke.ts`'s existing pattern) — takes a `market_ticker` as a CLI argument,
  sets `cleared_at` on its `market_blocks` row. Not part of the automated suite.

## Data flow

```
main() startup (unchanged): existing Redis PEL drain, existing
  reconcilePendingOrders/reconcileOrphanedPendingDecisions (slice 4, crash recovery
  for PENDING rows only -- unaffected by this slice)
  |
  v
NEW: setInterval(async () => {
  if (reconciliationInProgress) return;  // overlap guard
  reconciliationInProgress = true;
  try { await reconcileOpenPositions(db, kalshiClient); }
  finally { reconciliationInProgress = false; }
}, 10 * 60 * 1000)

reconcileOpenPositions(db, client):
  for each decisions row WHERE would_trade = 1 AND settled_at IS NULL:
    status = await fetchMarketStatus(row.market_ticker)  -- NEW, src/decide/kalshi.ts
    if status is genuinely settled (a resolved result, not just "closed"):
      markDecisionSettled(db, row.id)
      continue  -- never checked again
    real = positionForTicker(await client.getPositions(), row.market_ticker)
    expected = row.side === 'yes' ? row.contracts : -row.contracts
    if (real !== expected):
      blockMarket(db, row.market_ticker, reason, expected, real)
      console.error('[RECONCILE-DIVERGENCE] ...')  -- loud, for a human to find

placeOrder (existing, slice 4) gains, alongside the existing exposure-cap recheck:
  if (isMarketBlocked(db, input.marketTicker)):
    return { status: 'declined-at-execution', reason: '<market blocked, see market_blocks>', ... }
```

## Testing plan

Matching this project's standing law — every value that travels through this system
needs at least one test driving the real call site, not just the function in
isolation:

- **Settlement detection**: a `closed`-but-not-`settled` market leaves the row
  untouched (still checked next pass); a genuinely `settled` market (resolved
  `result`) sets `settled_at` and is confirmed excluded from a subsequent
  `reconcileOpenPositions` call (mocked client, real ledger).
- **Divergence detection and scoping**: a real mismatch on one `market_ticker` blocks
  only that ticker — a second, unrelated open row on a *different* `market_ticker`
  is confirmed unaffected by the same reconciliation pass.
- **`placeOrder` honors the block**: a would-trade decision targeting an already-blocked
  `market_ticker` declines at execution without any live Kalshi call, alongside the
  existing exposure-cap-recheck test pattern from slice 4.
- **Overlap guard**: a slow mocked reconciliation pass (an artificially delayed
  `getPositions`) confirms a second timer tick during that window is skipped, not run
  concurrently or queued.
- **No automated test ever places a real order** or calls the real Kalshi API — this
  slice adds no new real-API contact point (the market-status check is public/
  unauthenticated, same testing posture as the existing `fetchActiveLadder` tests).

## Credential hygiene / non-negotiables reaffirmed

- This slice introduces no new authentication surface — it reuses the existing signed
  `KalshiClient` (portfolio reads) and the existing public/unauthenticated market-data
  client (market status), both already built.
- Nothing in this slice places, closes, or modifies an order — it only reads Kalshi's
  real state and blocks *future* order placement at the `placeOrder` gate already
  established in slice 4. Entry-only scope is unchanged.
- No market-specific keyword/rule/resolution-condition logic is introduced — this
  slice is pure account-state verification on top of already-decided trades.
- The manual kill switch (`EXECUTOR_TRADING_HALTED`) is unchanged and unaffected by
  this slice's market-level blocking mechanism — the two are independent, redundant
  safety layers at different scopes (whole-system vs. one market).

## Open item to verify during plan-authoring

The exact real-API response shape for a single market's status/result (`GET
/markets/{ticker}` or an equivalent filtered list call, returning `status` and, once
settled, a `result` field) has not yet been confirmed against live Kalshi data the way
slice 3's ladder-fetch fields were. This needs the same live-verification pass before
the implementation plan is finalized, not an assumption carried into code.
