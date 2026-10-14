# US500 perp bot (long/short) — design

Date: 2026-10-14. Status: draft for user review. Nothing here is built.

## 1. Goal

One autonomous bot on mini-mac trades **one instrument, Kalshi `KXUS500PERP`, long or short (or flat)**, at 4x leverage to
start. It reads news from IIP plus market/macro data, and decides when to enter, flip and exit. The user wants leverage raised
later, so every threshold is derived from the leverage `L` and not hardcoded.

Decisions already made with the user:

- Build **only this long/short bot** ("option B"). The earlier long/flat-only bot ("option A") is scrapped. A clone with different
  settings can be added later because the strategy is configuration, not code forks (section 5.4).
- Exit logic must cover: (a) a single story that could drop the market >= 5% -> exit; (b) several days of cumulative bad
  news/data that could drop it >= 5% over a week, including a slow bleed of ~3% that appears to continue -> exit; (c) a realized
  5% loss within a week -> exit. When out of the market the bot waits for IIP/data that points up (long) or, new in this version,
  down (short).
- The user's 5% is a starting point, not a requirement. This spec replaces it with a volatility-scaled stop whose cap is 5% at 4x
  (section 5.2).
- Start with **paper trading**. If real money is needed, the per-bot budget is the minimum that can open one contract at 4x
  (about $3.44 margin; plan on $5), because the $1 the user first proposed cannot open a position at 4x (section 2).

Non-goals: multiple instruments, cross margin, leverage above the governed `L`, Kalshi event-contract trading (the existing
executor does that), any change to IIP or to the existing executor pipeline.

## 2. Verified platform facts (read from Kalshi prod/demo margin API, 2026-10-14)

Source details and probe scripts are in the Claude memory note `kalshi-us500-perp-facts`. Items marked **(verify)** are inferences
that Phase 0 (section 8) must confirm before any live order.

| Fact | Value |
|---|---|
| API | `https://external-api.kalshi.com/trade-api/v2/margin/...`; demo `https://external-api.demo.kalshi.co/...`; same RSA-PSS signing as `src/execute/kalshiClient.ts` |
| Account | `GET /margin/enabled` = true for the executor's prod key; margin balance $0; funding is via the Kalshi UI (transfer endpoint "not yet available") |
| Leverage caps | long 15.32x, short 13.74x (`leverage_estimates`); no per-account tier is visible via the API **(verify with a real order)** |
| Margin model | initial margin = 1.3 x maintenance margin, so maintenance is ~5.0% (long) / ~5.6% (short) of notional; liquidation queue at margin ratio 0.91, liquidation at 1.0 **(verify ratio definition via `/margin/risk` on demo)** |
| Liquidation distance | about `1/L - MM`: ~20% at 4x; ~1.5-1.7% at max leverage |
| Leverage control | **Not an order parameter** (the margin order request has no leverage field). Realized leverage = position notional / equity in the bot's subaccount. The bot controls it by how much collateral is funded there, and it rises as losses reduce equity. The API's "leverage" figures (13.74x / 15.32x, `position_leverage`) are notional / margin requirement, not the bot's leverage |
| Contract | price ~$13.76 = notional per contract; fractional trading off; min position 1 contract; limit $500 notional |
| Cost | taker 0.0072%, maker 0.0012%, spread ~0.006% of notional |
| Funding | once daily at 20:00 UTC; cap +-2%/period; deadband 0.01%; observed 0..0.109%/day; payer side unverified **(verify)** |
| Hours | NOT 24/7: next close Fri 5 pm ET; reopen time not exposed **(verify, incl. any daily break)** |
| Exchange-side stops | `PUT /margin/isolated/positions/{ticker}/exit_trigger`: `bracket` (stop_loss_price, take_profit_price) or `trailing` (trail_bps 1-9999 or trail_amount); closes the whole position, reduce-only |
| Subaccounts | create/transfer endpoints exist; this bot uses its own subaccount so a future second bot cannot net into its position |
| History | the perp is ~8 days old: no usable perp backtest. The index must be proxied from outside data **(verify the perp tracks the S&P 500; contract price/size mapping is unexplained)** |

One contract needs ~$3.44 margin at 4x (price / 4) and ~$1.00 at 13.7x. The budget therefore buys exactly one contract at ~4x with
a small cash buffer. Position size is always **1 contract** in v1.

## 3. Architecture

A new module `src/perp/` in the executor repo (TypeScript/Node, zod, better-sqlite3) with its own entrypoint and systemd unit
`perp-bot.service` on mini-mac. It reuses executor pieces (Kalshi signing, Haiku gate, Slack alerts, circuit-breaker pattern,
Redis consumer for IIP). It does **not** edit the existing entry pipeline, the live executor unit, or IIP (executor `CLAUDE.md`
forbids modifying IIP without the user's go).

```
IIP (Redis stream) --> NewsIntake --> Haiku gate --> Impact extractor (Sonnet, strict JSON)
                                                              |
Collectors (price, vol, rates, calendar, Kalshi event mkts) --> ContextSnapshot (SQLite, every 60 s / 5 min)
                                                              |
                          Quant (pure functions) --> PressureState (decayed, signed) + stats
                                                              |
                          Policy (pure state machine) <-- RiskGovernor (stops, leverage, kill switch)
                                                              |
                               Broker interface: PaperBroker | KalshiMarginBroker (demo | prod)
                                                              |
                                  Journal (every decision + inputs) --> eval (calibration, Brier) --> wall tile
```

Units, each testable alone:

1. **Collectors**: poll their source, write timestamped rows, expose freshness. Independent of IIP, so no IIP changes.
   Sources (each marked `to verify` for free/real-time availability before build):
   perp book/candles/funding/premium (Kalshi margin API, already authorized); S&P 500 level and ES futures; VIX and term
   structure; 2y/10y Treasury yields; high-yield credit spread; dollar index; WTI/gold (also available from Kalshi markets);
   economic calendar (CPI, jobs, FOMC, major earnings in the next 72 h); Kalshi event markets (Fed decision, CPI, unemployment)
   as market consensus for surprise scores.
2. **NewsIntake + gate**: consume IIP items through the same Redis consumer path the executor uses (`src/redis/consumer.ts`),
   keep items the Haiku gate marks relevant to broad US equities.
3. **Impact extractor**: a Sonnet call per gated item, given the item plus the current ContextSnapshot. Returns zod-validated JSON
   only: `direction (up|down|neutral)`, `magnitude_bucket (minor|moderate|major|shock)`, `horizon (intraday|days|week)`,
   `source_credibility 0-1`, `novelty (new|known)`, `already_priced (yes|no|unclear)`, `confidence 0-1`, one-line `rationale`.
   The model never outputs "buy" or "sell" and never does arithmetic (same rule as the existing exit-review design).
4. **Quant** (pure functions, unit-tested): bucket -> expected index move via a calibration table (v1 priors below, refit from
   data later); surprise score `S = (actual - consensus)/sigma_surprise`; VIX-based weekly sigma; decayed pressure; barrier-touch
   probability; liquidation distance; stop/leverage formulas.
5. **Policy**: pure function `(snapshot, pressure, position, risk) -> action + reasons`. No I/O.
6. **RiskGovernor**: computes the stop, effective leverage, and kill-switch state; places and ratchets the exchange-side trigger.
7. **Broker**: one interface (`open`, `close`, `setTrigger`, `position`, `balance`, `risk`). `PaperBroker` simulates fills at the
   prod best bid/ask using the fee, funding and liquidation rules in section 2. `KalshiMarginBroker` talks to demo or prod. Live
   orders require an explicit env gate that is off by default (same pattern as `KALSHI_DRY_RUN` /
   `EXECUTOR_LIVE_TRADE`).
8. **Journal/eval**: every decision row stores the inputs, model JSON, quant outputs, action and reason. Daily snapshot export like
   `~/exit-analysis` so logs outlive the 7-day journal. Tracks Brier score and realized move per magnitude bucket.

## 4. State machine

States: `FLAT`, `LONG`, `SHORT`. One position per instrument; a flip is **close, confirm filled, then open**, never atomic (isolated
margin holds a single side). Every transition writes a journal row.

- `FLAT -> LONG` / `FLAT -> SHORT`: entry rules (5.3).
- `LONG -> FLAT` / `SHORT -> FLAT`: any exit rule (5.1).
- `LONG -> SHORT` (and reverse): exit rule fires, then the opposite entry rule must independently pass; cooldown per 5.5.
- Any state -> `HALTED`: kill switch or stale-data fail-safe. In `HALTED` the bot opens nothing; an existing position keeps its
  exchange-side trigger and the operator is alerted.

## 5. Policy

Default parameters for `L = 4`. All are config with the stated formulas, not constants in code.

### 5.1 Exit ladder (long; the short side mirrors it with up/down swapped)

Evaluated in this order; first match wins. Rules 1-2 are exchange-enforced or code-only so they never depend on the model.

1. **Exchange-side trailing stop (always on).** `trail_bps = s_hard` below the high-water mark since entry (above it for
   shorts). It replaces both "5% below entry" and "5% down from the recent peak" with one native order, so a mini-mac outage
   cannot leave the position unprotected.
2. **Margin guard.** If distance to liquidation (from `/margin/risk`) falls below 2 x `s_hard`, close.
3. **Shock.** One credible, novel item with expected adverse move >= 5% (bucket `shock`, confidence >= 0.7, credibility >= 0.7)
   closes the position. An item in the 3-5% range (bucket `major`) closes half; v1 trades 1 contract, so in v1 this becomes
   "tighten the stop to 1.5 x daily sigma and set a 2-hour re-evaluation" instead of a half close.
4. **Slow bleed.** Close when realized drawdown from the weekly high >= `s_soft` (3%) AND adverse pressure `P` is at or beyond
   the exit threshold AND `P` is not decaying. Price alone never triggers this rule: a 3% touch happens in roughly 15-25% of
   normal weeks, so price-only would churn.
5. **Cumulative pressure.** Close when adverse `P` exceeds `P_exit` for 2 consecutive evaluations (captures "several bad days
   with no single knockout story").
6. **Event and calendar risk.** Before a scheduled high-impact release (FOMC, CPI, jobs) tighten the stop to 1.5 x daily sigma;
   after the market-close timestamp, see 5.6.

### 5.2 Stop and leverage formulas

```
sigma_week = VIX / sqrt(52)                      (index weekly sigma, in %)
s_hard     = clamp(1.75 * sigma_week, 3%, min(5%, B / L))     B = margin loss budget per trade, default 20%
```

- At `L = 4`, `B = 20%`: `B/L = 5%`, so the cap is 5% (the user's number), and the stop floats between 3% and 5% with VIX.
  VIX 16 -> 3.9%; VIX 20 -> 4.8%; VIX >= 21 -> 5%.
- Leverage governor: `L_eff = min(L_target, B / (1.75 * sigma_week))`. When VIX is high the bot **reduces leverage instead of
  widening the stop** (VIX 25 -> ~3.3x). A stop-out costs about `B` of margin by construction.
- Raising leverage later changes `B/L` automatically. It also requires a shorter horizon: with `B = 20%` and a weekly horizon the
  governor will refuse leverage much above ~4.6x. At ~13.7x, liquidation is ~1.5-1.7% away, which is inside one day's noise, so
  the max-leverage design must be an intraday/hours strategy with its own spec; it is out of scope for v1.
- The stop is checked against liquidation: `s_hard` must be <= 50% of `1/L - MM`; otherwise the governor lowers `L_eff`.
- **`L` in these formulas is realized leverage** (notional / subaccount equity). The bot cannot raise it; it can only **refuse to
  enter** when the realized leverage of a new position would exceed `1.05 x L_eff`, and it takes `L` for the stop from that
  realized value. After a loss, equity is lower and realized leverage is higher for the same contract, so the guard can keep the
  bot flat until the operator adds collateral. Funding the subaccount is a manual operator step (the bot never moves money).
  To realize about 4x on one ~$13.76 contract the subaccount holds about $3.44 plus a small fee buffer; $5 realizes ~2.75x.

### 5.3 Entry rules

Preconditions for any entry: state `FLAT`; not `HALTED`; data fresh; not inside a no-trade window (5 minutes either side of a
scheduled high-impact release; the final 30 minutes before the weekly close); the relevant cooldown elapsed (5.5); `L_eff >= 2`.

- **Enter LONG** when `P` (signed, decayed pressure) >= `P_entry_long`, the extractor's confidence >= 0.6, the item is
  `new`, and the **lateness check** passes: the perp has not already moved more than 40% of the expected move in the item's
  direction since its publish time.
- **Enter SHORT** uses the same tests with a **higher bar**: `P_entry_short = 1.25 x P_entry_long`, confidence >= 0.7. Reasons:
  the index has positive drift, short squeezes are sharp, short maintenance margin is higher (5.6% vs 5.0%) and the short
  leverage cap is lower (13.7x vs 15.3x).
- Short-specific: the trailing stop sits above the low-water mark; funding payer side is applied once verified; shorts are never
  held across the weekly close unless `P` strongly agrees (5.6).

### 5.4 Configuration, not forks

The strategy is a config object: `allow_long`, `allow_short`, `L_target`, `B`, `s_soft`, `P_entry_long`, `short_bar`, `tau_days`
(pressure decay, default 2 days), `cooldown_hours`. This bot runs `allow_long = allow_short = true`. A long-only variant is the same
code with `allow_short = false`, which is how a future comparison bot would be created.

### 5.5 Whipsaw control

After any exit, a cooldown applies to **re-entering the same direction** (default 4 trading hours; 24 h after a stop-out), and that
re-entry's threshold is 1.2x the one that opened the closed position. Entering the **opposite** direction right after a news-driven
exit (rules 3-5) is allowed immediately, but only if that entry's own threshold passes; after a price stop-out (rules 1-2) the
opposite direction also waits out the cooldown. Fees are tiny, so this is not about cost; it prevents repeated flips on noisy news.

### 5.6 Weekly close

The market is closed over the weekend, so no stop can execute then. By default the bot is **flat 30 minutes before the weekly
close** unless the aligned pressure is at or above `P_hold_weekend` (default 1.5 x entry threshold). If a position is held across
the close, the trailing trigger remains on the exchange and a Slack message is sent. The reopen gap is logged to calibrate this.

### 5.7 Risk and operations

- **Kill switch:** two stop-outs in 30 days, or margin equity down 30% from its peak, or three consecutive exits within 24 hours
  -> `HALTED` until the operator clears it (same `clear-breaker` pattern as the executor).
- **Fail-safe on staleness:** price or snapshot older than 3 minutes, IIP silent for > 30 minutes, or extractor errors -> no new
  entries; existing position keeps the exchange trigger; Slack alert.
- **Budget:** one subaccount, one contract, notional <= `$500` platform limit; model spend capped per UTC day like the Haiku gate.
  The bot never transfers money between subaccounts or accounts.
- **Mini-mac outage:** the exchange-side trigger is the safety net; on restart the bot reconciles with `/margin/positions`
  before doing anything (same idea as `reconcileOpenPositions.ts`).

## 6. Initial calibration priors (to be replaced by fitted values)

Magnitude bucket -> expected 1-week index move for a credible, novel item: `minor 0.5%`, `moderate 1.5%`, `major 3%`,
`shock 5%+`. Pressure contribution of one item: `s = sign * bucket_move * credibility * novelty_weight * confidence`, decaying
as `e^(-t/tau)`. `P_entry_long` initial 1.5% (equivalent to one credible moderate item or a cluster of minor ones),
`P_exit` 2.0% of adverse pressure. These are guesses until fitted; section 8 gates them.

## 7. Data the model sees

Every extractor and re-evaluation call gets the same JSON `ContextSnapshot`: perp mark/bid/ask, 1d/5d return, realized vol, VIX and
its 1-day change and term-structure slope, 2y/10y yield changes, credit spread change, dollar, oil, gold, funding rate and premium,
the next 72 hours of scheduled events, Kalshi event-market probabilities, current position (side, entry, high-water mark,
distance to liquidation), and the current `P` with its top contributing items. Code computes all statistics; the model reads them.

## 8. Phases and go/no-go

**Phase 0: verify (no orders).** (a) Confirm the perp tracks the S&P 500 and the contract price mapping; (b) confirm the margin
ratio definition and liquidation distance with a demo position and `/margin/risk`; (c) funding sign for longs/shorts;
(d) trading hours and any daily break; (e) that a subaccount is isolated from other positions; (f) data source availability and
latency for each collector; (g) demo account + API key (user-created; the executor's prod key gets 401 on demo). Gate: no unknown
left in section 2's `(verify)` items.

**Phase 1: paper.** `PaperBroker` on live prod prices, plus one demo-exchange rehearsal of orders, trailing trigger and a forced
margin-guard exit. Run at least 4 weeks. Gate is correctness and behavior, not profit: zero ledger/accounting bugs, every exit
traceable to a rule, stale-data and restart reconciliation tested, calibration table fitted from at least the first weeks of
data. The 41-day IIP archive and ~8 days of perp history are too short to prove an edge; the paper run is the real evaluation.
A backtest of the price rules (stops, governor, 3% slow bleed) on long S&P 500 history is done before Phase 1 starts, because
that part does not depend on news.

**Phase 2: live, tiny.** One contract in the dedicated subaccount (~$5 funded), `L = 4`, user approval for the first live order.
Phase 3 (higher leverage) needs its own spec and approval.

## 9. Testing

- Unit tests (vitest) for every Quant function, the stop/leverage formulas at several VIX levels, the state machine
  transitions (including flip ordering and cooldowns), and the weekly-close rule.
- Broker contract tests run the same suite against `PaperBroker` and a recorded-response fake of `KalshiMarginBroker`.
- Replay test: feed a recorded day of snapshots + items and assert the journal's decisions are deterministic.
- Fault tests: stale data, Kalshi 429/5xx, extractor schema failure, process restart with an open position.

## 10. Assumptions and open items

- Language/location: TypeScript in the executor repo under `src/perp/`, new unit, new branch/worktree (the main checkout has
  other sessions' uncommitted files). Spec currently lives in `C:\Users\there\us500-bot` (local, no remote) and moves to the
  executor repo when planning starts.
- Free real-time sources for S&P/VIX/ES may not exist; some collectors may need delayed data, a free-tier API, or the perp's own
  price as the index proxy. Decided per source in Phase 0.
- The user must create the demo account/key and later fund the margin account (about $5).
- Exchange trailing trigger set at entry and kept in sync when `s_hard` changes (the bot cancels and re-sets it); a failed set
  triggers an immediate close, never an unprotected position.
- Short-side parameters (bar 1.25x, weekend rule) are reasoned defaults, not measured.
- The isolated vs cross exit-trigger endpoints differ (`/margin/isolated/positions/...` has no subaccount parameter; the cross
  variant takes `subaccount`). Which one the bot's position uses is a Phase 0 finding; the broker takes it as config.
- Out of scope for the implementation plans: the Grafana wall tile (separate follow-up using the `grafana-wall` skill).
