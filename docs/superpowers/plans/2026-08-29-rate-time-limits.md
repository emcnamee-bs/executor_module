# Rate / Time Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap real trade frequency to at most 1 trade per 15 minutes, globally,
so a burst of correlated signals can't deploy this system's entire exposure
budget almost instantly — the exposure cap limits how much money is ever at
risk, but nothing currently limits how fast it gets there.

**Architecture:** One new counting function in the ledger (a plain `COUNT(*)`
query against existing `decisions` rows, no new table), and one new early-exit
check in the decision pipeline, checked before any model call runs so a
rate-limited item never spends real API cost.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-08-29-rate-time-limits-design.md`

## Global Constraints

- Only real fills (`would_trade = 1` rows) count toward the rolling window —
  never order attempts, never `would_trade = false` decisions of any kind
  (including a decision this same limit itself rate-limited).
- `MAX_TRADES_PER_WINDOW = 1`, `RATE_LIMIT_WINDOW_MINUTES = 15` — hardcoded
  constants, matching this project's existing style for
  `MAX_NOTIONAL_CENTS_PER_TRADE`/`MAX_TOTAL_EXPOSURE_CENTS`.
- Global scope — no event/ticker filter on the count query.
- Single check, no dual before/after recheck — this system processes Redis
  stream entries one at a time, sequentially, so there is no concurrent
  decision that could race past a single check.
- The check runs BEFORE `synopsize`/`verifySynopsis`/`decideTrade` — right
  after the existing `rung === 'rumor'` skip and before any model call — so a
  rate-limited item never spends real Haiku/Sonnet API cost.
- No new Kalshi API call, no new credential, no new table. Entry-only scope
  unaffected.

---

### Task 1: `recentTradeCount` — the rolling-window counting primitive

**Files:**
- Modify: `src/decide/ledger.ts`
- Test: `test/decide/ledger.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 2): `export const MAX_TRADES_PER_WINDOW = 1;`,
  `export const RATE_LIMIT_WINDOW_MINUTES = 15;`, `export function
  recentTradeCount(db: Database.Database, windowMinutes: number): number`.

- [ ] **Step 1: Write the failing tests**

Add to `test/decide/ledger.test.ts`, in a new `describe('rate limiting', ...)`
block alongside the existing `describe('circuit breakers', ...)` block (same
file, same `beforeEach`/`afterEach` temp-ledger setup already in that file;
reuse this file's existing `tradeRecord`/`recordPendingDecision`/
`resolveDecision` helpers exactly as its neighboring tests do):

```typescript
import { recentTradeCount, MAX_TRADES_PER_WINDOW, RATE_LIMIT_WINDOW_MINUTES } from '../../src/decide/ledger.js';

describe('rate limiting', () => {
  it('recentTradeCount is 0 with no would-trade rows', () => {
    expect(recentTradeCount(db, RATE_LIMIT_WINDOW_MINUTES)).toBe(0);
  });

  it('recentTradeCount counts a real fill recorded just now', () => {
    const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));

    expect(recentTradeCount(db, RATE_LIMIT_WINDOW_MINUTES)).toBe(1);
  });

  it('recentTradeCount does NOT count a would_trade=false decision', () => {
    // The schema's notional CHECK (and assertNotionalIsConsistent's construction-time
    // twin) both short-circuit entirely when would_trade=0 -- no other field needs
    // adjusting for this row to be valid.
    const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    resolveDecision(db, id, tradeRecord({ wouldTrade: false, orderStatus: 'resolved' }));

    expect(recentTradeCount(db, RATE_LIMIT_WINDOW_MINUTES)).toBe(0);
  });

  it('recentTradeCount does NOT count a real fill OUTSIDE the window', () => {
    const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));
    // Backdate this row's created_at well outside the 15-minute window.
    db.prepare("UPDATE decisions SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') WHERE id = ?").run(id);

    expect(recentTradeCount(db, RATE_LIMIT_WINDOW_MINUTES)).toBe(0);
  });

  it('MAX_TRADES_PER_WINDOW and RATE_LIMIT_WINDOW_MINUTES are exactly 1 and 15', () => {
    expect(MAX_TRADES_PER_WINDOW).toBe(1);
    expect(RATE_LIMIT_WINDOW_MINUTES).toBe(15);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: FAIL — `recentTradeCount`/`MAX_TRADES_PER_WINDOW`/
`RATE_LIMIT_WINDOW_MINUTES` are not exported yet.

- [ ] **Step 3: Implement**

In `src/decide/ledger.ts`, add near the existing
`MAX_NOTIONAL_CENTS_PER_TRADE`/`MAX_TOTAL_EXPOSURE_CENTS` constants (find them
at the top of the file):

```typescript
export const MAX_TRADES_PER_WINDOW = 1;
export const RATE_LIMIT_WINDOW_MINUTES = 15;
```

Add, anywhere after the `SCHEMA` constant and the existing ledger functions (a
reasonable spot is near `totalExposureCents`, since both are read-only
aggregate queries the pipeline consults before sizing/deciding):

```typescript
/**
 * How many would-trade decisions (real fills) have been recorded in the last
 * `windowMinutes` -- global, not scoped to any event/ticker. Only would_trade=1
 * rows count: an order attempt that didn't fill, or a decision declined for any
 * reason (no edge, exposure, itself rate-limited), never counts toward this
 * window. Paces how FAST the exposure budget can be deployed, independent of
 * MAX_TOTAL_EXPOSURE_CENTS, which only caps how much is ever at risk.
 */
export function recentTradeCount(db: Database.Database, windowMinutes: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM decisions
       WHERE would_trade = 1 AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
    )
    .get(`-${windowMinutes} minutes`) as { n: number };
  return row.n;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: PASS (all new tests, plus every pre-existing test in this file
still green).

- [ ] **Step 5: Commit**

```bash
git add src/decide/ledger.ts test/decide/ledger.test.ts
git commit -m "feat: add recentTradeCount, a global rolling-window real-fill counter"
```

---

### Task 2: Wire the rate limit into the decision pipeline

**Files:**
- Modify: `src/decide/pipeline.ts`
- Test: `test/decide/pipeline.test.ts`

**Interfaces:**
- Consumes: `recentTradeCount`, `MAX_TRADES_PER_WINDOW`,
  `RATE_LIMIT_WINDOW_MINUTES` (Task 1).
- Produces: nothing new for later tasks — this is the last task in this plan.

- [ ] **Step 1: Write the failing tests**

Add to `test/decide/pipeline.test.ts`, in the existing
`describe('runDecisionPipeline', ...)` block (reuse `baseItem`, `stubLadder`,
`stubKalshiClient`, `client`, `db`, and this file's existing
`orderModule.placeOrder`/`synopsisModule.synopsize` spies exactly as its
neighboring tests do — find the existing kill-switch test for the exact
fixture/assertion style to match):

```typescript
it('declines a second item within the rate-limit window, without spending a single model call on it', async () => {
  const first = baseItem({ item_id: 'item-rate-1', dedup_id: 'dedup-rate-1', story_key: 'story-rate-1' });
  await runDecisionPipeline(first, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });
  // Confirm the fixture actually produced a real fill -- if it didn't, this
  // test would trivially "pass" for the wrong reason.
  expect(onlyRowFor(db, first.item_id).would_trade).toBe(1);

  vi.mocked(synopsisModule.synopsize).mockClear();
  const second = baseItem({ item_id: 'item-rate-2', dedup_id: 'dedup-rate-2', story_key: 'story-rate-2' });
  await runDecisionPipeline(second, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });

  const row = onlyRowFor(db, second.item_id);
  expect(row.would_trade).toBe(0);
  expect(row.reason).toBe('rate limit: 1 trade(s) per 15 minutes already reached');
  expect(synopsisModule.synopsize).not.toHaveBeenCalled();
});

it('trades normally when the prior real fill is OUTSIDE the rate-limit window', async () => {
  const first = baseItem({ item_id: 'item-rate-old-1', dedup_id: 'dedup-rate-old-1', story_key: 'story-rate-old-1' });
  await runDecisionPipeline(first, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });
  expect(onlyRowFor(db, first.item_id).would_trade).toBe(1);
  // Backdate the first fill well outside the 15-minute window.
  db.prepare("UPDATE decisions SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') WHERE item_id = ?").run(first.item_id);

  const second = baseItem({ item_id: 'item-rate-old-2', dedup_id: 'dedup-rate-old-2', story_key: 'story-rate-old-2' });
  await runDecisionPipeline(second, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });

  expect(onlyRowFor(db, second.item_id).would_trade).toBe(1);
});

it('a burst of would_trade=false decisions never blocks a later item from trading', async () => {
  vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
    direction: 'up', magnitudePts: 0.3, shouldTrade: false, reasoning: 'no edge',
  });
  for (let i = 0; i < 3; i++) {
    const item = baseItem({ item_id: `item-noedge-${i}`, dedup_id: `dedup-noedge-${i}`, story_key: `story-noedge-${i}` });
    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });
    expect(onlyRowFor(db, item.item_id).would_trade).toBe(0);
  }
  // Re-apply the SAME default mock this file's beforeEach sets (do NOT use
  // mockRestore() here -- that would revert to the REAL decideTrade, which
  // makes a real Sonnet API call).
  vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
    direction: 'up', magnitudePts: 0.3, shouldTrade: true,
    reasoning: 'stronger-than-expected jobs data typically lifts approval',
  });

  const tradeable = baseItem({ item_id: 'item-noedge-then-trade', dedup_id: 'dedup-noedge-then-trade', story_key: 'story-noedge-then-trade' });
  await runDecisionPipeline(tradeable, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });

  expect(onlyRowFor(db, tradeable.item_id).would_trade).toBe(1);
});
```

(This file already imports `decideModule`/`orderModule`/`synopsisModule` as
namespace imports for spying — reuse those exact names; if the third test's
`decideTrade` mock shape doesn't match this file's existing default mock
signature, check the existing `beforeEach`'s default `decideTrade` mock for
the exact fields expected and match it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts`
Expected: FAIL — nothing rate-limits yet, so the second item in the first
test trades normally instead of declining.

- [ ] **Step 3: Implement**

Read the CURRENT state of `src/decide/pipeline.ts` in full before editing —
find the exact real `if (rung === 'rumor') { ...; return; }` block (this
plan's Global Constraints describe where it sits relative to the kill-switch
check and the `synopsize` call, but confirm the exact current line numbers by
reading the file, since it has changed across multiple prior slices).

Add `recentTradeCount`, `MAX_TRADES_PER_WINDOW`, `RATE_LIMIT_WINDOW_MINUTES`
to this file's existing import from `./ledger.js`. Immediately after the
`rung === 'rumor'` block's closing `}` and before the `const synopsis =
await synopsize(...)` line, add:

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `direnv exec . npm test` and `direnv exec . npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/decide/pipeline.ts test/decide/pipeline.test.ts
git commit -m "feat: rate-limit real trades to 1 per 15 minutes, checked before any model call"
```
