# US500 Perp Bot — Plan 3: Engine, Intake and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire plans 1 and 2 into a running service: the orchestrating engine (snapshot, evaluate, execute, reconcile, kill switch, funding), the IIP news intake, startup mode guards, the systemd paper and demo units, the evaluation report, and the runbook with the Phase 0 / Phase 1 gates.

**Architecture:** One `PerpEngine` owns all mutable state behind a mutex; the intake and a 60-second timer feed it. Everything real (Kalshi, Anthropic, Redis, filesystem, clock) is injected, so the engine is tested end to end with `PaperBroker`, fake collectors and a controllable clock. The shipped units are pinned to paper/demo on the `ExecStart` line, so no env file can make them trade real money.

**Tech Stack:** TypeScript (ESM, `NodeNext`, imports end in `.js`), zod 3, better-sqlite3, vitest, the executor's own `StreamConsumer`, `createRedisClient`, `acquireLedgerLock`, `sendAlert`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-us500-perp-bot-design.md`. Requires plans 1 and 2 complete on branch `feat/perp-bot`.

## Global Constraints

- Everything from plan 1's and plan 2's Global Constraints applies (worktree `~/executor_module-perp` on mini-mac, branch `feat/perp-bot`, edits only under `src/perp/`, `test/perp/`, `scripts/perp-*.ts`, `config/perp-*`, `deploy/mini-mac/perp-*`, `docs/`, plus the two small edits to plan-1/2 files named in Task 1; commit identity flags and trailer; never push or merge; baseline of 30 unrelated failing tests).
- Default mode is **paper**. `demo` and `live` require `PERP_SUBACCOUNT` (integer 1-63; the primary account 0 is never used). `live` additionally requires `PERP_LIVE=<ticker>:<subaccount>` exactly. The shipped systemd units pin `PERP_MODE` on the `ExecStart` line and strip `PERP_LIVE`. **No unit file for live trading ships in this plan; creating one needs the user's explicit approval after the Phase 1 gates.**
- The IIP stream key is `iip:items` (same as the executor's `STREAM_KEY`); the bot's consumer group is `perpbot`, consumer `perpbot-primary`, started at `'$'` (tail only). The bot never modifies IIP.
- Tick every 60 seconds (`PERP_TICK_MS`); macro data refreshed every 15 minutes; Kalshi event markets every 5 minutes (only if `PERP_KALSHI_EVENT_TICKERS` is set, comma separated).
- Model spend cap: `PERP_DAILY_USD_CAP`, default 5 (USD per UTC day). Stale-news cutoff: items whose publish time is more than 6 hours old are skipped. Publish-time price lookup tolerance: 120 seconds.
- Funding settles daily at 20:00 UTC; the paper broker applies the last funding estimate seen before the settlement.
- Alerts go through `sendAlert` (Slack); the engine never awaits them.
- Per-mode SQLite file: `data/perp/perp-<mode>.db` under the repo (`PERP_DATA_DIR` overrides), with the executor's pidfile lock (`acquireLedgerLock`).

## Review Focus

1. Restart with an open position: a stored position must be reconciled with the broker (kept, vanished, or orphaned) and never silently dropped or doubled (Task 3).
2. An operator clearing a halt must not be re-halted at once by the same old exits (Task 3).
3. News published before we have a price history, or arriving before the first snapshot, must never open a position (Task 3).
4. A hostile `.env` must not be able to make a shipped unit demo/live or retarget it (Task 5).
5. A failing collector or broker call must not crash the loop, hide an open position, or spam alerts (Task 3).
6. A model provider outage or spend cap must stop news-driven action loudly (one alert per day) without disturbing the exchange-side stop (Task 4).

## File Structure

| File | Responsibility |
|---|---|
| `src/perp/engine/mutex.ts`, `src/perp/engine/helpers.ts` | serialization and small pure helpers |
| `src/perp/ops/clearHalt.ts` | operator halt clear with kill-switch epoch |
| `src/perp/engine/engine.ts` | `PerpEngine` (tick, onAssessment, reconcile, execute) |
| `src/perp/intake/newsIntake.ts` | IIP item -> gate -> extractor -> engine |
| `src/perp/startup.ts` | `resolveMode`, `createBroker` |
| `src/perp/main.ts` | process wiring and lifecycle |
| `deploy/mini-mac/perp-bot.service`, `perp-bot-demo.service` | pinned paper and demo units |
| `src/perp/eval/calibration.ts`, `scripts/perp-report.ts`, `scripts/perp-clear-halt.ts` | evaluation and operator tools |
| `docs/runbook-perp.md` | operations, gates, off switch |

---

### Task 1: Small prerequisite edits to plan-1/2 files

**Files:**
- Modify: `src/perp/broker/paper.ts`, `src/perp/store/db.ts`, `src/perp/broker/kalshiMarginBroker.ts`
- Test: append to `test/perp/paperBroker.test.ts`, `test/perp/store.test.ts`

**Interfaces:**
- Produces: `PaperPos` and `PaperState { cash: number; pos: PaperPos | null }` exported from `paper.ts`; `PaperBroker.exportState(): PaperState`, `PaperBroker.importState(s: PaperState): void`; `equityPeak(db, sinceMs = 0): number`; `fetchMarginQuote(client: Pick<KalshiMarginClient,'get'>, ticker: string, nowMs: number): Promise<BrokerQuote>` exported from `kalshiMarginBroker.ts` (and `KalshiMarginBroker.quote()` delegates to it).

- [ ] **Step 1: Append the failing tests**

Append to the end of `test/perp/paperBroker.test.ts`:

```ts
describe('PaperBroker persistence', () => {
  it('restores cash, position, stop and watermark in a fresh broker', async () => {
    const a = harness();
    await a.broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    a.setMark(14.0);
    await a.broker.poll(); // watermark 14.0
    const saved = JSON.parse(JSON.stringify(a.broker.exportState()));

    const b = harness();
    b.broker.importState(saved);
    b.setMark(14.0);
    expect((await b.broker.position())?.side).toBe('long');
    b.setMark(13.45); // below 14.0 * (1 - 0.0388): the carried-over watermark matters
    expect((await b.broker.poll())[0]?.kind).toBe('stopped_out');
  });
  it('exports a flat state as pos=null', async () => {
    expect(harness().broker.exportState()).toEqual({ cash: 3.5, pos: null });
  });
});
```

Append to the end of `test/perp/store.test.ts`:

```ts
describe('equityPeak window', () => {
  it('limits the peak to rows at or after sinceMs', () => {
    const db2 = openPerpDb(':memory:');
    recordEquity(db2, T, 9);
    recordEquity(db2, T + 10, 5);
    expect(equityPeak(db2)).toBe(9);
    expect(equityPeak(db2, T + 5)).toBe(5);
    expect(equityPeak(db2, T + 100)).toBe(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/paperBroker.test.ts test/perp/store.test.ts`
Expected: FAIL (`exportState` is not a function; the `equityPeak` window assertion fails).

- [ ] **Step 3: Edit `src/perp/broker/paper.ts`**

Change `interface PaperPos {` to `export interface PaperPos {`. Directly after the closing brace of `PaperPos`, add:

```ts
export interface PaperState {
  cash: number;
  pos: PaperPos | null;
}
```

Inside `class PaperBroker`, immediately above the `applyFunding` doc comment, add:

```ts
  /** Serializable state, so a paper position and its cash survive a restart. */
  exportState(): PaperState {
    return { cash: this.cash, pos: this.pos === null ? null : { ...this.pos } };
  }

  importState(s: PaperState): void {
    this.cash = s.cash;
    this.pos = s.pos === null ? null : { ...s.pos };
  }

```

- [ ] **Step 4: Edit `src/perp/store/db.ts`**

Replace the `equityPeak` function with:

```ts
export function equityPeak(db: Database.Database, sinceMs = 0): number {
  const row = db.prepare('SELECT MAX(equity) AS m FROM equity WHERE ts_ms >= ?').get(sinceMs) as { m: number | null };
  return row.m ?? 0;
}
```

- [ ] **Step 5: Edit `src/perp/broker/kalshiMarginBroker.ts`**

Above `export class KalshiMarginBroker`, add the standalone function (moving the body of `quote()` into it):

```ts
/** Perp bid/ask/mark from the margin market endpoint; throws when the quote is unusable. */
export async function fetchMarginQuote(client: Pick<KalshiMarginClient, 'get'>, ticker: string, nowMs: number): Promise<BrokerQuote> {
  const { market } = await client.get<{
    market: { bid?: string; ask?: string; price?: string; liquidation_mark_price?: { price?: string } };
  }>(`/margin/markets/${ticker}`);
  const bid = num(market.bid);
  const ask = num(market.ask);
  // Assumption to verify in Phase 0: stops and liquidation are evaluated on the liquidation mark price.
  const mark = num(market.liquidation_mark_price?.price ?? market.price);
  if (![bid, ask, mark].every(Number.isFinite) || bid <= 0 || ask <= 0) {
    throw new Error(`kalshi: unusable quote for ${ticker}`);
  }
  return { bid, ask, mark, tsMs: nowMs };
}
```

and replace the body of `async quote()` with:

```ts
  async quote(): Promise<BrokerQuote> {
    return fetchMarginQuote(this.client, this.cfg.ticker, this.now());
  }
```

- [ ] **Step 6: Run the whole perp suite and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp && npx tsc --noEmit`
Expected: all pass (the existing `quote` tests in `kalshiMarginBroker.test.ts` still pass through the delegate).

- [ ] **Step 7: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): paper state export/import, windowed equity peak, fetchMarginQuote

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Mutex, helpers and operator halt-clear

**Files:**
- Create: `src/perp/engine/mutex.ts`, `src/perp/engine/helpers.ts`, `src/perp/ops/clearHalt.ts`, `test/perp/engineParts.test.ts`

**Interfaces:**
- Produces: `class Mutex { run<T>(fn: () => Promise<T>): Promise<T> }` (strictly serial, in call order; a rejected task does not block later ones); `extremeSince(series: Array<{ tsMs: number; mark: number }>, side: Side): number | null` (max for a long, min for a short); `clearHaltInDb(db, nowMs): { wasHalted: boolean; reason: string | null }` (clears the halt, writes state key `killEpoch = { sinceMs: nowMs }`, journals `halt_cleared`).

- [ ] **Step 1: Write the failing test `test/perp/engineParts.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/perp/engine/mutex.js';
import { extremeSince } from '../../src/perp/engine/helpers.js';
import { clearHaltInDb } from '../../src/perp/ops/clearHalt.js';
import { getState, listJournal, loadRiskState, openPerpDb, saveRiskState } from '../../src/perp/store/db.js';
import { haltRisk, initialRiskState } from '../../src/perp/risk/state.js';

describe('Mutex', () => {
  it('runs tasks strictly one at a time, in call order', async () => {
    const m = new Mutex();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([m.run(task('a', 20)), m.run(task('b', 1)), m.run(task('c', 1))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });
  it('a rejected task rejects its own caller but does not block the next one', async () => {
    const m = new Mutex();
    const bad = m.run(async () => {
      throw new Error('boom');
    });
    const good = m.run(async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
  });
});

describe('extremeSince', () => {
  const s = [{ tsMs: 1, mark: 13.5 }, { tsMs: 2, mark: 14.1 }, { tsMs: 3, mark: 13.9 }];
  it('is the max for a long, the min for a short, and null when empty', () => {
    expect(extremeSince(s, 'long')).toBe(14.1);
    expect(extremeSince(s, 'short')).toBe(13.5);
    expect(extremeSince([], 'long')).toBeNull();
  });
});

describe('clearHaltInDb (review focus 2)', () => {
  it('clears the halt, records a kill-switch epoch, and journals it', () => {
    const db = openPerpDb(':memory:');
    saveRiskState(db, haltRisk(initialRiskState(), '2 stop-outs in 30 days'));
    const out = clearHaltInDb(db, 5000);
    expect(out).toEqual({ wasHalted: true, reason: '2 stop-outs in 30 days' });
    expect(loadRiskState(db).halted).toBe(false);
    expect(getState(db, 'killEpoch')).toEqual({ sinceMs: 5000 });
    expect(listJournal(db, 'halt_cleared', 1)).toHaveLength(1);
  });
  it('is harmless when the bot was not halted', () => {
    const db = openPerpDb(':memory:');
    expect(clearHaltInDb(db, 1)).toEqual({ wasHalted: false, reason: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/engineParts.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write the three modules**

`src/perp/engine/mutex.ts`:

```ts
// src/perp/engine/mutex.ts
/** Strictly serial async executor: tasks run one at a time in call order; a rejected task never blocks the next. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
```

`src/perp/engine/helpers.ts`:

```ts
// src/perp/engine/helpers.ts
import type { Side } from '../types.js';

/** Best mark in the series in the position's favour: the highest for a long, the lowest for a short. */
export function extremeSince(series: Array<{ tsMs: number; mark: number }>, side: Side): number | null {
  if (series.length === 0) return null;
  let best = series[0].mark;
  for (const p of series) best = side === 'long' ? Math.max(best, p.mark) : Math.min(best, p.mark);
  return best;
}
```

`src/perp/ops/clearHalt.ts`:

```ts
// src/perp/ops/clearHalt.ts
import type Database from 'better-sqlite3';
import { clearHalt } from '../risk/state.js';
import { appendJournal, loadRiskState, saveRiskState, setState } from '../store/db.js';

/**
 * Operator action: lift a halt. Records a kill-switch epoch so exits and equity peaks from before the clear no longer
 * count, otherwise the same old stop-outs would re-halt the bot on the next tick. The running bot re-reads the risk
 * state from the database on every tick, so this works while the service is up.
 */
export function clearHaltInDb(db: Database.Database, nowMs: number): { wasHalted: boolean; reason: string | null } {
  const risk = loadRiskState(db);
  const out = { wasHalted: risk.halted, reason: risk.haltReason };
  saveRiskState(db, clearHalt(risk));
  setState(db, 'killEpoch', { sinceMs: nowMs });
  appendJournal(db, { tsMs: nowMs, kind: 'halt_cleared', payload: out });
  return out;
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/engineParts.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): mutex, extremeSince, operator halt clear with kill-switch epoch

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The engine

**Files:**
- Create: `src/perp/engine/engine.ts`, `test/perp/engine.test.ts`

**Interfaces:**
- Consumes: everything from plans 1-2 and Tasks 1-2.
- Produces:
  - `interface Collected { perp: Snapshot['perp']; perpFetchedAtMs: number; macro: Record<string, MacroPoint>; macroFetchedAtMs: number | null; events: ScheduledEvent[]; kalshiEvents: Snapshot['kalshiEvents'] }`
  - `interface EngineDeps { cfg: PerpConfig; db: Database; broker: Broker; now: () => number; collect: () => Promise<Collected>; alert: (message: string) => void; persistBroker?: () => void; applyFunding?: (rate: number, markPrice: number) => number }`
  - `class PerpEngine { constructor(d: EngineDeps); start(): Promise<void>; tick(): Promise<void>; onAssessment(a: ImpactAssessment): Promise<void>; contextText(): string | null; status(): { position: PositionState | null; halted: boolean; haltReason: string | null; pressure: number; mark: number | null; consecutiveFailures: number } }`. All three async methods are serialized by one `Mutex`; none of them rejects (errors are journaled and alerted).
- Behavior contract (spec 4, 5, 10): each tick builds a snapshot, polls the broker for stop-outs/liquidations, applies paper funding, runs the kill switch, evaluates the policy, and executes the action. A news-driven exit flips immediately if the opposite entry passes. Journal rows: `decision` (non-hold, or with news, or one hold per 10 minutes), `open`, `open_failed`, `close`, `close_failed`, `set_stop`, `set_stop_failed`, `broker_event`, `reconcile`, `funding`, `tick_error`.

- [ ] **Step 1: Write the failing test `test/perp/engine.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { DEFAULT_PAPER_CONFIG, PaperBroker, type PaperState } from '../../src/perp/broker/paper.js';
import type { BrokerQuote } from '../../src/perp/broker/types.js';
import { PerpEngine, type Collected } from '../../src/perp/engine/engine.js';
import { clearHaltInDb } from '../../src/perp/ops/clearHalt.js';
import {
  getState, listExits, listJournal, loadPosition, loadRiskState, openPerpDb, setState,
} from '../../src/perp/store/db.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const NOW0 = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;
let seq = 0;

function harness(over: { startEquityUsd?: number } = {}) {
  let now = NOW0;
  const q = { bid: 13.75, ask: 13.76, mark: 13.755 };
  const getQuote = async (): Promise<BrokerQuote> => ({ ...q, tsMs: now });
  const broker = new PaperBroker(getQuote, { ...DEFAULT_PAPER_CONFIG, ...over }, () => now);
  const db = openPerpDb(':memory:');
  const alerts: string[] = [];
  let collectError: Error | null = null;
  const collect = async (): Promise<Collected> => {
    if (collectError) throw collectError;
    return {
      perp: { bid: q.bid, ask: q.ask, mark: q.mark, marketOpen: true, nextCloseTsMs: NOW0 + 3 * 24 * H, fundingEstimate: 0.0001 },
      perpFetchedAtMs: now,
      macro: { vix: { value: 16, change1d: 0, asOf: '2026-10-13' } },
      macroFetchedAtMs: now,
      events: [],
      kalshiEvents: [],
    };
  };
  const newEngine = (b: PaperBroker) =>
    new PerpEngine({
      cfg: DEFAULT_CONFIG, db, broker: b, now: () => now, collect, alert: (m) => alerts.push(m),
      persistBroker: () => setState(db, 'paper', b.exportState()),
      applyFunding: (r, m) => b.applyFunding(r, m),
    });
  return {
    broker, db, alerts, engine: newEngine(broker), newEngine, getQuote,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    setMark: (m: number) => { q.mark = m; q.bid = m - 0.005; q.ask = m + 0.005; },
    setCollectError: (e: Error | null) => { collectError = e; },
  };
}
type H = ReturnType<typeof harness>;

const assess = (h: H, over: Partial<ImpactAssessment> = {}): ImpactAssessment => ({
  itemId: `item-${++seq}`, receivedAtMs: h.now(), publishedAtMs: h.now() - 30_000, direction: 'up', bucket: 'major',
  horizon: 'days', credibility: 0.8, novelty: 'new', alreadyPriced: 'no', confidence: 0.75, rationale: 'test', ...over,
});
async function openLong(h: H, over: Partial<ImpactAssessment> = {}) {
  await h.engine.tick();
  await h.engine.onAssessment(assess(h, over));
}
async function stopOut(h: H) {
  h.setMark(14.2);
  await h.engine.tick();
  h.setMark(13.6); // 14.2 * (1 - 0.0388) = 13.649
  await h.engine.tick();
}

describe('entries', () => {
  it('opens a long on credible bullish news, sizes the stop from realized leverage, and journals it', async () => {
    const h = harness();
    await openLong(h);
    expect((await h.broker.position())?.side).toBe('long');
    const stored = loadPosition(h.db)!;
    expect(stored.side).toBe('long');
    expect(stored.stopBps).toBe(388);
    expect(stored.leverage).toBeCloseTo(13.755 / 3.5, 6);
    expect(listJournal(h.db, 'open', 5)).toHaveLength(1);
    expect(h.alerts.join('\n')).toMatch(/OPENED long/);
  });

  it('records news but does nothing before the first snapshot exists (review focus 3)', async () => {
    const h = harness();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
  });

  it('never enters on news published before we had any price history (review focus 3)', async () => {
    const h = harness();
    await h.engine.tick();
    await h.engine.onAssessment(assess(h, { publishedAtMs: h.now() - 2 * H }));
    expect(await h.broker.position()).toBeNull();
  });

  it('journals and alerts a failed open without throwing or tracking a position', async () => {
    const h = harness();
    await h.engine.tick();
    vi.spyOn(h.broker, 'open').mockRejectedValue(new Error('exchange down'));
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
    expect(loadPosition(h.db)).toBeNull();
    expect(listJournal(h.db, 'open_failed', 1)).toHaveLength(1);
    expect(h.alerts.join('\n')).toMatch(/open failed/i);
  });
});

describe('exits', () => {
  it('after an exchange-side stop-out both sides cool down for 24h and a fresh bullish item is ignored', async () => {
    const h = harness();
    await openLong(h);
    await stopOut(h);
    expect(await h.broker.position()).toBeNull();
    expect(loadPosition(h.db)).toBeNull();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['trailing_stop']);
    expect(loadRiskState(h.db).cooldownUntilMs.long).toBe(h.now() + 24 * H);
    h.advance(10 * MIN);
    h.setMark(13.755);
    await h.engine.tick();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
  });

  it('a credible adverse shock exits the long and flips to a short immediately', async () => {
    const h = harness();
    await openLong(h);
    await h.engine.onAssessment(assess(h, { direction: 'down', bucket: 'shock', credibility: 1, confidence: 0.9 }));
    expect((await h.broker.position())?.side).toBe('short');
    expect(listExits(h.db, 0).map((e) => [e.rule, e.side])).toEqual([['shock', 'long']]);
    expect(loadRiskState(h.db).cooldownUntilMs.long).toBeGreaterThan(h.now());
    expect(loadPosition(h.db)?.side).toBe('short');
  });

  it('keeps the position when a close cannot fill, and retries on the next evaluation', async () => {
    const h = harness();
    await openLong(h);
    const spy = vi.spyOn(h.broker, 'close').mockRejectedValueOnce(new Error('no liquidity'));
    await h.engine.onAssessment(assess(h, { direction: 'down', bucket: 'shock', credibility: 1, confidence: 0.9 }));
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(listJournal(h.db, 'close_failed', 1)).toHaveLength(1);
    spy.mockRestore();
    h.advance(MIN);
    // The failed evaluation already counted one adverse-pressure breach (-2.7% vs the 2% exit threshold); the next
    // tick is the second consecutive breach, so the pressure rule closes the position even without a new item.
    await h.engine.tick();
    expect(await h.broker.position()).toBeNull();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['pressure']);
  });
});

describe('kill switch (review focus 2)', () => {
  async function twoStopOuts() {
    const h = harness();
    await openLong(h);
    await stopOut(h);
    h.advance(25 * H);
    h.setMark(13.755);
    await h.engine.tick();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).not.toBeNull();
    await stopOut(h);
    return h;
  }

  it('halts after two stop-outs in 30 days and refuses further entries', async () => {
    const h = await twoStopOuts();
    expect(loadRiskState(h.db).halted).toBe(true);
    expect(h.alerts.join('\n')).toMatch(/HALT/);
    h.advance(25 * H);
    h.setMark(13.755);
    await h.engine.tick();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
  });

  it('clearing the halt starts a new epoch: the old exits do not re-halt it', async () => {
    const h = await twoStopOuts();
    clearHaltInDb(h.db, h.now());
    h.advance(MIN);
    await h.engine.tick();
    expect(loadRiskState(h.db).halted).toBe(false);
  });
});

describe('restart reconciliation (review focus 1)', () => {
  it('keeps a stored position when the restored broker still holds it', async () => {
    const h = harness();
    await openLong(h);
    const b2 = new PaperBroker(h.getQuote, DEFAULT_PAPER_CONFIG, h.now);
    b2.importState(getState<PaperState>(h.db, 'paper')!);
    const e2 = h.newEngine(b2);
    await e2.start();
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(h.alerts.join('\n')).not.toMatch(/vanished/);
  });

  it('records a position that vanished while the bot was down as an unverified stop-out', async () => {
    const h = harness();
    await openLong(h);
    const flat = new PaperBroker(h.getQuote, DEFAULT_PAPER_CONFIG, h.now);
    const e2 = h.newEngine(flat);
    await e2.start();
    expect(loadPosition(h.db)).toBeNull();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['trailing_stop']);
    expect(h.alerts.join('\n')).toMatch(/vanished/);
  });

  it('adopts an orphan broker position and protects it with a stop', async () => {
    const h = harness();
    await h.broker.open({ side: 'short', contracts: 1, stopBps: 400 });
    await h.engine.start();
    const p = loadPosition(h.db)!;
    expect(p.side).toBe('short');
    expect(p.stopBps).toBe(388);
    expect(h.alerts.join('\n')).toMatch(/orphan/i);
  });
});

describe('resilience (review focus 5)', () => {
  it('survives collector failures, alerts once at 5 consecutive failures, and recovers', async () => {
    const h = harness();
    await h.engine.tick();
    h.setCollectError(new Error('boom'));
    for (let i = 0; i < 7; i++) await h.engine.tick();
    expect(h.alerts.filter((a) => /consecutive/.test(a))).toHaveLength(1);
    expect(h.engine.status().consecutiveFailures).toBe(7);
    h.setCollectError(null);
    await h.engine.tick();
    expect(h.engine.status().consecutiveFailures).toBe(0);
    h.setCollectError(new Error('boom'));
    for (let i = 0; i < 5; i++) await h.engine.tick();
    expect(h.alerts.filter((a) => /consecutive/.test(a))).toHaveLength(2);
  });

  it('serializes a tick and a news item that arrive at the same time', async () => {
    const h = harness();
    await h.engine.tick();
    await Promise.all([h.engine.tick(), h.engine.onAssessment(assess(h)), h.engine.tick()]);
    expect(listJournal(h.db, 'open', 5)).toHaveLength(1);
  });
});

describe('paper funding', () => {
  it('charges the last pre-settlement estimate once per UTC day after 20:00', async () => {
    const h = harness();
    await openLong(h); // 15:00Z
    h.advance(4 * H + 50 * MIN); // 19:50Z
    await h.engine.tick();
    const before = (await h.broker.balance()).equityUsd;
    h.advance(11 * MIN); // 20:01Z
    await h.engine.tick();
    const after = (await h.broker.balance()).equityUsd;
    expect(before - after).toBeCloseTo(0.0001 * 13.755, 6);
    h.advance(MIN);
    await h.engine.tick();
    expect((await h.broker.balance()).equityUsd).toBeCloseTo(after, 8);
  });
});

describe('contextText / status', () => {
  it('is null before the first snapshot and describes the position afterwards', async () => {
    const h = harness();
    expect(h.engine.contextText()).toBeNull();
    await openLong(h);
    expect(h.engine.contextText()).toContain('position: long');
    expect(h.engine.status().position?.side).toBe('long');
    expect(h.engine.status().mark).toBe(13.755);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/engine.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/engine/engine.ts`**

```ts
// src/perp/engine/engine.ts
import type Database from 'better-sqlite3';
import type { Broker, BrokerEvent } from '../broker/types.js';
import type { PerpConfig } from '../config.js';
import { summarizeContext } from '../model/context.js';
import { decide, type NewItem, type PolicyInput } from '../policy/policy.js';
import { stopFraction } from '../quant/formulas.js';
import { PressureBook } from '../quant/pressure.js';
import { computeGovernors } from '../risk/governor.js';
import { evaluateKillSwitch } from '../risk/killSwitch.js';
import { applyEntry, applyExit, haltRisk, type RiskState } from '../risk/state.js';
import { buildSnapshot, vixOf } from '../snapshot/builder.js';
import {
  appendJournal, equityPeak, getState, listAssessments, listExits, loadPosition, loadRiskState, markSeries,
  recordAssessment, recordEquity, recordExit as recordExitRow, saveRiskState, savePosition, saveSnapshot, setState,
  snapshotNear,
} from '../store/db.js';
import type { Action, ExitRule, ImpactAssessment, MacroPoint, PositionState, ScheduledEvent, Side, Snapshot } from '../types.js';
import { extremeSince } from './helpers.js';
import { Mutex } from './mutex.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NEWS_EXIT_RULES: ReadonlySet<ExitRule> = new Set<ExitRule>(['shock', 'slow_bleed', 'pressure']);
const PUBLISH_SNAPSHOT_MAX_GAP_MS = 2 * MIN;
const HOLD_JOURNAL_EVERY_MS = 10 * MIN;
const CONSECUTIVE_FAILURE_ALERT = 5;

export interface Collected {
  perp: Snapshot['perp'];
  perpFetchedAtMs: number;
  macro: Record<string, MacroPoint>;
  macroFetchedAtMs: number | null;
  events: ScheduledEvent[];
  kalshiEvents: Snapshot['kalshiEvents'];
}

export interface EngineDeps {
  cfg: PerpConfig;
  db: Database.Database;
  broker: Broker;
  now: () => number;
  collect: () => Promise<Collected>;
  /** Fire-and-forget notification (Slack). */
  alert: (message: string) => void;
  /** Persists broker state that lives only in memory (paper). Called after every state change. */
  persistBroker?: () => void;
  /** Paper only: applies one funding settlement and returns the USD charged. */
  applyFunding?: (rate: number, markPrice: number) => number;
}

export class PerpEngine {
  private readonly lock = new Mutex();
  private readonly book: PressureBook;
  private risk: RiskState;
  private position: PositionState | null;
  private breachStreak: number;
  private latest: Snapshot | null = null;
  private lastFundingEstimate: number | null = null;
  private consecutiveFailures = 0;
  private lastHoldJournalMs = 0;

  constructor(private readonly d: EngineDeps) {
    this.book = new PressureBook(d.cfg);
    this.risk = loadRiskState(d.db);
    this.position = loadPosition(d.db);
    this.breachStreak = getState<number>(d.db, 'breachStreak') ?? 0;
    for (const a of listAssessments(d.db, d.now() - 20 * DAY)) this.book.add(a);
  }

  start(): Promise<void> {
    return this.lock.run(() => this.reconcile());
  }

  tick(): Promise<void> {
    return this.lock.run(() => this.tickInner());
  }

  onAssessment(a: ImpactAssessment): Promise<void> {
    return this.lock.run(() => this.assessInner(a));
  }

  contextText(): string | null {
    if (this.latest === null) return null;
    const now = this.d.now();
    return summarizeContext({
      snapshot: this.latest,
      position: this.position,
      pressureNow: this.book.at(now),
      topItems: this.book.top(now, 3),
    });
  }

  status() {
    return {
      position: this.position,
      halted: this.risk.halted,
      haltReason: this.risk.haltReason,
      pressure: this.book.at(this.d.now()),
      mark: this.latest?.perp.mark ?? null,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  // ---- tick ---------------------------------------------------------------------------------------------------

  private async tickInner(): Promise<void> {
    const now = this.d.now();
    try {
      this.risk = loadRiskState(this.d.db); // picks up an operator halt-clear
      const snapshot = await this.collectSnapshot(now);
      this.applyFundingIfDue(now); // uses the estimate from BEFORE this snapshot: the new period's estimate has reset
      this.lastFundingEstimate = snapshot.perp.fundingEstimate ?? this.lastFundingEstimate;
      const events = await this.d.broker.poll();
      if (events.length > 0) this.handleBrokerEvents(events, now);
      await this.checkKillSwitch(now);
      await this.evaluate(snapshot, [], true);
      if (this.position !== null) savePosition(this.d.db, this.position);
      this.d.persistBroker?.();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      appendJournal(this.d.db, { tsMs: now, kind: 'tick_error', payload: { error: msg, consecutive: this.consecutiveFailures } });
      console.error('[perp-engine] tick failed:', msg);
      if (this.consecutiveFailures === CONSECUTIVE_FAILURE_ALERT) {
        this.d.alert(
          `[PERP] ${CONSECUTIVE_FAILURE_ALERT} consecutive tick failures (latest: ${msg}). ` +
            (this.position !== null ? 'The open position stays protected by the exchange-side stop.' : 'No position is open.')
        );
      }
    }
  }

  private async collectSnapshot(now: number): Promise<Snapshot> {
    const c = await this.d.collect();
    const snapshot = buildSnapshot({
      nowMs: now,
      perp: c.perp,
      perpFetchedAtMs: c.perpFetchedAtMs,
      macro: c.macro,
      macroFetchedAtMs: c.macroFetchedAtMs,
      events: c.events,
      kalshiEvents: c.kalshiEvents,
      history: markSeries(this.d.db, now - 8 * DAY),
    });
    saveSnapshot(this.d.db, snapshot);
    this.latest = snapshot;
    return snapshot;
  }

  private applyFundingIfDue(now: number): void {
    const apply = this.d.applyFunding;
    if (apply === undefined || this.lastFundingEstimate === null || this.latest === null) return;
    const d = new Date(now);
    const settlement = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20);
    const day = d.toISOString().slice(0, 10);
    if (now < settlement || getState<string>(this.d.db, 'lastFundingDay') === day) return;
    const charge = apply(this.lastFundingEstimate, this.latest.perp.mark);
    setState(this.d.db, 'lastFundingDay', day);
    appendJournal(this.d.db, { tsMs: now, kind: 'funding', payload: { rate: this.lastFundingEstimate, chargeUsd: charge } });
  }

  private handleBrokerEvents(events: BrokerEvent[], now: number): void {
    for (const e of events) {
      // An external close of unknown cause is treated as a stop-out: the conservative cooldown and kill-switch count.
      const rule: ExitRule = e.kind === 'closed_externally' ? 'trailing_stop' : e.rule;
      const pnl = e.pnlUsd ?? 0;
      this.recordExitAndRisk(rule, e.side, pnl, now);
      this.position = null;
      savePosition(this.d.db, null);
      appendJournal(this.d.db, { tsMs: now, kind: 'broker_event', payload: { ...e, classifiedAs: rule } });
      this.d.alert(
        e.kind === 'closed_externally'
          ? `[PERP ${this.d.broker.mode}] ${e.side} position was closed outside the bot (P&L ${e.pnlUsd === null ? 'unknown' : e.pnlUsd.toFixed(3)}); treated as a stop-out. Verify on Kalshi.`
          : `[PERP ${this.d.broker.mode}] ${e.kind === 'liquidated' ? 'LIQUIDATED' : 'stopped out'} ${e.side}, P&L ${e.pnlUsd.toFixed(3)} USD`
      );
    }
  }

  private async checkKillSwitch(now: number): Promise<void> {
    const bal = await this.d.broker.balance();
    recordEquity(this.d.db, now, bal.equityUsd);
    const epoch = getState<{ sinceMs: number }>(this.d.db, 'killEpoch')?.sinceMs ?? 0;
    const res = evaluateKillSwitch({
      exits: listExits(this.d.db, Math.max(epoch, now - 30 * DAY)),
      equityPeak: equityPeak(this.d.db, epoch),
      equityNow: bal.equityUsd,
      nowMs: now,
      cfg: this.d.cfg,
    });
    if (res.halt && !this.risk.halted) {
      this.risk = haltRisk(this.risk, res.reason ?? 'kill switch');
      saveRiskState(this.d.db, this.risk);
      appendJournal(this.d.db, { tsMs: now, kind: 'halt', payload: { reason: res.reason } });
      this.d.alert(`[PERP ${this.d.broker.mode}] HALTED: ${res.reason}. No new entries until the operator clears it (npm run perp-clear-halt).`);
    }
  }

  // ---- news ---------------------------------------------------------------------------------------------------

  private async assessInner(a: ImpactAssessment): Promise<void> {
    try {
      if (!recordAssessment(this.d.db, a)) return; // duplicate delivery
      this.book.add(a);
      const snap = this.latest;
      if (snap === null) return;
      const item: NewItem = { ...a, movedSincePublish: this.movedSincePublish(a, snap) };
      await this.evaluate(snap, [item], true);
      if (this.position !== null) savePosition(this.d.db, this.position);
      this.d.persistBroker?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendJournal(this.d.db, { tsMs: this.d.now(), kind: 'assess_error', payload: { itemId: a.itemId, error: msg } });
      console.error('[perp-engine] assessment handling failed:', msg);
    }
  }

  /** Perp move since the item's publish time, signed in the item's direction; null when we have no price from then. */
  private movedSincePublish(a: ImpactAssessment, snap: Snapshot): number | null {
    if (a.direction === 'neutral') return 0;
    const then = snapshotNear(this.d.db, a.publishedAtMs, PUBLISH_SNAPSHOT_MAX_GAP_MS);
    if (then === null || then.perp.mark <= 0) return null;
    const move = snap.perp.mark / then.perp.mark - 1;
    return a.direction === 'up' ? move : -move;
  }

  // ---- evaluate / execute -------------------------------------------------------------------------------------

  private async evaluate(snapshot: Snapshot, newItems: NewItem[], allowFlip: boolean): Promise<void> {
    const { cfg, db, broker } = this.d;
    const now = this.d.now();
    const mark = snapshot.perp.mark;
    if (this.position !== null) {
      const p = this.position;
      p.extreme = p.side === 'long' ? Math.max(p.extreme, mark) : Math.min(p.extreme, mark);
    }

    const governors = computeGovernors(cfg, vixOf(snapshot), snapshot.realizedWeeklySigma);
    const bal = await broker.balance();
    const bp = this.position !== null ? await broker.position() : null;
    const realizedLeverage = this.position === null && bal.equityUsd > 0 ? mark / bal.equityUsd : null; // 1 contract
    const weeklyExtreme =
      this.position === null
        ? null
        : extremeSince(markSeries(db, Math.max(this.position.entryTimeMs, now - 7 * DAY)), this.position.side);

    const input: PolicyInput = {
      nowMs: now,
      cfg,
      snapshot,
      position: this.position,
      pressureNow: this.book.at(now),
      pressure12hAgo: this.book.at(now - 12 * HOUR),
      newItems,
      governors,
      realizedLeverage,
      liqDistance: bp?.liqDistance ?? null,
      weeklyExtreme,
      risk: this.risk,
      prevBreachStreak: this.breachStreak,
    };
    const out = decide(input);
    this.breachStreak = out.breachStreak;
    setState(db, 'breachStreak', this.breachStreak);

    const interesting = out.action.kind !== 'hold' || newItems.length > 0;
    if (interesting || now - this.lastHoldJournalMs >= HOLD_JOURNAL_EVERY_MS) {
      if (!interesting) this.lastHoldJournalMs = now;
      appendJournal(db, {
        tsMs: now,
        kind: 'decision',
        payload: {
          action: out.action,
          pressureNow: input.pressureNow,
          mark,
          position: this.position?.side ?? null,
          items: newItems.map((i) => i.itemId),
          leverageEff: { long: governors.long.leverageEff, short: governors.short.leverageEff },
          sigmaSource: governors.long.sigmaSource,
          realizedLeverage,
        },
      });
    }
    await this.execute(out.action, snapshot, newItems, allowFlip);
  }

  private async execute(a: Action, snapshot: Snapshot, newItems: NewItem[], allowFlip: boolean): Promise<void> {
    const { db, broker } = this.d;
    const now = this.d.now();

    if (a.kind === 'open') {
      const stopBps = Math.max(1, Math.round(a.stopFrac * 10_000));
      try {
        const fill = await broker.open({ side: a.side, contracts: 1, stopBps });
        this.position = {
          side: a.side, contracts: fill.contracts, entryPrice: fill.price, entryTimeMs: now,
          extreme: snapshot.perp.mark, leverage: a.leverage, stopBps, tightenedUntilMs: null,
        };
        savePosition(db, this.position);
        this.risk = applyEntry(this.risk, a.side);
        saveRiskState(db, this.risk);
        this.d.persistBroker?.();
        appendJournal(db, { tsMs: now, kind: 'open', payload: { side: a.side, fill, stopBps, leverage: a.leverage, reasons: a.reasons } });
        this.d.alert(
          `[PERP ${broker.mode}] OPENED ${a.side} ${fill.contracts} @ ${fill.price} (stop ${stopBps} bps, ~${a.leverage.toFixed(2)}x). ${a.reasons[0] ?? ''}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendJournal(db, { tsMs: now, kind: 'open_failed', payload: { side: a.side, error: msg } });
        this.d.alert(`[PERP ${broker.mode}] open failed (${a.side}): ${msg}`);
      }
      return;
    }

    if (a.kind === 'close' && this.position !== null) {
      const side = this.position.side;
      try {
        const res = await broker.close();
        this.recordExitAndRisk(a.rule, side, res.pnlUsd, now);
        this.position = null;
        savePosition(db, null);
        this.d.persistBroker?.();
        appendJournal(db, { tsMs: now, kind: 'close', payload: { rule: a.rule, side, fill: res, reasons: a.reasons } });
        this.d.alert(`[PERP ${broker.mode}] CLOSED ${side} (${a.rule}) @ ${res.price}, P&L ${res.pnlUsd.toFixed(3)} USD. ${a.reasons[0] ?? ''}`);
        await this.checkKillSwitch(now);
        if (allowFlip && NEWS_EXIT_RULES.has(a.rule)) await this.evaluate(snapshot, newItems, false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendJournal(db, { tsMs: now, kind: 'close_failed', payload: { rule: a.rule, error: msg } });
        this.d.alert(`[PERP ${broker.mode}] close failed (${a.rule}): ${msg}. The exchange-side stop remains in force; retrying next evaluation.`);
      }
      return;
    }

    if (a.kind === 'set_stop' && this.position !== null) {
      const bps = Math.max(1, Math.round(a.stopFrac * 10_000));
      try {
        await broker.setTrailingStop(bps);
        this.position = { ...this.position, stopBps: bps, tightenedUntilMs: a.holdMs === null ? null : now + a.holdMs };
        savePosition(db, this.position);
        this.d.persistBroker?.();
        appendJournal(db, { tsMs: now, kind: 'set_stop', payload: { bps, holdMs: a.holdMs, reasons: a.reasons } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendJournal(db, { tsMs: now, kind: 'set_stop_failed', payload: { bps, error: msg } });
        this.d.alert(`[PERP ${broker.mode}] could not update the trailing stop to ${bps} bps: ${msg}`);
      }
    }
  }

  private recordExitAndRisk(rule: ExitRule, side: Side, pnlUsd: number, now: number): void {
    recordExitRow(this.d.db, { atMs: now, rule, side, pnlUsd });
    this.risk = applyExit(this.risk, { rule, side, atMs: now }, this.d.cfg);
    saveRiskState(this.d.db, this.risk);
    this.breachStreak = 0;
    setState(this.d.db, 'breachStreak', 0);
  }

  // ---- startup reconciliation ---------------------------------------------------------------------------------

  private async reconcile(): Promise<void> {
    const { db, broker, cfg } = this.d;
    const now = this.d.now();
    try {
      const bp = await broker.position();
      const stored = this.position;
      if (stored === null && bp === null) return;

      try {
        if (this.latest === null) await this.collectSnapshot(now);
      } catch {
        // No snapshot yet: an adopted position falls back to the widest allowed stop below.
      }

      if (stored !== null && bp === null) {
        appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'vanished', stored } });
        this.recordExitAndRisk('trailing_stop', stored.side, 0, now);
        this.position = null;
        savePosition(db, null);
        this.d.alert(`[PERP ${broker.mode}] the stored ${stored.side} position vanished while the bot was down; recorded as an unverified stop-out. Check Kalshi.`);
        return;
      }
      if (stored === null && bp !== null) {
        const bal = await broker.balance();
        const lev = bal.equityUsd > 0 ? (bp.markPrice * bp.contracts) / bal.equityUsd : cfg.leverageTarget;
        const gov = this.latest === null ? null : computeGovernors(cfg, vixOf(this.latest), this.latest.realizedWeeklySigma)[bp.side];
        const stopBps = Math.round((gov === null ? cfg.stopCap : stopFraction(gov.sigmaWeek, lev, cfg)) * 10_000);
        await broker.setTrailingStop(stopBps);
        this.position = {
          side: bp.side, contracts: bp.contracts, entryPrice: bp.entryPrice, entryTimeMs: now,
          extreme: bp.markPrice, leverage: lev, stopBps, tightenedUntilMs: null,
        };
        savePosition(db, this.position);
        appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'orphan_adopted', position: this.position } });
        this.d.alert(`[PERP ${broker.mode}] found an orphan ${bp.side} position at the broker; adopted it and set a ${stopBps} bps trailing stop.`);
        return;
      }
      if (stored !== null && bp !== null && stored.side !== bp.side) {
        this.risk = haltRisk(this.risk, `stored ${stored.side} position conflicts with broker ${bp.side} position`);
        saveRiskState(db, this.risk);
        appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'side_mismatch', stored, broker: bp } });
        this.d.alert(`[PERP ${broker.mode}] HALTED: stored ${stored.side} position conflicts with the broker's ${bp.side} position. Resolve manually.`);
        return;
      }
      appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'consistent' } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendJournal(db, { tsMs: now, kind: 'reconcile_error', payload: { error: msg } });
      this.d.alert(`[PERP ${this.d.broker.mode}] startup reconciliation failed: ${msg}`);
    }
  }
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/engine.test.ts && npx tsc --noEmit`
Expected: all pass. If a number is off, re-derive it from the spec formula before touching an assertion. Reference numbers: with VIX 16 and a paper equity of 3.5 the realized leverage is `13.755 / 3.5 = 3.93`, the stop is `clamp(1.75 x 0.022188 = 3.883%, 3%, min(5%, 20%/3.93 = 5.09%))` = 388 bps, a `major` item at credibility 0.8, confidence 0.75 contributes `0.03 x 0.8 x 0.75 = 1.8%` (above the 1.5% long threshold), and a `shock` at credibility 1, confidence 0.9 contributes `-4.5%`.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): engine (tick, news, execute, flip, kill switch, funding, reconcile)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: News intake

**Files:**
- Create: `src/perp/intake/newsIntake.ts`, `test/perp/intake.test.ts`

**Interfaces:**
- Consumes: `parseItemFields`, `Item` from `src/item.ts`; `StreamEntry` from `src/redis/consumer.ts`; `SpendCapError` (plan 2 Task 4); `ImpactAssessment`.
- Produces: `type IntakeResult = 'assessed' | 'gated_out' | 'skipped_replay' | 'skipped_amended' | 'skipped_old' | 'skipped_seen' | 'skipped_no_context' | 'parse_error' | 'error'`; `interface IntakeDeps { db: Database; now: () => number; alert: (m: string) => void; engine: { contextText(): string | null; onAssessment(a: ImpactAssessment): Promise<void> }; gate: (item: Item) => Promise<{ relevant: boolean; reason: string }>; extract: (item: Item, contextText: string) => Promise<ImpactAssessment>; maxAgeMs?: number }`; `class NewsIntake { constructor(d: IntakeDeps); handleEntry(entry: StreamEntry): Promise<IntakeResult>; handleItem(item: Item): Promise<IntakeResult>; readonly counters: Record<IntakeResult, number> }`. Neither handler ever rejects.

- [ ] **Step 1: Write the failing test `test/perp/intake.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import type { Item } from '../../src/item.js';
import { NewsIntake } from '../../src/perp/intake/newsIntake.js';
import { SpendCapError } from '../../src/perp/model/callJson.js';
import { listJournal, openPerpDb } from '../../src/perp/store/db.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;

const item = (over: Partial<Item> = {}): Item => ({
  item_id: `i-${Math.random()}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false,
  source_id: 'reuters', adapter: 'rss', trust_tier: 1, headline: 'Fed cuts rates', snippet: null, url: null, raw_url: null,
  enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0,
  provenance_gaps: [], amends_item_id: null, amendment_kind: null, ...over,
});

function mk(over: Record<string, unknown> = {}) {
  const calls = { gate: 0, extract: [] as string[], assessed: [] as ImpactAssessment[] };
  const alerts: string[] = [];
  let ctx: string | null = 'CTX';
  const db = openPerpDb(':memory:');
  const intake = new NewsIntake({
    db, now: () => NOW, alert: (m) => alerts.push(m),
    engine: { contextText: () => ctx, onAssessment: async (a) => { calls.assessed.push(a); } },
    gate: async () => { calls.gate += 1; return { relevant: true, reason: 'r' }; },
    extract: async (it, c) => {
      calls.extract.push(c);
      return { itemId: it.item_id, receivedAtMs: NOW, publishedAtMs: NOW - 60_000, direction: 'up', bucket: 'minor', horizon: 'days', credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r' };
    },
    ...over,
  } as never);
  return { intake, calls, alerts, db, setCtx: (c: string | null) => { ctx = c; } };
}

describe('NewsIntake', () => {
  it('gates, extracts with the engine context, and hands the assessment to the engine', async () => {
    const { intake, calls } = mk();
    expect(await intake.handleItem(item())).toBe('assessed');
    expect(calls.gate).toBe(1);
    expect(calls.extract).toEqual(['CTX']);
    expect(calls.assessed).toHaveLength(1);
  });

  it('skips replays, amendments and stale items without calling any model', async () => {
    const { intake, calls } = mk();
    expect(await intake.handleItem(item({ replay: true }))).toBe('skipped_replay');
    expect(await intake.handleItem(item({ event_type: 'item_amended' }))).toBe('skipped_amended');
    expect(await intake.handleItem(item({ source_publish_ts: new Date(NOW - 7 * H).toISOString() }))).toBe('skipped_old');
    expect(calls.gate).toBe(0);
  });

  it('a redelivered item id is processed only once', async () => {
    const { intake, calls } = mk();
    const it = item({ item_id: 'same' });
    expect(await intake.handleItem(it)).toBe('assessed');
    expect(await intake.handleItem(it)).toBe('skipped_seen');
    expect(calls.gate).toBe(1);
  });

  it('stops after the gate when the item is not relevant', async () => {
    const { intake, calls } = mk({ gate: async () => ({ relevant: false, reason: 'sports' }) });
    expect(await intake.handleItem(item())).toBe('gated_out');
    expect(calls.extract).toHaveLength(0);
  });

  it('skips when the engine has no context yet (no snapshot)', async () => {
    const m = mk();
    m.setCtx(null);
    expect(await m.intake.handleItem(item())).toBe('skipped_no_context');
    expect(m.calls.gate).toBe(0);
  });

  it('alerts once per UTC day when the model spend cap is hit, and never throws (review focus 6)', async () => {
    const { intake, alerts } = mk({ gate: async () => { throw new SpendCapError('cap reached'); } });
    expect(await intake.handleItem(item())).toBe('error');
    expect(await intake.handleItem(item())).toBe('error');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/spend cap/);
    expect(alerts[0]).toMatch(/exchange-side stop/);
  });

  it('records other model errors in the journal without alerting', async () => {
    const { intake, alerts, db } = mk({ extract: async () => { throw new Error('503'); } });
    expect(await intake.handleItem(item())).toBe('error');
    expect(alerts).toHaveLength(0);
    expect(listJournal(db, 'intake_error', 5)).toHaveLength(1);
  });

  it('handleEntry parses a stream entry and reports a malformed one as parse_error', async () => {
    const { intake, calls, db } = mk();
    expect(await intake.handleEntry({ id: '1-0', fields: { json: JSON.stringify(item()) } })).toBe('assessed');
    expect(calls.assessed).toHaveLength(1);
    expect(await intake.handleEntry({ id: '2-0', fields: { json: '{"headline": 1}' } })).toBe('parse_error');
    expect(await intake.handleEntry({ id: '3-0', fields: {} })).toBe('parse_error');
    expect(listJournal(db, 'intake_parse_error', 5)).toHaveLength(2);
  });

  it('counts outcomes', async () => {
    const { intake } = mk();
    await intake.handleItem(item());
    await intake.handleItem(item({ replay: true }));
    expect(intake.counters.assessed).toBe(1);
    expect(intake.counters.skipped_replay).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/intake.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/intake/newsIntake.ts`**

```ts
// src/perp/intake/newsIntake.ts
import type Database from 'better-sqlite3';
import { parseItemFields, type Item } from '../../item.js';
import type { StreamEntry } from '../../redis/consumer.js';
import { SpendCapError } from '../model/callJson.js';
import { appendJournal } from '../store/db.js';
import type { ImpactAssessment } from '../types.js';

export type IntakeResult =
  | 'assessed' | 'gated_out' | 'skipped_replay' | 'skipped_amended' | 'skipped_old' | 'skipped_seen'
  | 'skipped_no_context' | 'parse_error' | 'error';

export interface IntakeDeps {
  db: Database.Database;
  now: () => number;
  alert: (message: string) => void;
  engine: { contextText(): string | null; onAssessment(a: ImpactAssessment): Promise<void> };
  gate: (item: Item) => Promise<{ relevant: boolean; reason: string }>;
  extract: (item: Item, contextText: string) => Promise<ImpactAssessment>;
  /** Items whose publish time is older than this are skipped. Default 6 hours. */
  maxAgeMs?: number;
}

const SEEN_LIMIT = 5000;
const RESULTS: IntakeResult[] = [
  'assessed', 'gated_out', 'skipped_replay', 'skipped_amended', 'skipped_old', 'skipped_seen', 'skipped_no_context', 'parse_error', 'error',
];

export class NewsIntake {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private capAlertDay: string | null = null;
  readonly counters = Object.fromEntries(RESULTS.map((r) => [r, 0])) as Record<IntakeResult, number>;

  constructor(private readonly d: IntakeDeps) {}

  private count(r: IntakeResult): IntakeResult {
    this.counters[r] += 1;
    return r;
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_LIMIT) this.seen.delete(this.seenOrder.shift() as string);
  }

  async handleEntry(entry: StreamEntry): Promise<IntakeResult> {
    const parsed = parseItemFields(entry.fields);
    if (!parsed.ok) {
      appendJournal(this.d.db, { tsMs: this.d.now(), kind: 'intake_parse_error', payload: { id: entry.id, error: parsed.error } });
      return this.count('parse_error');
    }
    return this.handleItem(parsed.item);
  }

  async handleItem(item: Item): Promise<IntakeResult> {
    const now = this.d.now();
    try {
      if (item.replay) return this.count('skipped_replay');
      if (item.event_type === 'item_amended') return this.count('skipped_amended');
      const published = Date.parse(item.source_publish_ts ?? item.first_seen_ts);
      if (Number.isFinite(published) && now - published > (this.d.maxAgeMs ?? 6 * 3_600_000)) return this.count('skipped_old');
      if (this.seen.has(item.item_id)) return this.count('skipped_seen');
      const context = this.d.engine.contextText();
      if (context === null) return this.count('skipped_no_context');
      this.markSeen(item.item_id);

      const gate = await this.d.gate(item);
      if (!gate.relevant) return this.count('gated_out');
      const assessment = await this.d.extract(item, context);
      await this.d.engine.onAssessment(assessment);
      return this.count('assessed');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof SpendCapError) {
        const day = new Date(now).toISOString().slice(0, 10);
        if (this.capAlertDay !== day) {
          this.capAlertDay = day;
          this.d.alert(
            `[PERP] model daily spend cap reached; news is ignored until the next UTC day. ` +
              `Any open position stays protected by its exchange-side stop. (${msg})`
          );
        }
      } else {
        appendJournal(this.d.db, { tsMs: now, kind: 'intake_error', payload: { itemId: item.item_id, error: msg } });
        console.error('[perp-intake] item failed:', msg);
      }
      return this.count('error');
    }
  }
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/intake.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): IIP news intake (filters, gate, extractor, spend-cap alert)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mode guards, broker factory, main, and the pinned units

**Files:**
- Create: `src/perp/startup.ts`, `src/perp/main.ts`, `deploy/mini-mac/perp-bot.service`, `deploy/mini-mac/perp-bot-demo.service`, `test/perp/startup.test.ts`, `test/perp/deploy.test.ts`
- Modify: `package.json` (scripts `perp-bot`, `perp-report`, `perp-clear-halt`; the last two files are created in Task 6)

**Interfaces:**
- Produces:
  - `type PerpMode = 'paper' | 'demo' | 'live'`; `interface ModeConfig { mode: PerpMode; subaccount: number | null; marketTicker: string }`
  - `resolveMode(env: NodeJS.ProcessEnv, ticker: string): ModeConfig` (throws on any violation of the guards in Global Constraints; demo `marketTicker` = `PERP_DEMO_TICKER` or `<ticker>1`)
  - `createBroker(mode: ModeConfig, d: { env: NodeJS.ProcessEnv; ticker: string; prodClient: MarginClientLike; demoClient: MarginClientLike | null; now: () => number }): { broker: Broker; paper: PaperBroker | null }` where `type MarginClientLike = Pick<KalshiMarginClient, 'get' | 'post' | 'put' | 'del'>`

- [ ] **Step 1: Write the failing tests**

`test/perp/startup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createBroker, resolveMode } from '../../src/perp/startup.js';
import { PaperBroker } from '../../src/perp/broker/paper.js';

const T = 'KXUS500PERP';
const demoEnv = { PERP_MODE: 'demo', PERP_SUBACCOUNT: '3', KALSHI_DEMO_API_KEY_ID: 'k', KALSHI_DEMO_PRIVATE_KEY_PATH: '/p' };

describe('resolveMode', () => {
  it('defaults to paper and ignores live/subaccount settings', () => {
    expect(resolveMode({}, T)).toEqual({ mode: 'paper', subaccount: null, marketTicker: T });
    expect(resolveMode({ PERP_LIVE: `${T}:3`, PERP_SUBACCOUNT: '3' }, T).mode).toBe('paper');
  });
  it('rejects an unknown mode', () => {
    expect(() => resolveMode({ PERP_MODE: 'real' }, T)).toThrow(/PERP_MODE/);
  });
  it('demo needs a subaccount 1-63 and demo credentials, and defaults the demo ticker to <ticker>1', () => {
    expect(resolveMode(demoEnv, T)).toEqual({ mode: 'demo', subaccount: 3, marketTicker: 'KXUS500PERP1' });
    expect(resolveMode({ ...demoEnv, PERP_DEMO_TICKER: 'OTHER' }, T).marketTicker).toBe('OTHER');
    for (const sub of [undefined, '0', '64', 'x', '1.5', '-1']) {
      expect(() => resolveMode({ ...demoEnv, PERP_SUBACCOUNT: sub }, T)).toThrow(/PERP_SUBACCOUNT/);
    }
    expect(() => resolveMode({ ...demoEnv, KALSHI_DEMO_API_KEY_ID: '' }, T)).toThrow(/KALSHI_DEMO_API_KEY_ID/);
  });
  it('live needs PERP_LIVE=<ticker>:<subaccount> exactly', () => {
    const live = { PERP_MODE: 'live', PERP_SUBACCOUNT: '3' };
    expect(() => resolveMode(live, T)).toThrow(/PERP_LIVE/);
    expect(() => resolveMode({ ...live, PERP_LIVE: 'KXUS500PERP:4' }, T)).toThrow(/PERP_LIVE/);
    expect(() => resolveMode({ ...live, PERP_LIVE: 'true' }, T)).toThrow(/PERP_LIVE/);
    expect(resolveMode({ ...live, PERP_LIVE: `${T}:3` }, T)).toEqual({ mode: 'live', subaccount: 3, marketTicker: T });
    expect(() => resolveMode({ ...live, PERP_SUBACCOUNT: '0', PERP_LIVE: `${T}:0` }, T)).toThrow(/PERP_SUBACCOUNT/);
  });
});

describe('createBroker', () => {
  const client = { get: async () => ({}), post: async () => ({}), put: async () => ({}), del: async () => ({}) } as never;
  it('paper: a PaperBroker with the configured starting equity', async () => {
    const quoteClient = { get: async () => ({ market: { bid: '13.75', ask: '13.76', price: '13.755' } }) } as never;
    const { broker, paper } = createBroker(resolveMode({}, T), { env: { PERP_PAPER_EQUITY_USD: '4.25' }, ticker: T, prodClient: quoteClient, demoClient: null, now: () => 1 });
    expect(broker.mode).toBe('paper');
    expect(paper).toBeInstanceOf(PaperBroker);
    expect((await broker.balance()).equityUsd).toBe(4.25);
  });
  it('paper: rejects a non-positive equity', () => {
    expect(() => createBroker(resolveMode({}, T), { env: { PERP_PAPER_EQUITY_USD: '0' }, ticker: T, prodClient: client, demoClient: null, now: () => 1 })).toThrow(/PERP_PAPER_EQUITY_USD/);
  });
  it('demo: a Kalshi broker on the demo client; refuses without one', () => {
    const { broker, paper } = createBroker(resolveMode(demoEnv, T), { env: demoEnv, ticker: T, prodClient: client, demoClient: client, now: () => 1 });
    expect(broker.mode).toBe('demo');
    expect(paper).toBeNull();
    expect(() => createBroker(resolveMode(demoEnv, T), { env: demoEnv, ticker: T, prodClient: client, demoClient: null, now: () => 1 })).toThrow(/demo client/);
  });
  it('live: a prod Kalshi broker', () => {
    const env = { PERP_MODE: 'live', PERP_SUBACCOUNT: '3', PERP_LIVE: `${T}:3` };
    expect(createBroker(resolveMode(env, T), { env, ticker: T, prodClient: client, demoClient: null, now: () => 1 }).broker.mode).toBe('prod');
  });
  it('rejects a bad trigger mode or slippage', () => {
    const env = { ...demoEnv, PERP_TRIGGER_MODE: 'weird' };
    expect(() => createBroker(resolveMode(env, T), { env, ticker: T, prodClient: client, demoClient: client, now: () => 1 })).toThrow(/PERP_TRIGGER_MODE/);
    const env2 = { ...demoEnv, PERP_SLIPPAGE_FRAC: '2' };
    expect(() => createBroker(resolveMode(env2, T), { env: env2, ticker: T, prodClient: client, demoClient: client, now: () => 1 })).toThrow(/PERP_SLIPPAGE_FRAC/);
  });
});
```

`test/perp/deploy.test.ts`:

```ts
// A hostile env file must not be able to turn a shipped unit into a demo/live one (review focus 4).
// The pins live on the ExecStart line (/usr/bin/env [-u VAR] K=V ... cmd), which nothing in an env file overrides.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMode } from '../../src/perp/startup.js';

const DEPLOY = path.resolve(__dirname, '../../deploy/mini-mac');
const read = (f: string) => fs.readFileSync(path.join(DEPLOY, f), 'utf-8');
const T = 'KXUS500PERP';

interface Unit { environment: Record<string, string>; execStart: string; text: string }
function parseUnit(text: string): Unit {
  const environment: Record<string, string> = {};
  let execStart = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const env = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (env) environment[env[1]] = env[2];
    if (line.startsWith('ExecStart=')) execStart = line.slice('ExecStart='.length);
  }
  return { environment, execStart, text };
}
function effectiveEnv(unit: Unit, envFiles: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = { ...unit.environment, ...envFiles };
  const argv = unit.execStart.split(/\s+/);
  if (argv[0] !== '/usr/bin/env') return env;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-u') { delete env[argv[++i]]; continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[i]);
    if (!kv) break;
    env[kv[1]] = kv[2];
  }
  return env;
}

const HOSTILE = {
  PERP_MODE: 'live', PERP_LIVE: `${T}:3`, PERP_SUBACCOUNT: '3',
  KALSHI_DEMO_API_KEY_ID: 'x', KALSHI_DEMO_PRIVATE_KEY_PATH: '/y',
};

describe('perp-bot.service (paper)', () => {
  const unit = parseUnit(read('perp-bot.service'));
  it('pins PERP_MODE=paper and strips PERP_LIVE on the ExecStart line, and runs src/perp/main.ts', () => {
    expect(unit.execStart).toMatch(/^\/usr\/bin\/env -u PERP_LIVE PERP_MODE=paper /);
    expect(unit.execStart).toContain('src/perp/main.ts');
  });
  it('a hostile env file still yields a paper start', () => {
    const env = effectiveEnv(unit, HOSTILE);
    expect(env.PERP_LIVE).toBeUndefined();
    expect(resolveMode(env, T).mode).toBe('paper');
  });
  it('reads the shared .env, then an optional (-) .env.perp', () => {
    expect(unit.text).toMatch(/^EnvironmentFile=%h\/executor_module\/\.env$/m);
    expect(unit.text).toMatch(/^EnvironmentFile=-%h\/executor_module\/\.env\.perp$/m);
  });
});

describe('perp-bot-demo.service', () => {
  const unit = parseUnit(read('perp-bot-demo.service'));
  it('pins PERP_MODE=demo and strips PERP_LIVE', () => {
    expect(unit.execStart).toMatch(/^\/usr\/bin\/env -u PERP_LIVE PERP_MODE=demo /);
  });
  it('a hostile env file can never make it live', () => {
    const env = effectiveEnv(unit, HOSTILE);
    expect(env.PERP_LIVE).toBeUndefined();
    expect(resolveMode(env, T).mode).toBe('demo');
  });
  it('requires its own .env.perp-demo (no "-": a missing file fails the start)', () => {
    expect(unit.text).toMatch(/^EnvironmentFile=%h\/executor_module\/\.env\.perp-demo$/m);
  });
});

describe('no shipped unit can trade real money', () => {
  it('none of the perp-*.service files pins live mode or sets PERP_LIVE', () => {
    for (const f of fs.readdirSync(DEPLOY).filter((x) => /^perp-.*\.service$/.test(x))) {
      const text = read(f);
      expect(text, f).not.toMatch(/PERP_MODE=live/);
      expect(text, f).not.toMatch(/^Environment=PERP_LIVE=/m);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/startup.test.ts test/perp/deploy.test.ts`
Expected: FAIL (modules and unit files not found).

- [ ] **Step 3: Write `src/perp/startup.ts`**

```ts
// src/perp/startup.ts
import { KalshiMarginBroker, fetchMarginQuote } from './broker/kalshiMarginBroker.js';
import type { KalshiMarginClient } from './broker/kalshiMarginClient.js';
import { DEFAULT_PAPER_CONFIG, PaperBroker } from './broker/paper.js';
import type { Broker } from './broker/types.js';

export type PerpMode = 'paper' | 'demo' | 'live';
export interface ModeConfig {
  mode: PerpMode;
  subaccount: number | null;
  /** The market ticker whose prices drive decisions: the demo exchange lists the perp with a "1" suffix. */
  marketTicker: string;
}
export type MarginClientLike = Pick<KalshiMarginClient, 'get' | 'post' | 'put' | 'del'>;

/** Start guards (spec section 8): paper by default; demo/live only with a dedicated subaccount; live only with an exact opt-in. */
export function resolveMode(env: NodeJS.ProcessEnv, ticker: string): ModeConfig {
  const mode = env.PERP_MODE ?? 'paper';
  if (mode !== 'paper' && mode !== 'demo' && mode !== 'live') {
    throw new Error(`PERP_MODE must be paper, demo or live, got ${JSON.stringify(mode)}`);
  }
  if (mode === 'paper') return { mode, subaccount: null, marketTicker: ticker };

  const raw = env.PERP_SUBACCOUNT;
  const sub = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(sub) || sub < 1 || sub > 63) {
    throw new Error('PERP_SUBACCOUNT must be an integer 1-63 for demo/live (the primary account 0 is never used)');
  }
  if (mode === 'demo') {
    for (const k of ['KALSHI_DEMO_API_KEY_ID', 'KALSHI_DEMO_PRIVATE_KEY_PATH']) {
      if (!env[k]) throw new Error(`${k} is required for demo mode`);
    }
    return { mode, subaccount: sub, marketTicker: env.PERP_DEMO_TICKER || `${ticker}1` };
  }
  if (env.PERP_LIVE !== `${ticker}:${sub}`) {
    throw new Error(`live mode requires PERP_LIVE=${ticker}:${sub} exactly`);
  }
  return { mode, subaccount: sub, marketTicker: ticker };
}

export function createBroker(
  mode: ModeConfig,
  d: { env: NodeJS.ProcessEnv; ticker: string; prodClient: MarginClientLike; demoClient: MarginClientLike | null; now: () => number }
): { broker: Broker; paper: PaperBroker | null } {
  if (mode.mode === 'paper') {
    const equity = Number(d.env.PERP_PAPER_EQUITY_USD ?? DEFAULT_PAPER_CONFIG.startEquityUsd);
    if (!Number.isFinite(equity) || equity <= 0) throw new Error('PERP_PAPER_EQUITY_USD must be a positive number of dollars');
    const paper = new PaperBroker(
      () => fetchMarginQuote(d.prodClient, d.ticker, d.now()),
      { ...DEFAULT_PAPER_CONFIG, startEquityUsd: equity },
      d.now
    );
    return { broker: paper, paper };
  }

  const triggerMode = d.env.PERP_TRIGGER_MODE ?? 'isolated';
  if (triggerMode !== 'isolated' && triggerMode !== 'cross') throw new Error('PERP_TRIGGER_MODE must be isolated or cross');
  const slippage = Number(d.env.PERP_SLIPPAGE_FRAC ?? 0.002);
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 0.02) throw new Error('PERP_SLIPPAGE_FRAC must be between 0 and 0.02');
  const client = mode.mode === 'demo' ? d.demoClient : d.prodClient;
  if (client === null) throw new Error('demo mode needs a demo client');
  const broker = new KalshiMarginBroker(
    client,
    { env: mode.mode === 'demo' ? 'demo' : 'prod', ticker: mode.marketTicker, subaccount: mode.subaccount, triggerMode, slippageFrac: slippage },
    { now: d.now }
  );
  return { broker, paper: null };
}
```

- [ ] **Step 4: Write the unit files**

`deploy/mini-mac/perp-bot.service`:

```ini
[Unit]
# PAPER-TRADING instance of the US500 perp bot. It places no orders on Kalshi: it reads prices (GET only) and simulates fills.
# Install: cp this file to ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now perp-bot
# Secrets come from the shared %h/executor_module/.env (ANTHROPIC_API_KEY, REDIS_URL, KALSHI_API_KEY_ID/KALSHI_PRIVATE_KEY_PATH,
# SLACK_WEBHOOK_URL); tunables (PERP_*) may go in the optional %h/executor_module/.env.perp.
#
# The safety pins are on the ExecStart line, NOT in Environment=: systemd lets EnvironmentFile= override Environment=, so a pin
# there could be undone by an env file. `/usr/bin/env -u PERP_LIVE PERP_MODE=paper` is applied after every env file and nothing
# can override it. No unit for real money ships: it must be created deliberately after the Phase 1 gates (docs/runbook-perp.md).
Description=US500 perp bot (paper)
After=network-online.target redis-server.service iip.service
Wants=network-online.target

StartLimitIntervalSec=3600
StartLimitBurst=30

[Service]
Type=simple
WorkingDirectory=%h/executor_module-perp
EnvironmentFile=%h/executor_module/.env
EnvironmentFile=-%h/executor_module/.env.perp
ExecStart=/usr/bin/env -u PERP_LIVE PERP_MODE=paper %h/executor_module-perp/node_modules/.bin/tsx %h/executor_module-perp/src/perp/main.ts

Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=perp-bot

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/executor_module-perp/data
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=default.target
```

`deploy/mini-mac/perp-bot-demo.service`:

```ini
[Unit]
# DEMO-EXCHANGE rehearsal of the US500 perp bot: real order/stop/liquidation mechanics against Kalshi's DEMO exchange (play money).
# Needs a demo account + API key and a demo subaccount. It REQUIRES %h/executor_module/.env.perp-demo with:
#   KALSHI_DEMO_API_KEY_ID, KALSHI_DEMO_PRIVATE_KEY_PATH, PERP_SUBACCOUNT (1-63)
# Never trades real money: PERP_MODE=demo is pinned on the ExecStart line and PERP_LIVE is stripped.
Description=US500 perp bot (demo exchange)
After=network-online.target redis-server.service iip.service
Wants=network-online.target

StartLimitIntervalSec=3600
StartLimitBurst=30

[Service]
Type=simple
WorkingDirectory=%h/executor_module-perp
EnvironmentFile=%h/executor_module/.env
EnvironmentFile=%h/executor_module/.env.perp-demo
ExecStart=/usr/bin/env -u PERP_LIVE PERP_MODE=demo %h/executor_module-perp/node_modules/.bin/tsx %h/executor_module-perp/src/perp/main.ts

Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=perp-bot-demo

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/executor_module-perp/data
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=default.target
```

- [ ] **Step 5: Write `src/perp/main.ts`**

```ts
// src/perp/main.ts
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendAlert, setAlertTrade } from '../alert.js';
import { acquireLedgerLock } from '../decide/ledgerLock.js';
import { createRedisClient } from '../redis/client.js';
import { StreamConsumer } from '../redis/consumer.js';
import { KalshiMarginClient } from './broker/kalshiMarginClient.js';
import type { PaperState } from './broker/paper.js';
import { calendarCoverageDays, loadCalendar } from './collectors/calendar.js';
import { collectMacro } from './collectors/fred.js';
import { collectKalshiEvents } from './collectors/kalshiEvents.js';
import { collectPerp } from './collectors/perpMarket.js';
import { loadPerpConfig } from './config.js';
import { PerpEngine, type Collected } from './engine/engine.js';
import { NewsIntake } from './intake/newsIntake.js';
import { ensureModelCallsTable } from './model/callJson.js';
import { runPerpGate, type ModelDeps } from './model/gate.js';
import { extractImpact } from './model/impact.js';
import { createBroker, resolveMode } from './startup.js';
import { appendJournal, getState, openPerpDb, setState } from './store/db.js';
import type { MacroPoint } from './types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Same stream the executor reads; the bot uses its own consumer group so it never competes with the executor. */
const IIP_STREAM_KEY = 'iip:items';
const MACRO_REFRESH_MS = 15 * 60_000;
const KALSHI_EVENTS_REFRESH_MS = 5 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;
const CALENDAR_MIN_COVERAGE_DAYS = 7;

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function main(): Promise<void> {
  const env = process.env;
  const cfg = loadPerpConfig(env);
  const mode = resolveMode(env, cfg.ticker);
  const tickMs = Number(env.PERP_TICK_MS ?? 60_000);
  if (!Number.isFinite(tickMs) || tickMs < 5_000) throw new Error('PERP_TICK_MS must be at least 5000');
  const dailyCap = Number(env.PERP_DAILY_USD_CAP ?? 5);
  if (!Number.isFinite(dailyCap) || dailyCap <= 0) throw new Error('PERP_DAILY_USD_CAP must be a positive number of dollars');

  const dataDir = env.PERP_DATA_DIR ?? path.join(REPO_ROOT, 'data', 'perp');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, `perp-${mode.mode}.db`);
  const lock = acquireLedgerLock(dbPath);
  process.once('exit', () => lock.release());
  const db = openPerpDb(dbPath);
  ensureModelCallsTable(db);
  setAlertTrade(`perp-${mode.mode}`);
  const alert = (m: string): void => void sendAlert(m);

  const prodClient = new KalshiMarginClient({ env: 'prod', apiKeyId: must('KALSHI_API_KEY_ID'), privateKeyPath: must('KALSHI_PRIVATE_KEY_PATH') });
  const demoClient =
    mode.mode === 'demo'
      ? new KalshiMarginClient({ env: 'demo', apiKeyId: must('KALSHI_DEMO_API_KEY_ID'), privateKeyPath: must('KALSHI_DEMO_PRIVATE_KEY_PATH') })
      : null;
  const marketClient = demoClient ?? prodClient;
  const { broker, paper } = createBroker(mode, { env, ticker: cfg.ticker, prodClient, demoClient, now: () => Date.now() });
  if (paper !== null) {
    const saved = getState<PaperState>(db, 'paper');
    if (saved !== null) paper.importState(saved);
  }

  const calendarFile = env.PERP_CALENDAR_FILE ?? path.join(REPO_ROOT, 'config', 'perp-calendar.json');
  loadCalendar(calendarFile, Date.now()); // fail at startup, loudly, if the calendar file is missing or invalid
  const kalshiTickers = (env.PERP_KALSHI_EVENT_TICKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  let macroCache: { at: number; macro: Record<string, MacroPoint> } | null = null;
  let kalshiCache: { at: number; events: Collected['kalshiEvents'] } | null = null;
  const collect = async (): Promise<Collected> => {
    const now = Date.now();
    const perp = await collectPerp(marketClient, mode.marketTicker, now);
    if (macroCache === null || now - macroCache.at > MACRO_REFRESH_MS) {
      const macro = await collectMacro();
      if (Object.keys(macro).length > 0) macroCache = { at: now, macro };
    }
    if (kalshiTickers.length > 0 && (kalshiCache === null || now - kalshiCache.at > KALSHI_EVENTS_REFRESH_MS)) {
      kalshiCache = { at: now, events: await collectKalshiEvents(kalshiTickers) };
    }
    return {
      perp,
      perpFetchedAtMs: now,
      macro: macroCache?.macro ?? {},
      macroFetchedAtMs: macroCache?.at ?? null,
      events: loadCalendar(calendarFile, now),
      kalshiEvents: kalshiCache?.events ?? [],
    };
  };

  const engine = new PerpEngine({
    cfg, db, broker, now: () => Date.now(), collect, alert,
    persistBroker: paper === null ? undefined : () => setState(db, 'paper', paper.exportState()),
    applyFunding: paper === null ? undefined : (rate, mark) => paper.applyFunding(rate, mark),
  });

  const anthropic = new Anthropic();
  const modelDeps: ModelDeps = { client: anthropic as unknown as ModelDeps['client'], db, dailyUsdCap: dailyCap };
  const intake = new NewsIntake({
    db, now: () => Date.now(), alert, engine,
    gate: (item) => runPerpGate(modelDeps, item),
    extract: (item, ctx) => extractImpact(modelDeps, item, ctx, Date.now()),
  });

  console.log(`[perp] starting mode=${mode.mode} ticker=${mode.marketTicker} subaccount=${mode.subaccount ?? '-'} tickMs=${tickMs} db=${dbPath}`);
  await engine.start();
  await engine.tick(); // first snapshot, so news arriving next has context

  const redis = createRedisClient();
  await redis.connect();
  const consumer = new StreamConsumer(redis, { streamKey: IIP_STREAM_KEY, groupName: 'perpbot', consumerName: 'perpbot-primary', startId: '$' });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  let ticking = false;
  const tickTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    engine.tick().finally(() => { ticking = false; });
  }, tickMs);

  let lastCoverageAlertDay: string | null = null;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    appendJournal(db, { tsMs: now, kind: 'heartbeat', payload: { status: engine.status(), intake: intake.counters } });
    const day = new Date(now).toISOString().slice(0, 10);
    if (lastCoverageAlertDay !== day) {
      lastCoverageAlertDay = day;
      try {
        const days = calendarCoverageDays(calendarFile, now);
        if (days < CALENDAR_MIN_COVERAGE_DAYS) alert(`[PERP] the economic calendar file only covers the next ${days.toFixed(1)} days; add upcoming FOMC/CPI/jobs dates to ${calendarFile}.`);
      } catch (err) {
        alert(`[PERP] the economic calendar file is unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, HEARTBEAT_MS);

  try {
    await consumer.run(async (entry) => {
      await intake.handleEntry(entry); // never rejects
    }, controller.signal);
  } finally {
    clearInterval(tickTimer);
    clearInterval(heartbeat);
    await redis.quit().catch(() => undefined);
    db.close();
  }
}

main().catch((err) => {
  console.error('[perp] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 6: Add the npm scripts**

In `package.json` `"scripts"` add (the report and clear-halt scripts are written in Task 6):

```json
    "perp-bot": "tsx src/perp/main.ts",
    "perp-report": "tsx scripts/perp-report.ts",
    "perp-clear-halt": "tsx scripts/perp-clear-halt.ts",
```

- [ ] **Step 7: Run the tests, the typecheck, and a 90-second paper smoke run**

Run: `cd ~/executor_module-perp && npx vitest run test/perp && npx tsc --noEmit`
Expected: all pass.

Smoke run (uses the executor's existing production key for read-only GETs, FRED, and a small amount of Anthropic budget; ask the user before this step if there is any doubt):

```bash
cd ~/executor_module-perp && set -a && . ~/executor_module/.env && set +a \
 && PERP_DATA_DIR=/tmp/perp-smoke timeout 90 npx tsx src/perp/main.ts; echo "exit=$?"
```
Expected: a `[perp] starting mode=paper ticker=KXUS500PERP ...` line, no stack trace, and `exit=124` (killed by `timeout`). Then confirm rows were written (`ls /tmp/perp-smoke` shows `perp-paper.db`). If it exits early with `fatal:`, read the message: a missing `config/perp-calendar.json` or env var is the usual cause.

- [ ] **Step 8: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp deploy package.json && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): mode guards, broker factory, main, pinned paper and demo units

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Evaluation report, operator scripts, runbook and rollout

**Files:**
- Create: `src/perp/eval/calibration.ts`, `scripts/perp-report.ts`, `scripts/perp-clear-halt.ts`, `docs/runbook-perp.md`, `test/perp/calibration.test.ts`

**Interfaces:**
- Produces: `interface Outcome { itemId: string; bucket: Bucket; direction: 'up' | 'down'; confidence: number; realized1d: number | null; realized5d: number | null }` (realized = perp move after the item, signed in the item's direction); `outcomesFor(assessments: ImpactAssessment[], marks: Array<{ tsMs: number; mark: number }>): Outcome[]` (neutral items and items with no baseline mark within 10 minutes are skipped; a horizon mark must be within 3 hours of the target time, else null); `brierScore(outcomes: Outcome[], horizon: '1d' | '5d'): { n: number; brier: number | null }` (prediction = `confidence`, outcome = realized > 0); `bucketTable(outcomes: Outcome[]): Array<{ bucket: Bucket; n: number; meanRealized1d: number | null; hitRate1d: number | null; meanRealized5d: number | null }>` (fixed bucket order minor, moderate, major, shock; only buckets present).

- [ ] **Step 1: Write the failing test `test/perp/calibration.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { brierScore, bucketTable, outcomesFor } from '../../src/perp/eval/calibration.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const T = Date.UTC(2026, 9, 14, 15, 0, 0);
const DAY = 86_400_000;
const a = (over: Partial<ImpactAssessment>): ImpactAssessment => ({
  itemId: 'i', receivedAtMs: T, publishedAtMs: T, direction: 'up', bucket: 'major', horizon: 'days', credibility: 0.8,
  novelty: 'new', alreadyPriced: 'no', confidence: 0.8, rationale: 'r', ...over,
});
const marks = [{ tsMs: T, mark: 100 }, { tsMs: T + DAY, mark: 101 }, { tsMs: T + 5 * DAY, mark: 99 }];

describe('outcomesFor', () => {
  it('signs realized moves by item direction and leaves horizons without data null', () => {
    const out = outcomesFor([a({ itemId: 'up' }), a({ itemId: 'down', direction: 'down', confidence: 0.6, bucket: 'minor' })], marks);
    expect(out[0].itemId).toBe('up');
    expect(out[0].realized1d).toBeCloseTo(0.01, 8);
    expect(out[0].realized5d).toBeCloseTo(-0.01, 8);
    expect(out[1].itemId).toBe('down');
    expect(out[1].realized1d).toBeCloseTo(-0.01, 8);
    expect(out[1].realized5d).toBeCloseTo(0.01, 8);
    const noFuture = outcomesFor([a({ itemId: 'late', receivedAtMs: T + 5 * DAY, publishedAtMs: T + 5 * DAY })], marks);
    expect(noFuture[0].realized1d).toBeNull();
    expect(noFuture[0].realized5d).toBeNull();
  });
  it('skips neutral items and items with no baseline mark', () => {
    expect(outcomesFor([a({ direction: 'neutral' })], marks)).toEqual([]);
    expect(outcomesFor([a({ receivedAtMs: T - 3 * DAY })], marks)).toEqual([]);
  });
});

describe('brierScore', () => {
  it('averages (confidence - outcome)^2 over outcomes with data', () => {
    const out = outcomesFor([a({ itemId: 'up', confidence: 0.8 }), a({ itemId: 'down', direction: 'down', confidence: 0.6 })], marks);
    // up: realized1d +1% -> y=1, (0.8-1)^2 = 0.04 ; down: realized1d -1% -> y=0, (0.6-0)^2 = 0.36
    const r = brierScore(out, '1d');
    expect(r.n).toBe(2);
    expect(r.brier).toBeCloseTo(0.2, 8);
  });
  it('reports null, not NaN, with no data', () => {
    expect(brierScore([], '1d')).toEqual({ n: 0, brier: null });
  });
});

describe('bucketTable', () => {
  it('summarizes realized moves and hit rate per bucket in a fixed order', () => {
    const out = outcomesFor([a({ itemId: '1', bucket: 'major' }), a({ itemId: '2', bucket: 'minor', direction: 'down' }), a({ itemId: '3', bucket: 'major' })], marks);
    const t = bucketTable(out);
    expect(t.map((r) => r.bucket)).toEqual(['minor', 'major']);
    const major = t.find((r) => r.bucket === 'major')!;
    expect(major.n).toBe(2);
    expect(major.meanRealized1d).toBeCloseTo(0.01, 8);
    expect(major.hitRate1d).toBe(1);
    expect(t.find((r) => r.bucket === 'minor')!.hitRate1d).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/calibration.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/eval/calibration.ts`**

```ts
// src/perp/eval/calibration.ts
import type { Bucket, ImpactAssessment } from '../types.js';

export interface Outcome {
  itemId: string;
  bucket: Bucket;
  direction: 'up' | 'down';
  confidence: number;
  realized1d: number | null;
  realized5d: number | null;
}

type Marks = Array<{ tsMs: number; mark: number }>;
const DAY = 86_400_000;
const BASELINE_MAX_GAP_MS = 10 * 60_000;
const HORIZON_MAX_GAP_MS = 3 * 3_600_000;
const BUCKET_ORDER: Bucket[] = ['minor', 'moderate', 'major', 'shock'];

function markAt(marks: Marks, tMs: number, maxGapMs: number): number | null {
  let best: { gap: number; mark: number } | null = null;
  for (const m of marks) {
    const gap = Math.abs(m.tsMs - tMs);
    if (gap <= maxGapMs && (best === null || gap < best.gap)) best = { gap, mark: m.mark };
  }
  return best === null ? null : best.mark;
}

/** What the perp did after each directional item, signed so that positive = the item's direction was right. */
export function outcomesFor(assessments: ImpactAssessment[], marks: Marks): Outcome[] {
  const out: Outcome[] = [];
  for (const a of assessments) {
    if (a.direction === 'neutral') continue;
    const base = markAt(marks, a.receivedAtMs, BASELINE_MAX_GAP_MS);
    if (base === null || base <= 0) continue;
    const sign = a.direction === 'up' ? 1 : -1;
    const realized = (days: number): number | null => {
      const m = markAt(marks, a.receivedAtMs + days * DAY, HORIZON_MAX_GAP_MS);
      return m === null ? null : sign * (m / base - 1);
    };
    out.push({
      itemId: a.itemId, bucket: a.bucket, direction: a.direction, confidence: a.confidence,
      realized1d: realized(1), realized5d: realized(5),
    });
  }
  return out;
}

export function brierScore(outcomes: Outcome[], horizon: '1d' | '5d'): { n: number; brier: number | null } {
  const rows = outcomes
    .map((o) => ({ p: o.confidence, r: horizon === '1d' ? o.realized1d : o.realized5d }))
    .filter((x): x is { p: number; r: number } => x.r !== null);
  if (rows.length === 0) return { n: 0, brier: null };
  const sum = rows.reduce((s, x) => s + (x.p - (x.r > 0 ? 1 : 0)) ** 2, 0);
  return { n: rows.length, brier: sum / rows.length };
}

export function bucketTable(
  outcomes: Outcome[]
): Array<{ bucket: Bucket; n: number; meanRealized1d: number | null; hitRate1d: number | null; meanRealized5d: number | null }> {
  const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
  return BUCKET_ORDER.filter((b) => outcomes.some((o) => o.bucket === b)).map((bucket) => {
    const rows = outcomes.filter((o) => o.bucket === bucket);
    const r1 = rows.map((o) => o.realized1d).filter((x): x is number => x !== null);
    const r5 = rows.map((o) => o.realized5d).filter((x): x is number => x !== null);
    return {
      bucket,
      n: rows.length,
      meanRealized1d: mean(r1),
      hitRate1d: r1.length === 0 ? null : r1.filter((x) => x > 0).length / r1.length,
      meanRealized5d: mean(r5),
    };
  });
}
```

- [ ] **Step 4: Run the test and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/calibration.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Write `scripts/perp-report.ts` (read-only)**

```ts
// scripts/perp-report.ts
// Read-only evaluation of a bot database. Usage: npm run perp-report -- --db data/perp/perp-paper.db [--days 30]
import Database from 'better-sqlite3';
import { brierScore, bucketTable, outcomesFor } from '../src/perp/eval/calibration.js';
import type { ImpactAssessment } from '../src/perp/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg('db');
if (!file) {
  console.error('usage: perp-report --db <path to perp-<mode>.db> [--days N]');
  process.exit(2);
}
const days = Number(arg('days') ?? 30);
const since = Date.now() - days * 86_400_000;
const db = new Database(file, { readonly: true, fileMustExist: true });
const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`);

console.log(`== ${file} (last ${days} days) ==`);

const eq = db.prepare('SELECT MIN(equity) AS lo, MAX(equity) AS hi, COUNT(*) AS n FROM equity WHERE ts_ms >= ?').get(since) as { lo: number | null; hi: number | null; n: number };
const first = db.prepare('SELECT equity FROM equity WHERE ts_ms >= ? ORDER BY ts_ms ASC LIMIT 1').get(since) as { equity: number } | undefined;
const last = db.prepare('SELECT equity FROM equity ORDER BY ts_ms DESC LIMIT 1').get() as { equity: number } | undefined;
console.log(`equity: start ${first?.equity.toFixed(3) ?? 'n/a'} -> now ${last?.equity.toFixed(3) ?? 'n/a'}  (low ${eq.lo?.toFixed(3) ?? 'n/a'}, high ${eq.hi?.toFixed(3) ?? 'n/a'}, ${eq.n} samples)`);

const exits = db.prepare('SELECT at_ms, rule, side, pnl_usd FROM exits WHERE at_ms >= ? ORDER BY at_ms').all(since) as Array<{ at_ms: number; rule: string; side: string; pnl_usd: number }>;
console.log(`\nexits: ${exits.length}, total P&L ${exits.reduce((s, e) => s + e.pnl_usd, 0).toFixed(3)} USD`);
const byRule = new Map<string, { n: number; pnl: number }>();
for (const e of exits) {
  const r = byRule.get(`${e.rule}/${e.side}`) ?? { n: 0, pnl: 0 };
  r.n += 1;
  r.pnl += e.pnl_usd;
  byRule.set(`${e.rule}/${e.side}`, r);
}
for (const [k, v] of byRule) console.log(`  ${k.padEnd(24)} n=${v.n}  pnl=${v.pnl.toFixed(3)}`);

const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM journal WHERE ts_ms >= ? GROUP BY kind ORDER BY n DESC').all(since) as Array<{ kind: string; n: number }>;
console.log('\njournal rows by kind:', kinds.map((k) => `${k.kind}=${k.n}`).join(', ') || 'none');

const spend = db.prepare('SELECT stage, COUNT(*) AS n, SUM(ok) AS ok, ROUND(SUM(cost_usd), 4) AS usd FROM model_calls WHERE called_at_ms >= ? GROUP BY stage').all(since) as Array<{ stage: string; n: number; ok: number; usd: number }>;
console.log('model calls:', spend.map((s) => `${s.stage}: ${s.n} calls (${s.ok} ok) $${s.usd}`).join('; ') || 'none');

const assessments = (db.prepare('SELECT json FROM assessments WHERE received_ms >= ? ORDER BY received_ms').all(since) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as ImpactAssessment);
const marks = (db.prepare('SELECT ts_ms, mark FROM snapshots WHERE ts_ms >= ? ORDER BY ts_ms').all(since - 86_400_000) as Array<{ ts_ms: number; mark: number }>).map((r) => ({ tsMs: r.ts_ms, mark: r.mark }));
const outcomes = outcomesFor(assessments, marks);
console.log(`\nassessments: ${assessments.length} (${outcomes.length} directional with a baseline price)`);
for (const h of ['1d', '5d'] as const) {
  const b = brierScore(outcomes, h);
  console.log(`  Brier ${h}: ${b.brier === null ? 'n/a' : b.brier.toFixed(3)} over ${b.n} items (0.25 = coin-flip calibration; lower is better)`);
}
console.log('  per magnitude bucket (move realized in the item\'s direction):');
for (const r of bucketTable(outcomes)) {
  console.log(`    ${r.bucket.padEnd(9)} n=${String(r.n).padEnd(4)} 1d mean ${pct(r.meanRealized1d).padStart(8)}  hit ${r.hitRate1d === null ? 'n/a' : (r.hitRate1d * 100).toFixed(0) + '%'}  5d mean ${pct(r.meanRealized5d)}`);
}
db.close();
```

- [ ] **Step 6: Write `scripts/perp-clear-halt.ts`**

```ts
// scripts/perp-clear-halt.ts
// Operator: lift a kill-switch halt. Usage: npm run perp-clear-halt -- --db data/perp/perp-paper.db
// Works while the bot is running (it re-reads the risk state every tick). Exits and equity peaks from before now stop counting.
import { clearHaltInDb } from '../src/perp/ops/clearHalt.js';
import { openPerpDb } from '../src/perp/store/db.js';

const i = process.argv.indexOf('--db');
const file = i >= 0 ? process.argv[i + 1] : undefined;
if (!file) {
  console.error('usage: perp-clear-halt --db <path to perp-<mode>.db>');
  process.exit(2);
}
const db = openPerpDb(file);
const out = clearHaltInDb(db, Date.now());
console.log(out.wasHalted ? `cleared halt (was: ${out.reason})` : 'the bot was not halted; recorded a fresh kill-switch epoch anyway');
db.close();
```

- [ ] **Step 7: Write `docs/runbook-perp.md`**

```markdown
# US500 perp bot — runbook

Spec: `docs/superpowers/specs/2026-10-14-us500-perp-bot-design.md`. Code: `src/perp/`. Host: mini-mac, user systemd.

## What runs
- `perp-bot.service`: PAPER mode (pinned). Reads Kalshi prices (GET only), simulates fills, applies the real decision logic. Spends Anthropic budget (cap `PERP_DAILY_USD_CAP`, default $5/UTC day).
- `perp-bot-demo.service`: DEMO-exchange rehearsal (pinned). Real order/stop/liquidation mechanics with play money. Needs `~/executor_module/.env.perp-demo` with `KALSHI_DEMO_API_KEY_ID`, `KALSHI_DEMO_PRIVATE_KEY_PATH`, `PERP_SUBACCOUNT`.
- No live unit ships. See "Going live".

## Install / start (paper)
    mkdir -p ~/.config/systemd/user
    cp ~/executor_module-perp/deploy/mini-mac/perp-bot.service ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now perp-bot
    journalctl --user -u perp-bot -f

Needs `config/perp-calendar.json` filled (below), `~/executor_module/.env` with `ANTHROPIC_API_KEY`, `REDIS_URL`, `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, optional `SLACK_WEBHOOK_URL`.

## Daily operation
- Report: `cd ~/executor_module-perp && npm run perp-report -- --db data/perp/perp-paper.db --days 7`
- Slack alerts are tagged `[trade=perp-paper]`. Alerts to act on: HALTED, LIQUIDATED, "closed outside the bot", "orphan position", "tick failures", "spend cap", "calendar".
- Clear a halt after reviewing why it halted: `npm run perp-clear-halt -- --db data/perp/perp-paper.db`.
- Stop: `systemctl --user stop perp-bot`. A stopped bot with an open real position is protected only by its exchange-side trailing stop.

## Economic calendar (operator-maintained)
`config/perp-calendar.json` is a JSON array of `{"at": "2026-11-05T19:00:00Z", "name": "FOMC rate decision", "impact": "high"}`. Fill it from federalreserve.gov (FOMC) and bls.gov (CPI, jobs report). A missing/invalid file stops the bot from starting and makes every tick fail; a file covering fewer than 7 days raises a daily alert. Re-check monthly.

## Phase 0 (before any order): run `npm run perp-verify` and record the answers here
- [ ] Trading hours and any daily break confirmed (next close seen: Fri 5 pm ET).
- [ ] Perp price tracks the S&P 500 (ratio to FRED SP500 is ~constant); contract price mapping understood.
- [ ] Funding payer confirmed on the demo exchange (set `fundingLongPays` accordingly in `src/perp/broker/paper.ts` if it is the opposite).
- [ ] Liquidation margin ratio definition confirmed with `/margin/risk` on a demo position.
- [ ] Isolated vs cross exit-trigger path confirmed (`PERP_TRIGGER_MODE`).
- [ ] Subaccount isolation confirmed (two subaccounts do not net).
- [ ] Demo account + API key created; `perp-bot-demo.service` rehearsal run: open, trailing stop fires, forced margin-guard exit, restart with an open position.
- [ ] Price-rule backtest recorded (`docs/perp-backtest-2026-10-14.txt`).

## Phase 1 gates (paper, at least 4 weeks) — correctness, not profit
- [ ] Zero accounting or state bugs (equity in `perp-report` reconciles with the exit rows).
- [ ] Every exit traceable to a rule in the journal (`close`/`broker_event` rows with reasons).
- [ ] Restart with an open paper position tested at least once; stale-data and Redis-outage behavior observed.
- [ ] Calibration table reviewed; `bucketMove` and thresholds in `PERP_CONFIG_JSON` updated from measured values if the data supports it.
- [ ] The first spend-cap and calendar alerts were seen to work.
The 41-day IIP archive and the perp's short history cannot prove an edge; the paper run is the evaluation.

## Going live (needs the user's explicit approval each time)
1. Fund a dedicated subaccount with about $3.50 for one contract at ~4x (the bot never moves money; $5 realizes ~2.75x).
2. Create `~/.config/systemd/user/perp-bot-live.service` by copying `perp-bot.service` and changing: the ExecStart pin to `/usr/bin/env PERP_MODE=live`, `EnvironmentFile=%h/executor_module/.env.perp-live` (required, no `-`), `SyslogIdentifier=perp-bot-live`. In `.env.perp-live` set `PERP_SUBACCOUNT=<n>` and `PERP_LIVE=KXUS500PERP:<n>`. The first live order requires the user's approval at that moment.
3. Watch the first trade by hand; confirm the trailing stop exists on Kalshi right after the fill.

## Off switch
`systemctl --user disable --now perp-bot` (and the demo/live units). For a real position, close it in the Kalshi UI first, or leave the exchange-side trailing stop in place.

## Known limits
- Paper liquidation fills at the mark with no penalty (optimistic). Paper funding sign is assumed (longs pay) until verified.
- FRED macro series (VIX, yields, spreads) lag by about a day; the bot uses VIX only to size volatility. Fresher VIX/S&P data is a possible later addition.
- Free-text news is a noisy edge: shocks are rare, model confidence is uncalibrated until measured.
- Short parameters (higher bar, weekend rule) are reasoned defaults, not measured.
```

- [ ] **Step 8: Typecheck, run the whole perp suite, and run the report against the smoke database**

Run: `cd ~/executor_module-perp && npx vitest run test/perp && npx tsc --noEmit && npm run perp-report -- --db /tmp/perp-smoke/perp-paper.db --days 1`
Expected: the suite passes, `tsc` is silent, and the report prints equity, exits (0), journal kinds (`reconcile`/`decision`/`heartbeat` as applicable), model calls, and an assessments line. If `/tmp/perp-smoke` does not exist (Task 5's smoke run was skipped), run `npm run perp-clear-halt -- --db /tmp/x.db` first to create an empty database and point the report at it.

- [ ] **Step 9: Commit**

```bash
cd ~/executor_module-perp && git add src/perp scripts docs test package.json && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): calibration report, operator scripts, runbook

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Rollout (ask the user first)**

Ask: "OK to install and start `perp-bot.service` (paper; read-only against Kalshi; Anthropic spend capped at $5/day) on mini-mac?" On a yes, run the install commands from `docs/runbook-perp.md`, then:

```bash
sleep 120 && journalctl --user -u perp-bot -n 40 --no-pager && cd ~/executor_module-perp && npm run perp-report -- --db data/perp/perp-paper.db --days 1
```
Expected: `[perp] starting mode=paper ...`, no repeating `tick failed`, a `heartbeat` or `decision` row, and the report printing. Report back what was observed. Do not merge the branch into `main` or push; that needs a separate explicit approval.

---

## Self-review (against the spec)

- **Coverage:** spec 3 units (collectors, intake, extractor, quant, policy, risk governor, broker, journal/eval) are all wired: engine (Task 3), intake (Task 4), modes and units (Task 5), eval (Task 6). Section 4 state machine and flip ordering: close, confirm, then re-evaluate (Task 3). 5.1 rule 1 and the weekend rule are enforced by the broker and policy from plans 1-2 and observed through `poll()`/events here. 5.5-5.7: cooldowns, kill switch, stale-data fail-safe, restart reconciliation (Task 3), calendar fail-closed and coverage alert (plan 2 Task 6, Task 5 `main`). Section 8 phases: Phase 0 checklist and Phase 1 gates in the runbook, the demo unit, and the paper unit; Phase 2 is documented but deliberately not shipped as a unit. The Grafana wall tile is out of scope (noted in the spec).
- **Placeholders:** none. Operator-supplied data is limited to the calendar file and credentials, both described.
- **Type consistency:** `Collected`, `EngineDeps`, `PerpEngine` methods, `IntakeDeps`/`IntakeResult`, `ModeConfig`, `PaperState`, `fetchMarginQuote`, `equityPeak(db, sinceMs)`, `clearHaltInDb` are each defined once and used with identical names in later tasks; all names from plans 1-2 (`decide`, `NewItem`, `computeGovernors`, `PressureBook`, `Broker`, `BrokerEvent`, `ModelDeps`, `runPerpGate`, `extractImpact`, `collectPerp`, `collectMacro`, `loadCalendar`) are used as defined there.
