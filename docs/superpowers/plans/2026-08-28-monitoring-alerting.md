# Monitoring / Alerting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a Slack alert for the three highest-signal events in this system —
a circuit breaker trip, a new market divergence block, and a process restart
following an unclean exit — since every existing safety mechanism currently only
speaks through `console.log`/`console.error`, which nobody watches in real time.

**Architecture:** A single new `src/alert.ts` module (`sendAlert`, fire-and-forget,
one retry, never throws) wired into the exact call sites that already know
whether something genuinely NEW just happened (a `false → true`
`isTradingHalted` transition, or slice 6's existing `wasAlreadyBlocked` guard) —
no changes to any existing ledger function's signature. A new one-row
`process_lifecycle` table detects an unclean exit at the NEXT startup, since a
genuinely crashing process cannot reliably fire an async alert itself.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, better-sqlite3, no new
dependencies (Slack's incoming-webhook API is a plain HTTP POST).

**Spec:** `docs/superpowers/specs/2026-08-28-monitoring-alerting-design.md`

## Global Constraints

- `SLACK_WEBHOOK_URL` is read from the environment at call time, never
  hardcoded, and optional — if unset, `sendAlert` logs a warning and no-ops
  rather than throwing.
- Every `sendAlert(...)` call site invokes it WITHOUT `await` (fire-and-forget)
  — the retry-with-delay logic lives entirely inside `sendAlert` itself and must
  never delay or crash the trading code path that triggered it.
- `sendAlert` never throws and never rejects — every internal failure path
  (including after the one retry) is caught and logged inside the function.
- No existing function in `src/decide/ledger.ts` (`tripBreaker`, `blockMarket`,
  `checkFailedOrdersSignal`, `checkDivergencesSignal`) changes signature or
  becomes async — `better-sqlite3` stays fully synchronous, matching this
  project's architecture since slice 1.
- No automated test ever posts to a real Slack webhook — every test mocks
  `fetch`.
- Entry-only scope is unaffected; this slice makes no trading decisions and
  touches no order-placement logic.

---

### Task 1: `sendAlert` — Slack delivery with one retry

**Files:**
- Create: `src/alert.ts`
- Test: `test/alert.test.ts`

**Interfaces:**
- Produces: `export async function sendAlert(message: string): Promise<void>` —
  used by every later task. Never throws.

- [ ] **Step 1: Write the failing tests**

Create `test/alert.test.ts`:

```typescript
// test/alert.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendAlert } from '../src/alert.js';

describe('sendAlert', () => {
  let fetchSpy: { mockRestore: () => void } | undefined;
  const ORIGINAL_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/FAKE';
  });
  afterEach(() => {
    vi.useRealTimers();
    fetchSpy?.mockRestore();
    if (ORIGINAL_WEBHOOK_URL === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = ORIGINAL_WEBHOOK_URL;
  });

  it('posts the message as-is on the first successful attempt, exactly once', async () => {
    let calls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls += 1;
      expect(JSON.parse(init?.body as string)).toEqual({ text: 'hello operator' });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetchSpy;

    await sendAlert('hello operator');

    expect(calls).toBe(1);
  });

  it('retries exactly once after a short delay when the first attempt fails, then succeeds', async () => {
    let calls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return new Response('down', { status: 500 });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetchSpy;

    const promise = sendAlert('retry me');
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(calls).toBe(2);
  });

  it('gives up after the retry also fails, without throwing', async () => {
    let calls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      return new Response('still down', { status: 500 });
    }) as unknown as typeof fetchSpy;

    const promise = sendAlert('give up eventually');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBeUndefined();

    expect(calls).toBe(2);
  });

  it('is a no-op (no fetch call) when SLACK_WEBHOOK_URL is unset', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;

    await sendAlert('nobody hears this');

    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/alert.test.ts`
Expected: FAIL — `src/alert.ts` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/alert.ts`:

```typescript
// src/alert.ts

const RETRY_DELAY_MS = 2000;

async function postToSlack(webhookUrl: string, message: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack webhook responded ${res.status}: ${text.slice(0, 500)}`);
  }
}

/**
 * Fire-and-forget from every call site (never awaited) -- this function never
 * throws or rejects, so no call site needs its own try/catch or .catch(). On
 * failure, waits RETRY_DELAY_MS and tries once more; if that also fails, logs
 * loudly and gives up. Reads SLACK_WEBHOOK_URL from the environment at CALL
 * time (not import time) so tests can freely set/unset it per-case; if unset,
 * this is a logged no-op, so local dev and the test suite never need a real
 * webhook configured.
 */
export async function sendAlert(message: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[alert] SLACK_WEBHOOK_URL is not set -- alert not sent:', message);
    return;
  }

  try {
    await postToSlack(webhookUrl, message);
  } catch (firstErr) {
    console.error('[alert] first attempt failed, retrying once:', firstErr);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await postToSlack(webhookUrl, message);
    } catch (secondErr) {
      console.error('[alert] retry also failed, giving up:', secondErr);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/alert.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/alert.ts test/alert.test.ts
git commit -m "feat: add sendAlert, a fire-and-forget Slack webhook with one retry"
```

---

### Task 2: Process-lifecycle tracking in the ledger

**Files:**
- Modify: `src/decide/ledger.ts`
- Test: `test/decide/ledger.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function recordProcessStarting(db: Database.Database):
  boolean` and `export function recordProcessStoppedCleanly(db:
  Database.Database): void` — both used by Task 3.

- [ ] **Step 1: Write the failing tests**

Add to `test/decide/ledger.test.ts`, in a new `describe('process lifecycle',
...)` block alongside the existing `describe('circuit breakers', ...)` block
(same file, same `beforeEach`/`afterEach` temp-ledger setup already in that
file):

```typescript
import { recordProcessStarting, recordProcessStoppedCleanly } from '../../src/decide/ledger.js';

describe('process lifecycle', () => {
  it('recordProcessStarting returns false on the very first boot (no prior row)', () => {
    expect(recordProcessStarting(db)).toBe(false);
  });

  it('recordProcessStarting returns true when the previous run never called recordProcessStoppedCleanly (an unclean exit)', () => {
    recordProcessStarting(db); // first boot -- returns false, marks 'running'
    // Process "crashes" here -- no recordProcessStoppedCleanly call.
    expect(recordProcessStarting(db)).toBe(true); // next boot detects it
  });

  it('recordProcessStarting returns false again after a clean shutdown', () => {
    recordProcessStarting(db);
    recordProcessStoppedCleanly(db);
    expect(recordProcessStarting(db)).toBe(false);
  });

  it('recordProcessStarting always marks the run "running", so a THIRD unclean exit in a row is still detected', () => {
    recordProcessStarting(db);
    expect(recordProcessStarting(db)).toBe(true); // crash 1 detected
    expect(recordProcessStarting(db)).toBe(true); // crash 2 detected -- still 'running' from crash 1's boot
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: FAIL — `recordProcessStarting`/`recordProcessStoppedCleanly` are not
exported yet.

- [ ] **Step 3: Add the schema and implementation**

In `src/decide/ledger.ts`, add to the `SCHEMA` template string, immediately
before its closing backtick (after the existing `circuit_breaker_trips` table):

```sql
CREATE TABLE IF NOT EXISTS process_lifecycle (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('running', 'stopped_cleanly'))
);
```

Then add, at the end of the file (after the existing `checkDivergencesSignal`
function):

```typescript
/**
 * Called once at startup, right after openLedger. Returns true if the
 * PREVIOUS run never reached recordProcessStoppedCleanly -- an unclean exit
 * (an uncaught exception, an OOM kill, a SIGKILL) -- because the row still
 * says 'running' from that run. A missing row (the very first boot ever)
 * returns false, not true: there is no prior run to have crashed. Either way,
 * marks THIS run 'running' before returning, so if this run also dies
 * uncleanly, the NEXT startup detects it in turn.
 */
export function recordProcessStarting(db: Database.Database): boolean {
  const row = db.prepare(`SELECT state FROM process_lifecycle WHERE id = 1`).get() as
    { state: string } | undefined;
  const wasUnclean = row?.state === 'running';
  db.prepare(
    `INSERT INTO process_lifecycle (id, state) VALUES (1, 'running')
     ON CONFLICT(id) DO UPDATE SET state = 'running'`
  ).run();
  return wasUnclean;
}

export function recordProcessStoppedCleanly(db: Database.Database): void {
  db.prepare(
    `INSERT INTO process_lifecycle (id, state) VALUES (1, 'stopped_cleanly')
     ON CONFLICT(id) DO UPDATE SET state = 'stopped_cleanly'`
  ).run();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/ledger.test.ts`
Expected: PASS (all new tests, plus every pre-existing test in this file still
green).

- [ ] **Step 5: Commit**

```bash
git add src/decide/ledger.ts test/decide/ledger.test.ts
git commit -m "feat: add process_lifecycle tracking for unclean-exit detection"
```

---

### Task 3: Wire crash-detection and clean-shutdown alerting into main.ts

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `sendAlert` (Task 1), `recordProcessStarting`/
  `recordProcessStoppedCleanly` (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Implement**

Read the CURRENT state of `src/main.ts` in full before editing — line numbers
may have shifted from what's shown here.

Add to the existing import from `./decide/ledger.js`:
```typescript
  recordProcessStarting,
  recordProcessStoppedCleanly,
```
Add a new import:
```typescript
import { sendAlert } from './alert.js';
```

Right after `const db = openLedger(DEFAULT_LEDGER_PATH);`:
```typescript
  if (recordProcessStarting(db)) {
    sendAlert(
      '[UNCLEAN-EXIT] process restarted after an unclean exit. ' +
        'Check logs for the cause before assuming trading resumed safely.'
    );
  }
```

Right after `await runOnce(...)` resolves (i.e., immediately after the closing
`);` of the `await runOnce(...)` call, BEFORE `reconciliationTimer.stop();`):
```typescript
  recordProcessStoppedCleanly(db);
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `direnv exec . npm test` and `direnv exec . npm run typecheck`
Expected: PASS / clean. **No new test is needed in `test/main.test.ts` for this
wiring** — confirmed by reading that file: it never calls `main()` and never
constructs a real `KalshiClient` or a real process lifecycle anywhere (every
test injects its own stub/mock dependencies directly into `makeOnItem`/
`reconcilePendingOrders`). This is the same established, deliberate project
pattern already confirmed twice before (slice 5's startup-reconciliation
wiring, slice 6's `KalshiClient({ db })` wiring) — if you find this claim is no
longer true when you read the current file, add a test instead of skipping it.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: alert on an unclean-exit restart, mark clean shutdowns"
```

---

### Task 4: Wire circuit-breaker-trip alerting into both failed-orders call sites

**Files:**
- Modify: `src/decide/pipeline.ts`
- Modify: `src/execute/order.ts`
- Test: `test/decide/pipeline.test.ts`, `test/execute/order.test.ts`

**Interfaces:**
- Consumes: `sendAlert` (Task 1), `isTradingHalted` (already exists in
  `src/decide/ledger.ts` since slice 6).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `test/decide/pipeline.test.ts`, in the same `describe('runDecisionPipeline',
...)` block as the existing slice-6 test `'trips the failed-orders breaker
after enough real would-trade decisions resolve to rejected'` (reuse
`baseItem`, `stubLadder`, `stubKalshiClient`, `client`, `db`, and the
`orderModule.placeOrder` mock override exactly as that existing test does):

```typescript
import * as alertModule from '../../src/alert.js';

it('alerts exactly once when the failed-orders breaker trips, not again on a further already-tripped failure', async () => {
  const alertSpy = vi.spyOn(alertModule, 'sendAlert').mockResolvedValue(undefined);
  vi.spyOn(orderModule, 'placeOrder').mockResolvedValue({
    clientOrderId: 'rejected-mock-client-order-id',
    kalshiOrderId: null,
    kalshiOrderStatus: null,
    filledContracts: 0,
    avgFillPriceCents: null,
    status: 'rejected',
    dryRun: false,
    errorDetail: 'simulated 400 for this test',
  });

  for (let i = 0; i < CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD; i++) {
    const item = baseItem({
      item_id: `item-alert-${i}`, dedup_id: `dedup-alert-${i}`, story_key: `story-alert-${i}`,
    });
    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });
  }
  expect(alertSpy).toHaveBeenCalledTimes(1); // tripped on the LAST of the threshold failures

  // One more failure while already tripped -- checkFailedOrdersSignal's own
  // per-signal dedup means isTradingHalted stays true->true, so no new alert.
  const oneMore = baseItem({ item_id: 'item-alert-extra', dedup_id: 'dedup-alert-extra', story_key: 'story-alert-extra' });
  await runDecisionPipeline(oneMore, { anthropicClient: client, db, fetchLadder: vi.fn().mockResolvedValue(stubLadder()), kalshiClient: stubKalshiClient() });
  expect(alertSpy).toHaveBeenCalledTimes(1);
});
```

Import `CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD` from `'../../src/decide/ledger.js'`
alongside this file's other ledger imports, if not already imported.

Add to `test/execute/order.test.ts`, in the same `describe('reconcilePendingOrders',
...)` block as the existing slice-6 test that trips the failed-orders breaker
via startup reconciliation (reuse `pendingSetup`, `mockClient` exactly as that
test does):

```typescript
import * as alertModule from '../../src/alert.js';

it('alerts exactly once when the failed-orders breaker trips via startup reconciliation', async () => {
  const alertSpy = vi.spyOn(alertModule, 'sendAlert').mockResolvedValue(undefined);
  for (let i = 0; i < CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD; i++) {
    pendingSetup({ clientOrderId: `cid-alert-${i}` });
  }
  const client = mockClient({
    getOrders: async () => ({ orders: [] }),
    getPositions: async () => ({ market_positions: [] }),
  });

  await reconcilePendingOrders(db, client);

  expect(alertSpy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts test/execute/order.test.ts`
Expected: FAIL — nothing calls `sendAlert` yet.

- [ ] **Step 3: Implement**

In `src/decide/pipeline.ts`, add `sendAlert` to its imports (new import from
`../alert.js`; `isTradingHalted` is already imported from `./ledger.js`).
Change the existing line
```typescript
    checkFailedOrdersSignal(db, placed.status);
```
to:
```typescript
    const wasHaltedBeforeCheck = isTradingHalted(db);
    checkFailedOrdersSignal(db, placed.status);
    if (!wasHaltedBeforeCheck && isTradingHalted(db)) {
      sendAlert(
        '[CIRCUIT-BREAKER-TRIPPED] signal=failed-orders (repeated failed/ambiguous ' +
          'order outcomes). Check circuit_breaker_trips.reason and run ' +
          'npm run clear-breaker after investigating.'
      );
    }
```

In `src/execute/order.ts`, add `sendAlert` to its imports (new import from
`./alert.js` -- note the relative path from `src/execute/` is `../alert.js`,
not `./alert.js`) and `isTradingHalted` to its existing import from
`../decide/ledger.js`. Change the existing line
```typescript
      checkFailedOrdersSignal(db, reconciled.status);
```
to:
```typescript
      const wasHaltedBeforeCheck = isTradingHalted(db);
      checkFailedOrdersSignal(db, reconciled.status);
      if (!wasHaltedBeforeCheck && isTradingHalted(db)) {
        sendAlert(
          '[CIRCUIT-BREAKER-TRIPPED] signal=failed-orders (repeated failed/ambiguous ' +
            'order outcomes, detected during startup reconciliation). Check ' +
            'circuit_breaker_trips.reason and run npm run clear-breaker after investigating.'
        );
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/pipeline.test.ts test/execute/order.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `direnv exec . npm test` and `direnv exec . npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/decide/pipeline.ts src/execute/order.ts test/decide/pipeline.test.ts test/execute/order.test.ts
git commit -m "feat: alert on a failed-orders circuit breaker trip at both call sites"
```

---

### Task 5: Wire market-block and divergences-trip alerting into reconcileOpenPositions

**Files:**
- Modify: `src/execute/reconcileOpenPositions.ts`
- Test: `test/execute/reconcileOpenPositions.test.ts`

**Interfaces:**
- Consumes: `sendAlert` (Task 1), `isTradingHalted` (already exists in
  `src/decide/ledger.ts` since slice 6).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Add to `test/execute/reconcileOpenPositions.test.ts`, in the existing
`describe('reconcileOpenPositions', ...)` block (reuse `recordOpenDecision`,
`mockClient`, `mockFetchMarketStatus` exactly as the existing tests do):

```typescript
import * as alertModule from '../../src/alert.js';

it('alerts once on a genuinely new market block, but not on a re-block of an already-blocked ticker', async () => {
  const alertSpy = vi.spyOn(alertModule, 'sendAlert').mockResolvedValue(undefined);
  recordOpenDecision(db, { marketTicker: 'ALERT-A', side: 'yes', contracts: 10 });
  const client = mockClient({ 'ALERT-A': 0 }); // a real divergence

  await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
  expect(alertSpy).toHaveBeenCalledTimes(1);

  // Second pass: still diverged, but already blocked -- must not alert again.
  await reconcileOpenPositions({ db, client, fetchMarketStatus: mockFetchMarketStatus({}) });
  expect(alertSpy).toHaveBeenCalledTimes(1);
});

it('alerts a second time, for the breaker itself, once enough distinct new blocks cross the divergences threshold', async () => {
  const alertSpy = vi.spyOn(alertModule, 'sendAlert').mockResolvedValue(undefined);
  recordOpenDecision(db, { marketTicker: 'ALERT-B', side: 'yes', contracts: 10 });
  const clientB = mockClient({ 'ALERT-B': 0 });
  await reconcileOpenPositions({ db, client: clientB, fetchMarketStatus: mockFetchMarketStatus({}) });
  expect(alertSpy).toHaveBeenCalledTimes(1); // market-block alert only

  recordOpenDecision(db, { marketTicker: 'ALERT-C', side: 'yes', contracts: 5 });
  const clientC = mockClient({ 'ALERT-B': 0, 'ALERT-C': 0 });
  await reconcileOpenPositions({ db, client: clientC, fetchMarketStatus: mockFetchMarketStatus({}) });
  // A second new market-block alert, PLUS the breaker-trip alert -- 3 total.
  expect(alertSpy).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: FAIL — nothing calls `sendAlert` yet.

- [ ] **Step 3: Implement**

In `src/execute/reconcileOpenPositions.ts`, add `sendAlert` to its imports (new
import from `../alert.js`) and `isTradingHalted` to its existing import from
`../decide/ledger.js`. Read the current file's divergence branch in full
before editing (it currently computes `wasAlreadyBlocked`, calls `blockMarket`,
logs `[RECONCILE-DIVERGENCE]`, then conditionally calls `checkDivergencesSignal`
only `if (!wasAlreadyBlocked)`). Change that final conditional block from:
```typescript
        if (!wasAlreadyBlocked) {
          checkDivergencesSignal(db);
        }
```
to:
```typescript
        if (!wasAlreadyBlocked) {
          sendAlert(
            `[RECONCILE-DIVERGENCE] market_ticker=${marketTicker} ${reason}. ` +
              `Run npm run clear-block after investigating.`
          );
          const wasHaltedBeforeCheck = isTradingHalted(db);
          checkDivergencesSignal(db);
          if (!wasHaltedBeforeCheck && isTradingHalted(db)) {
            sendAlert(
              '[CIRCUIT-BREAKER-TRIPPED] signal=divergences (multiple distinct markets ' +
                'diverged recently). Check circuit_breaker_trips.reason and run ' +
                'npm run clear-breaker after investigating.'
            );
          }
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/execute/reconcileOpenPositions.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `direnv exec . npm test` and `direnv exec . npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/execute/reconcileOpenPositions.ts test/execute/reconcileOpenPositions.test.ts
git commit -m "feat: alert on a new market block and on a divergences breaker trip"
```

---

### Task 6: Operator documentation

**Files:**
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new for later tasks (final task).

- [ ] **Step 1: Add a pre-go-live checklist item**

In `HANDOFF.md`'s `### 5a.2 Pre-go-live checklist` section, read the current
numbered list in full, then add one new item at the end (renumbering is not
needed if the list doesn't use fixed cross-references elsewhere -- check for
that before adding):

```markdown
N. **Confirm `SLACK_WEBHOOK_URL` is set before trading with real money.**
   Without it, `sendAlert` silently no-ops (logged as a warning) -- every
   circuit-breaker trip, market-block, and unclean-exit restart still happens
   and is still recorded in the ledger, but no human gets paged. Verify with a
   real (throwaway) webhook URL that a test message actually lands in the
   right Slack channel before relying on this in production.
```

- [ ] **Step 2: Add an operator runbook section**

Add a new subsection right after `### 5a.2a Automatic circuit breakers` (added
by slice 6) -- read that section's existing structure and voice first, then
add:

```markdown
### 5a.2b Slack alerting (added in slice 7)

Three events post to Slack via `SLACK_WEBHOOK_URL` (a plain incoming-webhook
POST, no other configuration): any circuit breaker trip (slice 6), any
genuinely NEW market block from slice 5's reconciliation (not a re-block of an
already-blocked ticker), and a process restart following an unclean exit
(detected via the `process_lifecycle` table at the NEXT startup -- a real
crash cannot reliably alert from inside itself).

Each alert names the specific condition and the exact recovery command
(`npm run clear-breaker` / `npm run clear-block <ticker>`), but does not
duplicate the full `reason` text already visible in the console log and the
relevant table (`circuit_breaker_trips`/`market_blocks`) -- check those for
detail before acting.

Delivery is fire-and-forget with one retry: a Slack outage or network blip
never delays or crashes the trading code path that triggered the alert, but it
does mean an alert can occasionally be lost entirely (both the original
attempt and the retry failing) with nothing else surfacing that specific
failure beyond a log line. Treat Slack alerting as a convenience layer on top
of the ledger's own durable state (`circuit_breaker_trips`, `market_blocks`,
`process_lifecycle`), never as the sole source of truth for whether something
happened.
```

- [ ] **Step 3: Run the full suite and typecheck**

Run: `direnv exec . npm test` and `direnv exec . npm run typecheck`
Expected: PASS / clean (documentation-only change, no behavior affected).

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md
git commit -m "docs: add Slack alerting to the pre-go-live checklist and operator runbook"
```
