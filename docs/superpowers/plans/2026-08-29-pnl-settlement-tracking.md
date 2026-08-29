# P&L / Settlement Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a market a decision bet on finalizes, compute and durably store
that decision's realized profit or loss — this system currently places real
trades and marks them settled without ever recording whether they won or lost,
or by how much.

**Architecture:** One new nullable `decisions` column, one signature change to
an existing ledger function, and a small computation inserted into the
existing finalized-market branch of `reconcileOpenPositions` (slice 5) — no
new API call, no new timer, no new file.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-08-29-pnl-settlement-tracking-design.md`

## Global Constraints

- P&L is computed **locally and deterministically** from data this system
  already has — `payoutCents = (row.side === marketStatus.result) ? row.contracts
  * 100 : 0`, `realizedPnlCents = payoutCents - (row.contracts *
  row.entryPriceCents)`. Never call Kalshi's `/portfolio/settlements` endpoint
  for this — its `revenue` field is account-level, not per-position, and a
  sibling project has a documented incident from trusting it directly.
- `entry_price_cents` is already side-native in this ledger (the real price
  paid per contract of whichever side was actually taken — confirmed in
  `src/decide/sizing.ts`, where a NO candidate's `askCents` is already
  `100 - yesBidCents`, the true NO-side price, before it ever reaches
  `entryPriceCents`). The P&L formula needs no YES/NO price conversion.
- A `finalized` market's `result` must be validated as exactly `'yes'` or
  `'no'` before computing anything. If it's neither, throw (inside the
  existing per-ticker-group `try`), log loudly, leave that row unsettled, and
  let the next pass retry — never fabricate a P&L value from an unrecognized
  result.
- This slice adds no new Kalshi API call, no new credential, no new timer. No
  market-specific keyword/rule/resolution-condition logic — the payout
  formula is Kalshi's universal binary-market payout structure.
- Capture and store only — no reporting script, no aggregate summary command
  in this plan.

---

### Task 1: Ledger schema and `markDecisionSettled` signature change

**Files:**
- Modify: `src/decide/ledger.ts`
- Test: `test/decide/ledger.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2):
  - `decisions.realized_pnl_cents INTEGER` (new column, nullable).
  - `OpenUnsettledDecision` gains `entryPriceCents: number`.
  - `export function markDecisionSettled(db: Database.Database, decisionId:
    number, realizedPnlCents: number): void` (signature change — was
    `(db, decisionId)`).

- [ ] **Step 1: Write the failing tests**

Add to `test/decide/ledger.test.ts`, in the existing `describe('ledger', ...)`
block (find the existing `describe('settlement tracking', ...)` or similar
nested block that already tests `markDecisionSettled`/`findOpenUnsettledDecisions`
— add these alongside it, reusing this file's existing `tradeRecord`/
`recordPendingDecision`/`resolveDecision` helpers exactly as its neighboring
tests do):

```typescript
it('markDecisionSettled stores the realized P&L alongside settled_at', () => {
  const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
  resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));

  markDecisionSettled(db, id, 880);

  const row = db.prepare('SELECT settled_at, realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { settled_at: string | null; realized_pnl_cents: number | null };
  expect(row.settled_at).not.toBeNull();
  expect(row.realized_pnl_cents).toBe(880);
});

it('markDecisionSettled stores a NEGATIVE realized P&L correctly (a loss)', () => {
  const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
  resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));

  markDecisionSettled(db, id, -120);

  const row = db.prepare('SELECT realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { realized_pnl_cents: number | null };
  expect(row.realized_pnl_cents).toBe(-120);
});

it('the schema CHECK rejects a realized_pnl_cents value on a row that is not both would_trade=1 and settled', () => {
  const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
  // NOT resolved to would_trade=1, and settled_at is still NULL -- a direct
  // UPDATE attempting to set realized_pnl_cents here must fail the CHECK.
  expect(() =>
    db.prepare('UPDATE decisions SET realized_pnl_cents = 100 WHERE id = ?').run(id)
  ).toThrow(/CHECK/);
});

it('findOpenUnsettledDecisions now returns entryPriceCents', () => {
  const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
  resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved', entryPriceCents: 37 }));

  const open = findOpenUnsettledDecisions(db);
  expect(open).toHaveLength(1);
  expect(open[0].entryPriceCents).toBe(37);
});
```

Update the TWO existing call sites of `markDecisionSettled` in this same file
to pass a third argument (they don't test P&L, so any value satisfying the
CHECK is fine — use `0`):
- The existing test `'markDecisionSettled removes a row from
  findOpenUnsettledDecisions afterward'`: change `markDecisionSettled(db, id);`
  to `markDecisionSettled(db, id, 0);`.
- The existing test `'records and settles a NEW would-trade decision through
  the normal path on a migrated database'`: change `markDecisionSettled(db,
  id);` to `markDecisionSettled(db, id, 0);`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: FAIL — `realized_pnl_cents` column doesn't exist yet,
`markDecisionSettled` doesn't accept a third argument yet, `entryPriceCents`
isn't returned by `findOpenUnsettledDecisions` yet.

- [ ] **Step 3: Add the schema and implementation**

In `src/decide/ledger.ts`, add to the `decisions` table definition inside the
`SCHEMA` template string (find the existing `settled_at TEXT,` line and add
immediately after it):

```sql
  realized_pnl_cents INTEGER,
```

Add a new `CHECK` to the same table (this schema already has one multi-line
`CHECK (would_trade = 0 OR (...))` constraint on this table — add a SECOND,
separate `CHECK` clause immediately after it, inside the same `CREATE TABLE`
parens):

```sql
  CHECK (realized_pnl_cents IS NULL OR (would_trade = 1 AND settled_at IS NOT NULL))
```

(Read the current full `decisions` table definition first to place both
additions correctly relative to the existing columns/constraints — this table
has grown across several prior slices, so confirm the exact current column
list and constraint placement rather than assuming line numbers.)

Change `OpenUnsettledDecision`:
```typescript
export interface OpenUnsettledDecision {
  id: number;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
}
```

Change `findOpenUnsettledDecisions`'s `SELECT` (the second query, the one that
returns rows — not the first `excluded` query, which stays as-is):
```sql
SELECT id, market_ticker AS marketTicker, side, contracts, entry_price_cents AS entryPriceCents
FROM decisions
WHERE would_trade = 1 AND settled_at IS NULL
  AND market_ticker IS NOT NULL AND side IS NOT NULL
```

Change `markDecisionSettled`:
```typescript
export function markDecisionSettled(db: Database.Database, decisionId: number, realizedPnlCents: number): void {
  db.prepare(
    `UPDATE decisions SET settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), realized_pnl_cents = ?
     WHERE id = ?`
  ).run(realizedPnlCents, decisionId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: PASS (all new tests, plus every pre-existing test in this file
still green — including the two you just updated to pass a third argument).

- [ ] **Step 5: Commit**

```bash
git add src/decide/ledger.ts test/decide/ledger.test.ts
git commit -m "feat: add realized_pnl_cents to decisions, thread entryPriceCents through findOpenUnsettledDecisions"
```

---

### Task 2: Compute and store realized P&L when a market finalizes

**Files:**
- Modify: `src/execute/reconcileOpenPositions.ts`
- Test: `test/execute/reconcileOpenPositions.test.ts`

**Interfaces:**
- Consumes: `markDecisionSettled(db, decisionId, realizedPnlCents)` (Task 1),
  `OpenUnsettledDecision.entryPriceCents` (Task 1).
- Produces: nothing new for later tasks — this is the last task in this plan.

- [ ] **Step 1: Write the failing tests**

Add to `test/execute/reconcileOpenPositions.test.ts`, in the existing
`describe('reconcileOpenPositions', ...)` block (reuse `recordOpenDecision`,
`mockClient`, `mockFetchMarketStatus` exactly as the existing finalization
tests in this file already do — find the existing test `'marks a genuinely
finalized market settled, and does not check its position at all'` and add
these alongside it):

```typescript
it('computes a WIN payout for a YES-side decision when result matches side', async () => {
  const id = recordOpenDecision(db, { side: 'yes', contracts: 10, entryPriceCents: 12 });
  const client = mockClient({});

  await reconcileOpenPositions({
    db, client,
    fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'finalized', result: 'yes' } }),
  });

  const row = db.prepare('SELECT realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { realized_pnl_cents: number | null };
  expect(row.realized_pnl_cents).toBe(880); // payout 10*100=1000, cost 10*12=120, pnl=880
});

it('computes a LOSS for a YES-side decision when result does not match side', async () => {
  const id = recordOpenDecision(db, { side: 'yes', contracts: 10, entryPriceCents: 12 });
  const client = mockClient({});

  await reconcileOpenPositions({
    db, client,
    fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'finalized', result: 'no' } }),
  });

  const row = db.prepare('SELECT realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { realized_pnl_cents: number | null };
  expect(row.realized_pnl_cents).toBe(-120); // payout 0, cost 10*12=120, pnl=-120
});

it('computes a WIN payout for a NO-side decision when result matches side', async () => {
  const id = recordOpenDecision(db, { side: 'no', contracts: 10, entryPriceCents: 30 });
  const client = mockClient({});

  await reconcileOpenPositions({
    db, client,
    fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'finalized', result: 'no' } }),
  });

  const row = db.prepare('SELECT realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { realized_pnl_cents: number | null };
  expect(row.realized_pnl_cents).toBe(700); // payout 10*100=1000, cost 10*30=300, pnl=700
});

it('computes a LOSS for a NO-side decision when result does not match side', async () => {
  const id = recordOpenDecision(db, { side: 'no', contracts: 10, entryPriceCents: 30 });
  const client = mockClient({});

  await reconcileOpenPositions({
    db, client,
    fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'finalized', result: 'yes' } }),
  });

  const row = db.prepare('SELECT realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { realized_pnl_cents: number | null };
  expect(row.realized_pnl_cents).toBe(-300); // payout 0, cost 10*30=300, pnl=-300
});

it('computes each row in a multi-row-per-ticker group independently, not a shared or averaged value', async () => {
  const idA = recordOpenDecision(db, { marketTicker: 'L', side: 'yes', contracts: 10, entryPriceCents: 12 });
  const idB = recordOpenDecision(db, { marketTicker: 'L', side: 'no', contracts: 5, entryPriceCents: 40 });
  const client = mockClient({});

  await reconcileOpenPositions({
    db, client,
    fetchMarketStatus: mockFetchMarketStatus({ L: { status: 'finalized', result: 'yes' } }),
  });

  const rowA = db.prepare('SELECT realized_pnl_cents FROM decisions WHERE id = ?').get(idA) as { realized_pnl_cents: number | null };
  const rowB = db.prepare('SELECT realized_pnl_cents FROM decisions WHERE id = ?').get(idB) as { realized_pnl_cents: number | null };
  expect(rowA.realized_pnl_cents).toBe(880); // YES side, result=yes: win. payout 1000, cost 120, pnl=880
  expect(rowB.realized_pnl_cents).toBe(-200); // NO side, result=yes: loss. payout 0, cost 5*40=200, pnl=-200
});

it('throws and leaves the row unsettled when a finalized market has an unrecognized result value, then settles normally once corrected', async () => {
  const id = recordOpenDecision(db, { side: 'yes', contracts: 10, entryPriceCents: 12 });
  const client = mockClient({});

  // First pass: a malformed result. Must not settle, must not crash the whole
  // pass (the existing per-ticker try/catch isolates this).
  await reconcileOpenPositions({
    db, client,
    fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'finalized', result: 'void' } }),
  });
  const stillOpen = db.prepare('SELECT settled_at, realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { settled_at: string | null; realized_pnl_cents: number | null };
  expect(stillOpen.settled_at).toBeNull();
  expect(stillOpen.realized_pnl_cents).toBeNull();
  expect(findOpenUnsettledDecisions(db)).toHaveLength(1);

  // Second pass: a corrected result. Settles normally.
  await reconcileOpenPositions({
    db, client,
    fetchMarketStatus: mockFetchMarketStatus({ 'KXAPRPOTUS-26AUG28-40.6': { status: 'finalized', result: 'yes' } }),
  });
  const nowSettled = db.prepare('SELECT settled_at, realized_pnl_cents FROM decisions WHERE id = ?').get(id) as
    { settled_at: string | null; realized_pnl_cents: number | null };
  expect(nowSettled.settled_at).not.toBeNull();
  expect(nowSettled.realized_pnl_cents).toBe(880);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: FAIL — no P&L computation exists yet, and the unrecognized-result
case doesn't currently throw (today it settles unconditionally).

- [ ] **Step 3: Implement**

Read the CURRENT state of `src/execute/reconcileOpenPositions.ts` in full
before editing — find the exact real `if (marketStatus.status === 'finalized')
{ ... }` branch (its `db.transaction()` call already wraps a `for (const row of
rows) { markDecisionSettled(db, row.id); }` loop). Change that whole branch
to:

```typescript
      if (marketStatus.status === 'finalized') {
        if (marketStatus.result !== 'yes' && marketStatus.result !== 'no') {
          throw new Error(
            `finalized market ${marketTicker} has an unrecognized result value: "${marketStatus.result}" ` +
              `(expected "yes" or "no") -- refusing to fabricate a P&L for this ticker's rows`
          );
        }
        // One transaction per ticker group: a crash midway through must not leave
        // some of this ticker's rows settled and the rest not, which would make the
        // next pass compare a partial expected count against the real position and
        // block a market that is actually fine.
        db.transaction(() => {
          for (const row of rows) {
            const payoutCents = row.side === marketStatus.result ? row.contracts * 100 : 0;
            const realizedPnlCents = payoutCents - row.contracts * row.entryPriceCents;
            markDecisionSettled(db, row.id, realizedPnlCents);
          }
        })();
        continue;
      }
```

The `throw` happens BEFORE the transaction, so it's caught by the existing
per-ticker-group `try`/`catch` a few lines below this branch (unchanged by
this task) — confirm by reading that catch block that it already logs and
lets the loop continue to the next ticker, deferring this one to the next
pass. Do not add a new try/catch; the existing one already covers this.

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `direnv exec . npm test` and `direnv exec . npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/execute/reconcileOpenPositions.ts test/execute/reconcileOpenPositions.test.ts
git commit -m "feat: compute and store realized P&L when a market finalizes"
```
