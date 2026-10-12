# Exit review (paper sells on adverse news) — design

Date: 2026-10-12. Status: draft for review. Scope: paper units only.

## 1. Purpose

The executor is entry-only (`2026-08-25-decision-engine-design.md`: "no selling, no exit logic").
In practice a held position keeps its full downside while news that should move the market
against it is read, judged for *entry*, and discarded (observed 2026-10-09..12 on KXWTI: about
25 bearish items evaluated, all `no-trade`, position held to a loss).

This slice adds an **exit review**: an agent reads each relevant item against every held
paper position and sells when that single item is expected to cost more than 2% of the
position's cost basis, before the price drop, as early as the sell trigger allows. If the
sell happens after the market already moved, it is logged as late; it still sells.

Success criteria:

1. For a held position, an adverse item whose confidence-weighted expected loss exceeds
   max(2% of cost, cost of exiting now) produces a simulated sell fill within one review
   cycle (target: seconds after the item reaches the gate, not after entry triage/decide).
2. Every review (sell or hold) is auditable: inputs, model output, the numbers, the verdict.
3. Lateness is measured and logged on every exit without ever delaying the sell.
4. Wall and settlement accounting stay correct for partially or fully exited positions.
5. Nothing here can place a real order; the live unit cannot run with this enabled.

Out of scope: exits on the live unit; adding to or averaging positions; favorable-news logic;
full order-book walking; changing entry logic; profile rebuild automation.

## 2. Trigger

**When it runs.** In `runDecisionPipeline`, immediately after the relevance gate passes (or
for direct-source items, which skip the gate), if the trade has at least one open paper
position (`paper_positions` with side set, unsettled, remaining contracts > 0), the exit
review starts **in parallel** with entry's triage -> decide. It does not wait for them and is
not blocked by entry-only guards: rate limit, trust rung, "story already has an open
position", and circuit-breaker / kill-switch (those stop new entries, never risk reduction).
It is not run for items the gate rejects.

**Inputs per (item, position):** item text (the excerpt the gate sees, plus the fetched
article as for decide), source tier and publish time; the position (market, side, contracts,
entry); the current ladder (bids, asks, sizes) from `fetchActiveLadder`; the market's recent
price trajectory (marks at -5, -15, -60 minutes from Kalshi candlesticks, best effort).

**Model output (structured, validated, new `exit_review` AiStage):** `shift` (signed, in the
profile's `magnitudeUnit`, capped by `maxMagnitude`), `confidence` in [0,1] that the item is
real, material and **not already reflected in the price shown**, and a one-line `reason`.
The model never outputs "sell".

**Pure decision function** `evaluateExit(position, ladder, review)` (no I/O):

1. `fair_after` = the existing sizing curve (`buildProbabilityCurve` / `buildThresholdCurve`)
   shifted by `shift`, read at this position's contract and side.
2. `mid` = mid of the held side's bid/ask; `L = confidence * max(0, mid - fair_after)` per
   contract.
3. `X = mid - bid` of the held side (half-spread) plus `EXIT_FEE_CENTS` (default 0; P&L is
   gross of fees).
4. **Sell iff** `L * remaining > 0.02 * cost_basis` **and** `L > X`. `cost_basis` is
   `contracts * entry_price_cents` of the whole original position. A missing bid never blocks
   a trigger (the sell becomes pending/unsellable, section 3).

Thresholds are named constants (`EXIT_LOSS_FRACTION = 0.02`) so they can be tuned without
touching other code.

## 3. Sell mechanics (paper)

- Trigger -> attempt a fill immediately at the touch: YES sells at `yes_bid`, NO sells at
  `100 - yes_ask`; the fill is capped at the shown top-of-book size (`yesBidSizeContracts` /
  `yesAskSizeContracts`).
- No bid: status `unsellable`. Partial fill: the remainder stays pending.
- **Pending-exit retry timer** (in-process, default 20 s, only active while a pending exit
  exists): refetch the ladder, fill up to the bid size, repeat until fully sold or the market
  closes. At close the unsold remainder is held to settlement and logged
  `held_to_settlement`. Retries are throttled (Kalshi's public API returns 429 when hit about
  40 times quickly).
- Idempotency: reviews are keyed (item_id, position_id); redelivered stream entries are
  no-ops.
- A position that has had a sell trigger is not re-bought in the same market for that event
  (entry dedupe consults exits).

## 4. Records

All in the trade's own `decisions.db` (`CREATE TABLE IF NOT EXISTS`, additive; no migration of
existing tables).

- `paper_exit_reviews(id, created_at, trade, item_id, position_id, shift, confidence, reason,
  mid_cents, fair_after_cents, loss_cents, exit_cost_cents, verdict ['sell'|'hold'|'error'],
  verdict_reason, lag_json)`: one row per review. `lag_json` holds source_publish_ts,
  first_seen_ts, emitted_ts, review_started_at, model_returned_at, first_sell_attempt_at.
- `paper_exits(id, created_at, position_id, review_id, contracts, price_cents, pnl_cents,
  status ['filled'|'partial'|'unsellable'|'held_to_settlement'], filled_at, late,
  late_json)`: one row per simulated fill. Pending state is derived:
  remaining = contracts - sum(fills).
- `ai_calls` gets `stage='exit_review'` (extend `AiStage`).

## 5. Lateness (never on the sell path)

After a fill, a background step fetches candlesticks and writes to `paper_exits.late_json`:
price at source publication, at review start, at fill; `late = true` iff the held-side mark at
review start was already below the publication-time mark by more than the 2% trigger;
`cents_lost_to_lateness = (mark_at_publication - fill_price) * contracts`. It also emits one
`[EXIT LATE]` log line. If candlesticks are unavailable the fields are null and the lag chain
is still recorded. The model prompt receives the price trajectory so it can judge "already
priced in", which is also what prevents double-counting a move the ladder baseline already
contains.

## 6. Accounting

- `settlePaperRows` (`src/paper/score.ts`) scores only the remaining contracts.
- Wall publisher (`~/wall/paper-grid-publish.py`, `paper_return`): realized = settled P&L +
  sum of exit P&L; unrealized = remaining contracts at mark; denominator = full original
  cost. Tests updated; `paper-grid-2-publish.py` is disabled and untouched.

## 7. Failure behaviour and safety

- Model/API error: no sell, a `verdict='error'` row, and a Slack alert via the existing
  `alert.ts` (fire-and-forget). No silent skip.
- Review budget: `EXIT_DAILY_USD_CAP` (default generous) **alerts but does not stop reviews**.
- Feature flag per unit (systemd drop-in, like `haiku-gate.conf`): `EXIT_REVIEW=on`.
  Default off.
- Paper-only, enforced at call sites: requires `KALSHI_DRY_RUN === 'true'` and
  `EXECUTOR_LIVE_TRADE` unset, re-read per review (same defence as
  `lowTierRelaxationAllowed`); startup refuses `EXIT_REVIEW=on` on a live-capable process.

## 8. Testing and rollout

1. Unit: `evaluateExit` table tests (threshold boundary, spread guard, confidence weighting,
   yes/no sides, threshold and band curves, missing bid).
2. Unit: fill logic (touch price, size cap, partial, unsellable, retry, close).
3. Unit: accounting (`settlePaperRows` remainder, wall `paper_return` with exits).
4. Integration with fake Anthropic/Kalshi clients: parallel start, entry guards not
   blocking, idempotent redelivery, error path.
5. **Backtest** (read-only script): replay the logged items in the kxwti, kxaaagasw and
   kxtrumpact ledgers against their historical positions; report what would have sold, when,
   at what price, and the P&L difference. Used to tune the prompt and constants before
   enabling anything.
6. Enable on kxwti, kxtrumpact, kxaaagasw first; widen to all paper units after review.

## 9. Open items for the plan stage

- Exact candlestick endpoint/params and its history granularity (verify against the live API).
- Whether `EXIT_FEE_CENTS` should default to Kalshi's real fee formula once P&L is net.
- Review concurrency when several positions are held on one trade (sequential vs parallel).
