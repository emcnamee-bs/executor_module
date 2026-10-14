# Unified position-aware decision (`DECISION_MODE=unified`)

Date: 2026-10-13. Status: **approved by the user on 2026-10-13** with the decisions in section 10 (model recommends and
code enforces; rolled out to ALL paper units; data integrity must stay intact). Scope: paper units only. Builds on
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
   entry, current held-side bid/mid, unrealised cents, 5/15/60-minute trajectory); the rung. Output: for single-quantity trades
   one shared `assessment` (`shift`, `confidence`, `reason`: one belief about the settlement quantity applied to every position
   on that curve; for `binary` trades the shift is in YES-probability points); for `multi` trades `moves[]` per market (the
   group rule applies to the active event's markets; a move on a held market of another event is checked as independent); in
   both cases `positions: [{position_id, action: hold|sell, reason}]` and `entry: {action: buy|none, reason}`.
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
- Selected per unit by an environment drop-in (`DECISION_MODE=unified`); removing the drop-in and restarting is the rollback
  (the `classic` code path stays in place, unchanged).
- Cost: one Sonnet call per gated item instead of 2 + N; the existing budget alert applies.

## 5. Rollout (decision: all paper units)

Because these are paper trades the user chose to roll out to **every** active paper unit rather than pilot a few. The
safeguard is data integrity, not scale: roll out in three waves (the four units that already trade; the other tradeable
units; the converted `multi` trades), run the integrity checker (section 9) after each wave and after the first hour of
live items, and **fix every violation it reports before continuing**. A violation never gets "accepted": either the code is
corrected and the affected ledger rows repaired from the audit trail, or the unit goes back to `classic` until it is.

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

## 8. (Open questions: answered, see section 10)

## 9. Data integrity (read-only checker, runs on a timer and after each rollout wave)

A read-only tool (`~/exit-analysis/integrity.py`, next to the archive, with tests) opens every ledger with `mode=ro` and
verifies these invariants, printing each violation with the trade, table, row id and rule, exiting non-zero and sending one
alert when anything fails:

1. **Positions.** `contracts > 0`; `entry_price_cents` in 1..99; a closed position (`settled_at` set) has `pnl_cents` set;
   an open one has none; `result` is NULL only for a position closed by exits.
2. **Exits.** The sum of a position's exit fills never exceeds its contracts; a fully sold position is closed with
   `pnl_cents` equal to the sum of its fills' P&L; every exit row's review exists, belongs to the same position and has
   verdict `sell`; fill prices are within the position's side range 1..100.
3. **Reviews.** At most one review per (item, position); `sell` reviews have numbers (mid, loss, exit cost) and a lag
   record; `error` reviews carry a reason.
4. **Legs.** Every leg 2 has a leg 1 with the same `source_item_id`; at most two legs per source item; two-leg items occur
   only on `exclusive` trades; both legs have positive contracts and distinct markets.
5. **Audit trail.** Every position created after the multi/unified rollout points to a decision or model-call row that
   explains it (an `ai_calls` row of stage `decide`, `decide_multi` or `decide_unified` for its item); no `decisions` row
   has `would_trade = 1` on a paper unit (that table is the real-order path); no ledger has rows older than its archive
   snapshot missing from the snapshot.
6. **Unified mode.** Every `decide_unified` call's recommended actions are present for each open position that existed at
   the time; no sell happened without a `sell` recommendation (and vice versa a recommendation of `sell` that the rule
   vetoed is recorded as such).

Run order: after every deploy or restart wave, hourly for the first day, then daily with the archive. Findings are
fixed (code and, where a row is wrong, a documented repair from the audit trail), never silenced.

## 10. Decisions (user, 2026-10-13)

1. **Who has the last word:** both must agree. The model recommends, the code enforces the 2% / exit-cost rule and the
   sizing gates (the section 2 default).
2. The Sonnet triage step is dropped in unified mode (one call).
3. **Roll out to all** paper units, not a pilot; it is only paper trading, so a failure is acceptable as long as it is
   fixed and the data stays intact (section 5 and section 9).
