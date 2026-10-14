# Multi-market structure: making the 11 capture-only trades tradeable

Date: 2026-10-13. Status: **approved by the user on 2026-10-13** with the decisions in section 9 (up to two markets
per item, tracked; `kxguilfoyleout` retired; builder classifies the outcome group). Scope: paper units only.

## 1. Problem and evidence

Eleven of the 36 paper trades have `marketStructure: capture`. The pipeline analyses their news and records a snapshot
row, but **no code path can open or close a position** on them, so they can never buy when the market should rise or sell
when it should fall. `deriveStructure` (src/profile/build.ts) labels a series `capture` whenever its markets are not a
single "above a strike" ladder, a band ladder or one binary market.

Their markets come in three shapes (measured 2026-10-13 from Kalshi's public API):

| Shape | Meaning | Trades | Markets |
|---|---|---|---|
| **ladder** | nested "before date X" markets: P(event before earlier date) <= P(before later date) | `kxgreenland`, `kxinsurrection`, `kxtrumpout27`, `kxusairanagreement`, `kxzelenskyputin`, `kxguilfoyleout` | 2-9 per event |
| **exclusive** | exactly one outcome resolves YES, so the probabilities sum to 1 | `kxfeddecision` (11 meetings), `kxcbdecisioncanada`, `kxbalancepowercombo`, `kxvenezuelaleader` | 4-55 |
| **independent** | each market is its own yes/no question about a different person | `kxtrumppardon` | 34 |

Of 115 quoted markets across the 11 series, **33 pass the existing entry gates** (price 10-90c, spread <= 5c): Fed 12,
Bank of Canada 4, balance of power 3, Greenland 1, insurrection 2, Trump out 2, Iran deal 4, Zelensky-Putin 1, pardon 2,
Venezuela 2, Guilfoyle 0 (all three markets sit at 99-100c: effectively resolved). So 10 of the 11 would be genuinely
tradeable; Guilfoyle should be retired like the four trades retired on 2026-10-12.

## 2. Goal and success criteria

1. A `multi` trade can open a paper position on any one of its markets when a news item justifies it, buying YES when the
   model believes that market's probability should rise and NO when it should fall, using the same gates, sizing caps and
   audit trail as the existing structures.
2. Held positions on a `multi` trade are covered by the existing exit review (sells on adverse news) with no new exit logic.
3. Nothing changes for the 25 trades that already trade, and nothing here can place a real order (paper only, same guards).
4. Every decision is auditable: the model's per-market moves, the group-rule checks and the sizing arithmetic are logged.

## 3. Design

**3.1 Profile.** `marketStructure` gains `'multi'` (kept: `capture` for anything unclassifiable). A `multi` profile carries a
required `outcomeGroup: 'ladder' | 'exclusive' | 'independent'`. `deriveStructure` returns `multi` when the markets are
`custom`/strike-less and there are >= 2 of them; the builder's existing Sonnet call (which already detects multi-outcome
events for its `outcomeNote`) also returns `outcomeGroup`, with a deterministic fallback: all markets strike-less and every
subtitle starting "Before ..." means `ladder`.

**3.2 Market labels.** `BandMarket` gains an optional `label` (Kalshi `yes_sub_title`), filled by `fetchEventBands`, so the
model and the logs can say "Michael Cohen" or "Hike 25bps" instead of a ticker suffix.

**3.3 Decision call `decideMulti`.** One Sonnet call per gated, triaged item. Input: the item, the rung, the group type, and
a table of the event's active markets (ticker, label, YES bid/ask). Output (structured, validated):
`moves: [{ market, shift, confidence }]` (at most 4) plus `reasoning`. `shift` is a signed change in that market's YES
probability in percentage points (|shift| <= min(maxMagnitude, 100)); `confidence` is 0..1. Code-enforced group rules:
`exclusive`: the shifts must sum to within +/-5 points of zero or the whole answer is rejected (probabilities must stay a
distribution); `ladder`: after applying the shifts the probabilities are forced monotone non-decreasing in the horizon;
`independent`: none. An invalid answer is a no-trade with the reason logged, never a trade.

**3.4 Sizing `evaluateMultiSizing`.** For each move: `fairYes = clamp(midYes + shift, 1, 99)`; side YES if the shift is
positive, else NO; candidate = (ask of that side, spread, depth, fair, edge). Reuses `gateCandidate`, `kellyFraction`,
`contractsWithinCaps` and `PAPER_CAPS` exactly as `evaluateSizing` does. The best-edge candidate wins; one position per
item; `hasOpenPosition` (same story) and the post-exit re-entry block apply unchanged.

**Two legs per item (decision 2026-10-13).** On an `exclusive` group, up to **two** candidates from one item may be bought,
on two distinct markets, each independently clearing every gate, the edge threshold and the shared exposure cap
(`paperExposureCents` for the event counts both legs). Because `paper_positions.item_id` is UNIQUE (it is what makes a
redelivered stream entry idempotent), the second leg is stored with `item_id = "<item>#2"`, and two new nullable columns
(added with `ALTER TABLE ... ADD COLUMN`, so existing ledgers need no rebuild) make the pairing explicit and queryable:
`source_item_id` (the original item id on every leg, NULL on legacy rows) and `leg` (1 or 2, NULL on legacy rows).
`hasPaperPosition` treats `<item>` and `<item>#2` as the same delivery. Tracking: both legs share one `decisions` row
reason that names both markets, both appear in `exit-reviews`/`paper_exits` like any position, the analysis archive
exports the two new columns, and the integrity checker (see the unified-decision spec, section 9) verifies that every
leg 2 has a leg 1 with the same `source_item_id`, that no item has more than two legs, and that two-leg items exist only
on `exclusive` trades.

**3.5 Recording and exits.** The position is an ordinary single-market paper position with `structure = 'multi'`. The exit
review treats `multi` like `binary` (YES-probability-point shifts against the market's own bid/ask; ceiling 100) and its
prompt names the market by label and tells the model the group type. `paper_exit_*` tables, the retry timer, lateness and
the wall publishers need no change.

**3.6 Migration.** Rebuild the 11 profiles with `--reuse-keyphrases` (the refresh script already does the mechanics), which
sets `multi` and `outcomeGroup`, then restart those units. Retire `kxguilfoyleout`.

## 4. Out of scope

Live trading; buying several markets from one item; cross-market arbitrage; changing the price/spread gates (which leave
33 of 115 markets tradeable and are a separate decision); fractional contracts.

## 5. Risks

- **Correlated markets.** An exclusive-set shift on one outcome implies the opposite on others; the sum-to-zero rule keeps
  the model honest but a bad answer is only rejected, never corrected.
- **Thin books.** Many of the 33 tradeable markets show 3-5c spreads; the exit cost guard already refuses sells that cost
  more than they save, and the existing depth cap limits fills.
- **Over-trading on long lists.** 34 pardon candidates means many plausible stories; the Haiku gate, the Sonnet triage and
  the per-item single-position rule bound the volume.

## 6. Testing

Unit: `deriveStructure` (all three shapes, plus unchanged cases), outcome-group fallback, `decideMulti` validation (unknown
market, duplicate, sum rule, monotone repair, out-of-range, malformed), `evaluateMultiSizing` for each group, `evaluateExit`
with `multi`. Integration: pipeline with fakes for each group (buy YES, buy NO, decline on price gate, decline on bad
answer), existing `pipeline.test.ts` unedited. Replay: run the new decision over the news the 11 ledgers already logged
(`[PAPER capture]` rows hold the old direction/magnitude) to see what it would have bought, before enabling any unit.

## 7. Rollout

Paper only. Enable per unit by rebuilding the profile; roll back by restoring the profile backup (the refresh script keeps
one) and restarting. Order: Fed and Bank of Canada decisions first (liquid, exclusive), then the date ladders, then the
candidate lists; run the integrity checker after each batch and fix anything it reports before the next.

## 8. (Open questions: answered, see section 9)

## 9. Decisions (user, 2026-10-13)

1. `outcomeGroup` is classified by the builder's model with the deterministic fallback (default, not separately asked).
2. **Up to two markets per item on exclusive sets**, with explicit tracking (section 3.4: `source_item_id`, `leg`).
3. **Retire `kxguilfoyleout` now** (stop and disable its unit, remove it from the wall grid, record it in HANDOFF 5a.7).
4. Data integrity must stay intact throughout: anything that goes wrong on paper is fixed, and the integrity checker
   (unified-decision spec, section 9) runs after every rollout step.
