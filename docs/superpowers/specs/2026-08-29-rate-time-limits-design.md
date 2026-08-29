# Rate / Time Limits — Design (Slice 9)

## Goal

`MAX_TOTAL_EXPOSURE_CENTS` caps how much money can ever be at risk at once,
and this system's circuit breakers (slice 6) halt on abnormal *failures* —
but nothing limits how *fast* the system can deploy that exposure budget in
the first place. A burst of correlated signals (a single news event
triggering several keyphrase matches across different sources in the same
few minutes) could see the full exposure cap committed almost instantly, with
every individual trade perfectly within budget and no failure anywhere to
trip a breaker on. This slice adds a simple pacing limit — at most N real
trades within a rolling T-minute window — so a human has time to notice an
unusual burst before the whole exposure budget is already spent, not after.

This slice is scoped narrowly to exactly this: a rolling-window cap on real
trade frequency. It is explicitly **not** a cooldown-after-a-loss mechanism
(considered during brainstorming, and now buildable thanks to slice 8's P&L
tracking, but deliberately deferred as a separate future slice) and **not** a
flat minimum-spacing rule between any two trades (also considered and
deferred) — both were raised and set aside to keep this slice narrowly about
one specific, well-understood risk: a burst compounding faster than a human
can react.

## Decisions made during brainstorming

1. **What counts: only real fills (`would_trade = 1` rows), not every order
   attempt.** The limit is meant to pace actual capital deployment, not
   decision-making or exchange-interaction activity — a rejected order or a
   `would_trade = false` decision (no edge, exposure declined, rate-limited
   itself) does not count toward the window. This also means the check is
   self-consistent: a rate-limited decision doesn't itself count against the
   very limit that rate-limited it.

2. **Response: decline that one decision only, matching the exposure cap's
   existing pattern — not a circuit breaker.** Hitting this limit is not a
   sign anything is broken; it is the system correctly pacing itself. The
   decision resolves as `would_trade: false` with a clear reason, exactly
   like every other skip already recorded in this pipeline (no edge, exposure
   cap, market blocked). No manual clear script, no global halt — but a burst
   of genuinely good signals is NOT queued or deferred either: every signal
   past the first real trade in a window is declined outright, as a
   permanent resolved skip row, and is never replayed. If the underlying
   story keeps producing genuinely NEW signals after the window rolls past,
   those trade normally — but nothing here spreads out or catches up on what
   was already declined.

3. **Single check, not the exposure cap's dual before/after pattern.** The
   exposure cap's second check (immediately before the live order call) is
   redundancy against a wiring/caller bug — `order.ts`'s own comment
   describes it as "redundant with evaluateSizing's own check moments
   earlier," matching this project's established defense-in-depth pattern —
   not a guard against two concurrent decisions racing past the first check.
   The race that actually matters for the exposure cap is closed at the DB
   layer, by the `enforce_total_exposure_on_resolve` trigger, which SQLite
   evaluates inside the write regardless of who raced to get there.

   This system processes exactly one Redis stream entry at a time,
   sequentially, awaiting the full pipeline — including any model calls —
   before accepting the next entry (confirmed by this codebase's own
   consumer-loop design), so within one process no second decision can ever
   be in flight to slip past a single rate-limit check between here and the
   live call. One check is sufficient IN THAT PROCESS, and adds no risk a
   second recheck would close.

   This reasoning rests on an unstated premise worth naming explicitly: it
   holds only for a single consumer process sharing this ledger.
   `EXECMOD_CONSUMER_NAME` exists precisely because a second consumer is at
   least contemplated, and unlike the exposure cap, this limit has no
   DB-level trigger closing a cross-process race — two processes reading the
   same ledger could each see count 0 and each place a real trade in the
   same window. Not a defect in today's single-instance deployment, but a
   premise to revisit before ever running two consumers against one
   `decisions.db`.

4. **Checked EARLY, before any model call — not colocated with sizing.**
   Unlike `hasOpenPosition` (which needs the active ladder's `eventTicker`
   and therefore can't run until after the ladder fetch) or the exposure cap
   (which is inherently part of sizing), the rate limit depends on nothing
   but the ledger's own recent `decisions` rows — it can be evaluated before
   `synopsize`/`verifySynopsis`/`decideTrade` ever run. Checking it there,
   right after the existing kill-switch/circuit-breaker check and the
   `rung === 'rumor'` skip, avoids spending real Haiku/Sonnet API cost on an
   item that would just be declined later anyway — matching this pipeline's
   existing philosophy of skipping as early as possible once an outcome is
   already determined.

5. **Threshold: 1 trade per 15 minutes, global (not per-event).**
   `MAX_TOTAL_EXPOSURE_CENTS` (4000 cents) divided by
   `MAX_NOTIONAL_CENTS_PER_TRADE` (1000 cents) already caps this system at 4
   trades ever reaching full exposure for one event — this limit's real job
   is slowing the *pace* of getting there, not adding a second, redundant
   count cap. At 1-per-15-minutes, a burst of 3-4 correlated signals firing
   within a couple of minutes of each other trades only its first signal;
   the rest are declined outright as soon as they're seen, not deferred —
   whatever fraction of the exposure budget they would have spent is simply
   never deployed unless the underlying story keeps producing genuinely NEW
   signals after the window rolls past. A real burst therefore deploys AT
   MOST 1 trade per 15 minutes of the exposure budget, not "the same signals
   eventually all trade 45 minutes apart." Scoped globally
   (across all events/markets), not per-event like the exposure cap: pacing
   is a behavioral question ("is the system firing off trades too fast right
   now?") independent of which event a trade happens to be on, and this
   system only ever trades one market series in practice regardless.

## Architecture

New/changed files:

- **`src/decide/ledger.ts`** (modified) — two new exported constants
  alongside the existing `MAX_NOTIONAL_CENTS_PER_TRADE`/
  `MAX_TOTAL_EXPOSURE_CENTS`: `MAX_TRADES_PER_WINDOW = 1`,
  `RATE_LIMIT_WINDOW_MINUTES = 15`. One new function:
  `recentTradeCount(db: Database.Database, windowMinutes: number): number` —
  a single `SELECT COUNT(*) FROM decisions WHERE would_trade = 1 AND
  created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)` query (matching the
  existing window-query style already used by `checkFailedOrdersSignal`/
  `checkDivergencesSignal` from slice 6), parameterized by `-{windowMinutes}
  minutes`. No new table.
- **`src/decide/pipeline.ts`** (modified) — one new check inserted
  immediately after the existing `if (rung === 'rumor') { ...; return; }`
  block and before the `synopsize(...)` call:
  ```typescript
  if (recentTradeCount(db, RATE_LIMIT_WINDOW_MINUTES) >= MAX_TRADES_PER_WINDOW) {
    recordDecision(
      db,
      skipRecord(item, `rate limit: ${MAX_TRADES_PER_WINDOW} trade(s) per ${RATE_LIMIT_WINDOW_MINUTES} minutes already reached`, {
        rung, orderStatus: 'resolved',
      })
    );
    return;
  }
  ```
  No changes to `evaluateSizing`, `placeOrder`, or any other file — this is
  a single early-exit check in the same style as the three skip checks that
  already precede it in this function.

## Data flow

```
runDecisionPipeline (existing, per Redis stream entry -- processed
  sequentially, one at a time):
  if (manualHalt || isTradingHalted(db)): skip, return   -- existing
  if (rung === 'rumor'): skip, return                     -- existing
  if (recentTradeCount(db, RATE_LIMIT_WINDOW_MINUTES) >= MAX_TRADES_PER_WINDOW):
    recordDecision(db, skipRecord(item, 'rate limit: ...', {...}))
    return                                                 -- NEW
  ... synopsize/verifySynopsis/fetchLadder/hasOpenPosition/decideTrade/
      evaluateSizing/placeOrder, all unchanged ...
```

## Testing plan

Matching this project's standing law — every value that travels through this
system needs a test driving the real call site, not just the function in
isolation:

- **The core pacing behavior, driven through the real
  `runDecisionPipeline`**: a first item that results in a real fill
  (`would_trade = 1`), followed immediately by a second item that would
  otherwise also trade — the second declines with the rate-limit reason, and
  critically `synopsize` is never called for it (proving the early-skip
  placement actually saves the model calls it's meant to save, not just that
  the final outcome happens to match).
- **The window actually rolls**: a real fill recorded outside the
  `RATE_LIMIT_WINDOW_MINUTES` window (backdated via raw SQL on `created_at`,
  matching this project's established technique for testing time-window
  behavior) does not count toward the limit — a subsequent item trades
  normally.
- **Only real fills count**: a `would_trade = false` decision (for any
  reason — no edge, exposure declined, or itself rate-limited) does not
  count toward the window; a burst of such non-trading decisions never
  blocks a later item from trading.
- **No new Kalshi API call or credential** is introduced by this slice, so no
  new real-API test posture is needed.

## Credential hygiene / non-negotiables reaffirmed

- This slice introduces no new API surface, no new credential — it counts
  existing `decisions` rows.
- No market-specific keyword/rule/resolution-condition logic is introduced —
  the pacing limit applies uniformly regardless of market content.
- Entry-only scope is unaffected — this slice only ever prevents a *new*
  decision from proceeding; nothing already placed or already filled is
  touched.
