# Design: Decision Engine (Slice 3 of executor_module)

**Status:** Approved for planning
**Date:** 2026-08-25

## Context

`executor_module`'s full pipeline (`HANDOFF.md` §0) is: news scan → keyphrase
match → Haiku synopsis → Sonnet verify → Sonnet decides the trade → real order
execution. Slice 1 built the Redis-consumer plumbing; slice 2 added keyphrase
matching and the AI-refined phrase list. Neither slice inspects an item's
content beyond a keyword check, and nothing has called Haiku or Sonnet in the
main pipeline yet.

This spec covers **slice 3**: the three model-call stages (Haiku synopsis,
Sonnet verify, Sonnet decide) plus the deterministic decision machinery those
stages feed — rung/confidence, Kelly-fraction sizing, gates, redundant risk
ceilings, and a durable decision ledger. Per HANDOFF.md's own instruction to
"brainstorm the actual decision method with the operator rather than porting
[the sibling project's decide/ module] wholesale," this design was worked out
in a dedicated session with the operator rather than assumed.

**Out of scope for this slice:** placing a real Kalshi order. This pipeline
stops at durably **recording** what it would do — direction, sized contracts,
rung, reasoning — never at acting on it. HANDOFF.md numbers the Kalshi
execution client as a separate build step (§3 step 6) after the decision
method; this spec produces the decision method only. There is consequently no
dry-run-mode design question to resolve here (per HANDOFF §6's own framing) —
nothing capable of placing a real order exists yet, so every decision this
slice produces already is the safest possible dry run.

## A structural gap surfaced during brainstorming

**None of `Internet_Info_Plug`'s 9 currently-configured sources would ever
catch a poll-publication event** — confirmed by reading
`Internet_Info_Plug/config/sources.yaml` directly. The configured sources are
entirely government/regulatory feeds (BLS, Federal Register, State Dept,
OFAC, IAEA — trust_tier 1) and general geopolitics news (Al Jazeera, BBC
World — trust_tier 3; Reddit/Bluesky geopolitics — trust_tier 4). Nothing
watches Rasmussen, Quinnipiac, RealClearPolitics, or any pollster.

This means slice 2's "poll-publication" keyphrase category is currently dead
weight — only the "general political/economic news" category has any real
upstream source feeding it. The operator's explicit choice (per this
brainstorm) is to **design around this reality now** rather than block on
fixing it: this slice is built assuming matches come from general
government/geopolitics/economic news, not poll drops. Closing this gap
(likely a new `iip` page-watcher source pointed at RCP or a specific
pollster, reusing the existing generic `PrimaryAdapter` pattern already used
for OFAC) is explicitly flagged as follow-up work, not part of this spec.

## Decisions carried in from brainstorming

- **Split between LLM judgment and deterministic computation:** Sonnet
  outputs judgment only — direction, a signed point-shift magnitude, an
  explicit `should_trade` boolean, and free-text reasoning. It never outputs
  a dollar amount, a contract count, or the evidentiary rung. All arithmetic
  that determines real position size is deterministic, unit-testable code —
  mirroring the sibling project's `decide/sizing.py`/`gates.py` split, and
  deliberately keeping the highest-stakes arithmetic out of LLM output where
  a hallucinated number could directly cause a bad trade.
- **Rung stays fully deterministic.** Computed from `Item.trust_tier` plus
  corroboration count/`story_key` (fields already present on the `Item` type
  from slice 1) — the same mechanism as the sibling project, adapted below.
  Sonnet never proposes or influences the rung. Sonnet's verify step is a
  separate, independent gate (does the article's content actually support
  the claim), never a confidence score.
- **No `confirmed_sources` shortcut in this version.** HANDOFF.md itself
  calls this "an unprotected privileged surface" in the sibling project and
  says to decide deliberately whether to have one. The operator's choice:
  skip it — rely purely on trust_tier + corroboration for now, add a
  protected version later once real operating experience shows which
  sources (if any) actually warrant it.
- **Ladder-market mapping:** the target market (`KXAPRPOTUS`) is a ladder of
  narrow percentage-band contracts resolving on a snapshot read of
  RealClearPolitics's approval-rating aggregate — not a single yes/no
  contract like the sibling project's markets. Sonnet estimates a **signed
  point-shift** (the dynamic equivalent of the sibling's hand-authored
  `base_move_pts`, produced per-decision instead of pre-written per rule).
  Deterministic code takes the market-implied baseline (from the ladder's
  own current prices) and shifts it by that magnitude to get a fair-value
  estimate, then evaluates Kelly-edge against every band and sizes whichever
  clears the gate thresholds.
- **Entry-only scope, no position management.** This slice decides whether
  to enter a fresh position (or skip) — no selling, no adding to an existing
  position, no exit logic. A story that already has a recorded would-trade
  decision is simply skipped. Exit/adjustment logic (buy more, reduce,
  close — the full "buy, sell, or hold" framing from HANDOFF §0) is
  deliberately deferred to a later slice, once entry logic is proven and
  real positions have accumulated to design exits against.
- **Story dedup is scoped to (`story_key`, active weekly `event_ticker`),
  not all-time.** Since the market resolves weekly with a fresh band ladder
  each cycle, a decision targeting an already-resolved week's event must not
  block a fresh signal on the same ongoing story this week.
- **Risk ceilings (real dollar amounts, chosen by the operator, not
  inherited from the sibling's arbitrary simulation constants):**
  - Per-trade notional cap: **$10** (1,000 cents).
  - Total open-exposure cap: **$40** (4,000 cents) across all currently
    would-traded, undedup'd positions.
  - Both enforced redundantly at multiple layers, mirroring the sibling's
    lesson that a single-layer cap is fragile.
- **Manual kill switch, no auto-trigger.** A checked condition (env var or
  sentinel file), evaluated as the very first gate — before any model calls
  are made, so it also saves API cost when tripped. No automatic
  trigger-on-loss logic in this version; that itself would need careful
  design to avoid false-triggering on noise, and is deliberately deferred.
- **Testing:** a small number of representative end-to-end tests make real
  Haiku/Sonnet API calls (one full happy path, one verify-rejection, one
  `should_trade: false`) — not every permutation, unlike slice 2's
  single-call generator. The deterministic sizing/rung/gates/ledger logic
  (every rung level, every gate-rejection path, both ceilings, the
  story-dedup scoping) gets exhaustive real-call-site testing — real Redis,
  real SQLite ledger — driven by an injected/stubbed synopsis+decision
  object, since that logic's correctness depends only on what the model
  *output*, not on what it actually said.
- **Kalshi market-data reads are public and unauthenticated** — confirmed
  directly against `api.elections.kalshi.com` during this project's earlier
  brainstorming. This slice's first live Kalshi API call (fetching the
  active weekly event's current band-ladder prices) needs no credentials.
  Order placement, which does need signed authentication, remains out of
  scope.

## Adapted from the sibling project's `decide/` package

Reused directly, unchanged in mechanism (all confirmed by reading the
sibling's actual source, not just its docs):

- **Rung enum and stakes** (`executor/models.py`, `sizing.py`):
  `RUMOR` (stake 0.0) / `REPORTED` (0.25) / `CORROBORATED` (0.5) /
  `CONFIRMED` (1.0, unreachable in this version — no shortcut list).
- **Tier→rung floor mapping**: tier 1–2 → `REPORTED`; tier 3–5 → `RUMOR`
  (this project's current archive only produces tiers 1 and 3, per
  `HANDOFF.md` §5).
- **Corroboration promotion**: `total_distinct_sources >= 2` (reporter
  included) on the same `story_key` promotes past the tier floor to
  `CORROBORATED` — using the sibling's already-fixed formula (not the
  original off-by-one bug that silently required three sources).
- **Kelly fraction**: `(fair_price_cents - ask_price_cents) / (100 -
  ask_price_cents)`, floored at 0 rather than flipping side on a negative
  result.
- **Entry price** = the ask on the side being taken; a missing ask declines
  the trade rather than falling back to a synthetic price.
- **Gates, values reused as starting defaults** (tunable once real decision
  data exists): closed market / no ask / missing spread leg → decline;
  spread > 5pts → decline; depth < 1 contract → decline; price outside
  10–90¢ → decline (payoff too lopsided to size an edge against); stake ≤ 0,
  contracts ≤ 0, or edge below **0.5 points** (the sibling's `MIN_EDGE_PTS`,
  reused as a starting default) → decline.
- **Every gate returns a reason, never a bare boolean**, and every declined
  decision is recorded as a row with that reason — never silently dropped.
  This is the same discipline HANDOFF.md's own §4 names as load-bearing.
- **Redundant ceilings**: this slice enforces the $10/$40 caps at (a) the
  sizing-formula clamp, (b) construction-time validation on the decision
  object, and (c) a SQLite `CHECK` constraint on the ledger table — three
  layers rather than the sibling's four, since this slice has no separate
  "fills" table (nothing is actually filled — no execution exists yet).

## Architecture

```
Item (matched keyphrases from slice 2)
  → kill switch check                                    [first gate, no model calls yet]
  → Haiku(headline+snippet) → synopsis
  → Sonnet verify(headline+snippet+synopsis) → { supported: bool, note?: string }
      false → record(skip, "synopsis not supported by source")
  → rung = compute_rung(trust_tier, corroborations, story_key)     [deterministic]
      RUMOR → record(skip, "rumor rung, stake 0")
  → (story_key, active event_ticker) already has a would-trade decision?
      yes → record(skip, "story already has an open position")
  → Sonnet decide(headline+snippet+synopsis+rung) →
        { direction: up|down, magnitude_pts, should_trade, reasoning }
      !should_trade → record(skip, reasoning)
  → fetch current Kalshi ladder prices for the active weekly event   [public, unauthenticated]
  → baseline = probability-weighted average across current band prices
  → shift the whole implied-price curve by magnitude_pts → fair price per band
  → per band: edge_pts, kelly fraction, stake = RUNG_STAKES[rung],
        contracts (clamped to depth + the $10 per-trade cap)
  → gates: is_tradeable (microstructure) + should_enter (stake/contracts/edge)
        + total-exposure check (≤ $40 across currently would-traded positions)
  → best-edge band clears every gate → record(would-trade, band, side,
        contracts, entry price, edge, reasoning)
  → none clear → record(skip, first failing gate's reason)
```

## Components

1. **Haiku synopsis step** — a thin wrapper calling `claude-haiku-4-5` with
   the item's headline+snippet, producing a free-text synopsis string. No
   structured output needed — the next stage cross-checks free text against
   free text.
2. **Sonnet verify step** — calls `claude-sonnet-5` with the original
   headline+snippet and the synopsis, structured output
   `{ supported: bool, note?: string }`. A cross-check, not a rebuild, per
   HANDOFF's own framing.
3. **Rung computation** — a pure function over `Item.trust_tier`,
   `Item.corroborations`, `Item.story_key`, and this decision engine's own
   record of other items already seen on the same `story_key` — no network
   calls, no LLM.
4. **Sonnet decide step** — calls `claude-sonnet-5` with headline+snippet,
   synopsis, and the computed rung (context only — Sonnet does not echo or
   alter it), structured output
   `{ direction: "up"|"down", magnitude_pts: number, should_trade: bool,
   reasoning: string }`.
5. **Market-data fetch** — a thin, read-only, unauthenticated client against
   Kalshi's public event/market endpoints, pulling the current band ladder
   for the active `KXAPRPOTUS` weekly event.
6. **Sizing & gates module** — pure, deterministic functions implementing
   the baseline/shift/edge/Kelly/stake/ceiling logic above, structured for
   real-call-site testing without needing the model stages.
7. **Decision ledger** — a local SQLite store recording every decision
   (would-trade or skip) with its full reasoning chain, queryable for the
   story-dedup check and the total-exposure check.

## Explicitly out of scope for this slice

- Placing any real Kalshi order, and any Kalshi authentication/credential
  code (market-data reads used here are public and unauthenticated).
- Exit/position-adjustment logic (sell, reduce, add-to) — entry-only.
- A `confirmed_sources`-style rung shortcut.
- Auto-triggered kill-switch logic (loss-based or otherwise) — manual only.
- Fixing the missing poll-source gap in `Internet_Info_Plug` — noted as
  follow-up, not built here.
- Any change to `Internet_Info_Plug`.

## Follow-ups noted during brainstorming, not part of this slice

- No upstream `iip` source watches any pollster or RealClearPolitics —
  the "poll-publication" keyphrase category from slice 2 currently cannot
  fire. Likely fix: a new `iip` page-watcher source pointed at RCP or a
  specific pollster, reusing the existing generic `PrimaryAdapter` pattern
  already used for OFAC — belongs in `Internet_Info_Plug`, not this repo.
- Once real decisions accumulate, the gate thresholds inherited from the
  sibling project (spread, depth, price band, minimum edge) should be
  revisited against this market's actual liquidity and spread, per
  `HANDOFF.md` §5's own note that the sibling's latency-vs-edge finding is
  "a hypothesis to re-test on this market's actual liquidity... not an
  assumed constant."
- Exit/position-management design (the "sell, or hold" half of HANDOFF's
  "buy, sell, or hold" framing) is real future work once entry logic is
  proven.
