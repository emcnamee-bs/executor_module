# P&L / Settlement Tracking — Design (Slice 8)

## Goal

This system places real orders and durably records what happened to them, and
slice 5 already detects when a market finalizes (marking the decision row
`settled_at`) — but nothing anywhere computes or stores whether a settled
position actually won or lost, or by how much. The system can place a real
trade and never know whether it made or lost money on it. This slice closes
that gap: when a market a decision bet on finalizes, compute and durably store
that decision's realized profit or loss.

This slice is explicitly **capture and store only** — no reporting script, no
aggregate summary command. Querying/reporting the data this slice stores is a
natural follow-up, deliberately deferred to keep this slice narrowly scoped,
matching how prior slices scoped narrowly and left tooling for later.

## Decisions made during brainstorming

1. **Mechanism: extend the existing reconciliation pass, not a new one.**
   `reconcileOpenPositions` (slice 5) already detects market finalization via
   `fetchMarketStatus` and already groups open decision rows by
   `market_ticker` for exactly this event. P&L capture happens inside that
   same finalized-branch, in the same pass, rather than a second timer polling
   a different endpoint on a different schedule — one timer, one place
   finalization is detected, one place P&L is captured.

2. **Data source: computed locally from `result`, never Kalshi's
   `/portfolio/settlements` endpoint.** Live research into two sibling
   projects' production code (`kalshi-spine`, `Fast99Follower`) surfaced a
   real, documented incident directly on point: `/portfolio/settlements`'
   `revenue` field is **account-level**, not a clean per-position number — it
   can reflect multiple positions merged onto one ticker (e.g. across bots or
   accounts sharing the exchange account), and a sibling project's own
   incident log describes trusting it directly as the root cause of an
   inflated realized-P&L figure that fed a compounding exposure cap and caused
   a real account overspend.

   The fix, also drawn from that same research: Kalshi's binary yes/no payout
   is a hard, deterministic invariant — a winning contract pays **exactly**
   $1.00 (100 cents), a losing one pays **exactly** $0. Since this project's
   own ledger already records each decision's own `side`, `contracts`, and
   `entry_price_cents`, and slice 5 already fetches the market's real,
   resolved `result` (`"yes"` or `"no"`) the moment a market finalizes,
   per-decision P&L is fully computable **locally and deterministically**:
   ```
   payoutCents = (row.side === marketStatus.result) ? row.contracts * 100 : 0
   realizedPnlCents = payoutCents - (row.contracts * row.entryPriceCents)
   ```
   No new Kalshi API call, no new authenticated surface, and this sidesteps
   the exact account-level-merging pitfall the sibling project's incident
   documents — this system's own ledger, not a shared account-level endpoint,
   is the source of truth for what THIS system's own position was.

3. **Anomaly handling: throw and skip settling that row this pass, never
   silently compute a wrong number.** Slice 5's own research established that
   a genuinely `finalized` market always carries a resolved `result` of
   `"yes"` or `"no"`. If that assumption is ever violated (a malformed
   response, an unanticipated `result` value), the P&L computation above
   would silently produce a nonsense number rather than a division-by-zero or
   an obvious crash — the dangerous kind of failure. Validate `result` is
   genuinely `"yes"` or `"no"` before computing anything; if not, throw inside
   the existing per-ticker-group `try` (which already isolates one ticker's
   failure from the rest of the pass, per slice 5), log loudly, and leave that
   row's `settled_at`/`realized_pnl_cents` untouched so the next pass retries
   it — the same "never fabricate a value you didn't verify" pattern
   `positionForTicker` already established in slice 4.

4. **Storage: one new nullable column, tied to existing invariants by a CHECK
   constraint.** `decisions` gains `realized_pnl_cents INTEGER`, set only when
   a row settles (`NULL` until then). A `CHECK` constraint —
   `realized_pnl_cents IS NULL OR (would_trade = 1 AND settled_at IS NOT
   NULL)` — ensures a P&L value can never exist without a settled,
   would-trade row backing it, matching this schema's established
   defense-in-depth style (the same style that already backs
   `notional_cents`' would-trade consistency check).

## Architecture

New/changed files:

- **`src/decide/ledger.ts`** (modified) — `decisions` gains
  `realized_pnl_cents INTEGER` plus the CHECK constraint described above.
  `OpenUnsettledDecision` gains `entryPriceCents: number` (needed for the P&L
  subtraction; not currently returned). `findOpenUnsettledDecisions`'s query
  gains `entry_price_cents AS entryPriceCents` in its `SELECT`.
  `markDecisionSettled(db: Database.Database, decisionId: number): void`
  becomes `markDecisionSettled(db: Database.Database, decisionId: number,
  realizedPnlCents: number): void`, setting both `settled_at` and
  `realized_pnl_cents` in the same `UPDATE`.
- **`src/execute/reconcileOpenPositions.ts`** (modified) — inside the
  existing `if (marketStatus.status === 'finalized') { ... }` branch (which
  already runs once per distinct ticker, inside the existing per-ticker-group
  `try`, and already wraps its `markDecisionSettled` calls in one
  `db.transaction()` per group): before the transaction, validate
  `marketStatus.result === 'yes' || marketStatus.result === 'no'`; if not,
  throw (caught by the existing per-ticker `catch`, logged, that ticker's
  group deferred to the next pass, exactly as an existing divergence-detection
  failure already is). If valid, compute each row's `payoutCents`/
  `realizedPnlCents` per the formula above and pass the computed value into
  `markDecisionSettled` inside the existing transaction — no new transaction,
  no new per-ticker try/catch, this is a change to what's already inside the
  existing ones.

## Data flow

```
reconcileOpenPositions (existing, per ticker group):
  marketStatus = await fetchMarketStatus(marketTicker, db)
  if (marketStatus.status === 'finalized'):
    if (marketStatus.result !== 'yes' && marketStatus.result !== 'no'):
      throw new Error(`finalized market ${marketTicker} has an unresolved result: ${marketStatus.result}`)
      -- caught by the existing per-ticker try/catch, logged, deferred to next pass

    db.transaction(() => {
      for (const row of rows):
        payoutCents = (row.side === marketStatus.result) ? row.contracts * 100 : 0
        realizedPnlCents = payoutCents - (row.contracts * row.entryPriceCents)
        markDecisionSettled(db, row.id, realizedPnlCents)
    })()
    continue
```

## Testing plan

Matching this project's standing law — every value that travels through this
system needs a test driving the real call site, not just the function in
isolation:

- **All four outcome combinations**, driven through the real
  `reconcileOpenPositions` call: a YES-side row where `result === 'yes'`
  (win), a YES-side row where `result === 'no'` (loss), a NO-side row where
  `result === 'no'` (win), a NO-side row where `result === 'yes'` (loss).
  Assert the exact `realized_pnl_cents` value written, not just its sign.
- **A multi-row-per-ticker group**: two decisions sharing one `market_ticker`
  (already a real, tested scenario since slice 5) with different
  `contracts`/`entry_price_cents`/`side` values, confirming each row gets its
  own independently-correct P&L rather than one shared or averaged value.
- **The anomaly case**: a mocked `fetchMarketStatus` returning `status:
  'finalized'` with a `result` that is neither `'yes'` nor `'no'` — confirm
  the pass throws internally (caught by the existing per-ticker catch), the
  row's `settled_at`/`realized_pnl_cents` remain `NULL`, and a later pass with
  a corrected `result` settles it normally.
- **The CHECK constraint**: confirm the schema itself rejects a direct
  attempt to set `realized_pnl_cents` on a row that isn't both `would_trade =
  1` and has `settled_at` set (construction-time defense-in-depth, the same
  style as the existing notional-consistency check).
- No new Kalshi API call is introduced by this slice, so no new real-API test
  posture is needed — `fetchMarketStatus` is already tested against the real
  API from slice 5 and is unchanged here.

## Credential hygiene / non-negotiables reaffirmed

- This slice introduces no new authenticated Kalshi API surface — it computes
  P&L entirely from data already in this system's own ledger plus the
  `result` field slice 5 already fetches. `/portfolio/settlements` is
  deliberately not called anywhere in this slice.
- No market-specific keyword/rule/resolution-condition logic is introduced —
  the payout formula (`side === result ? 100 : 0` cents per contract) is
  Kalshi's own universal binary-market payout structure, not specific to
  `KXAPRPOTUS` or any other market.
- Entry-only scope is unaffected — this slice computes and stores a number
  after a market the system already tracks has already finalized; it places,
  closes, or modifies no order.
