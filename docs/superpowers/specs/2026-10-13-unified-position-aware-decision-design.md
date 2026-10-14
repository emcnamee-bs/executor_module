# Unified position-aware decision (`DECISION_MODE=unified`)

Date: 2026-10-13. Status: **draft for the user's review** (no code written). Scope: paper units only. Builds on
`2026-10-13-multi-market-structure-design.md` (its `moves` output shape) and on the exit review already merged.

## 1. Problem and evidence

You described the intended flow as: a script finds headlines, Haiku confirms the story matches the trade, then **one**
Sonnet analysis decides what to do about selling, holding or buying, depending on the current position. Today that is three
separate Sonnet calls that do not see each other:

- `triage` (is the item worth a look), then `decide` (entry only: "should we trade?", a prompt that vetoes anything "too
  indirect or speculative": 90-104 vetoes against 7-13 buys on Brent and WTI), then
- one `exit_review` call **per held position**, run in parallel and unaware of the entry call.

For a gated item on a trade holding N positions that is 2 + N Sonnet calls, none of which knows what we already hold when
it judges the news. Consequences seen in the logs: entry decisions made while holding the opposite exposure, exit prompts
that cannot say "we would also buy here", and a dominant entry-side veto bias.

## 2. Principle kept

The model states what it believes (per market: a signed shift, a confidence, a reason). Code turns beliefs into actions with
the rules you set: sell when the expected loss from one item exceeds max(2% of cost, the cost of exiting); buy when the
edge clears the existing gates and sizing caps. This keeps every number testable and every action reproducible from the log.
New in this design: the model also records an explicit **recommended action** for each held position (`hold` or `sell`) and
for entry (`buy` or `none`), so its own judgement about selling, holding or buying is captured for analysis and can veto.

## 3. Flow (per gated item, per trade, `unified` mode)

1. Haiku gate (unchanged).
2. One Sonnet `positionAwareDecide` call (replaces triage + decide + all exit reviews). Input: the item; the market table (a
   compact ladder for curve trades, the label table for `multi` trades); **all open positions** (market, side, remaining,
   entry, current held-side bid/mid, unrealised cents, 5/15/60-minute trajectory); the rung. Output: `assessment`
   (`shift`, `confidence`, `reason`, or `moves[]` for `multi`), `positions: [{position_id, action: hold|sell, reason}]`,
   `entry: { action: buy|none, reason }`.
3. Code, in this order and independently of each other:
   - for each held position: run `evaluateExit` on the model's shift/confidence for that market; **sell only if the model
     said `sell` and the 2% / exit-cost rule passes** (either side can veto; both are logged);
   - for entry: **buy only if the model said `buy` and sizing finds an edge** inside the existing gates and caps, on a market
     where no sell trigger fired for this item.
4. Everything is recorded: one `ai_calls` row (stage `decide_unified`), one `paper_exit_reviews` row per position (as
   today, so the wall, lateness and analysis archive need no change), and a decisions row for the entry outcome.

## 4. Safety and rollout

- Paper only; the live unit never runs it (same startup refusal as the exit review). `classic` stays the default and the
  only code path for the live unit.
- Selected per unit by an environment drop-in (`DECISION_MODE=unified`), so classic and unified can run side by side on
  different units and be compared from the archive.
- Cost: one Sonnet call per gated item instead of 2 + N; the existing budget alert applies.

## 5. Evaluation before it is widened

Replay the news already logged for a pilot set of trades (the backtest tooling exists) through both modes and compare:
positions opened, sells triggered and their timing, vetoes, cost. Run unified on 3-5 pilot units for a week against their
classic twins' history before moving more units.

## 6. Out of scope

Letting the model place or size orders; any live trading; changing the 2% rule or the exit-cost guard; removing the Haiku
gate.

## 7. Risks

- Dropping the separate triage means every gated item reaches the larger prompt; the gate already filters, and the single
  call replaces two or more.
- A longer prompt (positions, trajectory, ladder) raises per-call cost; mitigated by sending only active markets and the
  positions that exist.
- The model's recommended action can disagree with the numbers; by design either can veto, and every disagreement is in the
  log, which is itself useful analysis.

## 8. Open questions for the user

1. **Who has the last word?** Recommended: both must agree (model recommends, code enforces your 2% rule and sizing).
   Alternative: the model decides outright within the position and exposure limits (more autonomy, less reproducible).
2. Keep the Sonnet triage step in unified mode (cheaper first look) or drop it (recommended, one call)?
3. Which units pilot it? Suggested: `kxwti`, `kxaaagasw`, `kxbrentmon`, `kxhormuzweekly` (the ones that already trade).
