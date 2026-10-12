# Exit Review — Plan C: Lateness, Backtest and Rollout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure and log how late each simulated exit was (without ever touching the sell path), let us replay the logged news against past positions to see what the exit review would have done before turning it on anywhere, and give a safe, reversible rollout.

**Architecture:** Lateness is a **sweep**, not an in-line step: a job riding the existing 20 s exit timer finds fills that have no `late_json` yet, waits until the candle covering the fill exists, fetches Kalshi candlesticks and writes the result. The backtest is two pure modules (item-text extraction and a candle-driven replay) plus a CLI that defaults to a dry run, reads the real ledger read-only and logs model calls to an in-memory scratch ledger.

**Tech Stack:** TypeScript (ESM, Node 22), better-sqlite3, @anthropic-ai/sdk, vitest, Kalshi public candlesticks.

**Spec:** `docs/superpowers/specs/2026-10-12-exit-review-design.md` (sections 5, 8, 9). Depends on **Plan A** (tables and `exits.ts`) and **Plan B** (trigger, fills, timer, `exitMath.ts`, `kalshiHistory.ts`, `exitReview.ts`) being merged on this branch.

## Where to work

All commands run **on mini-mac** (`ssh emac@mini-mac.local`) in `~/executor_module-exit` (branch `feat/exit-review`). Single file: `npx vitest run <path>`; typecheck: `npx tsc --noEmit`. There is no `sqlite3` CLI on mini-mac: query ledgers with `python3` and `sqlite3.connect("file:...?mode=ro", uri=True)`.

**Baseline:** the full suite has known non-regression failures (Redis NOAUTH in `test/main.test.ts` and `test/redis/*`, `keyphrases/generate*` without an API key, one `ledgerLock` loader test; about 29 as of 2026-10-11). Record the failed count before Task 1; it must never rise.

**Commits** (no git identity on mini-mac). Use exactly:

```bash
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "<subject>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Global Constraints

- Lateness never runs on the sell path and never blocks or fails a sale: it is a separate sweep, every row isolated in try/catch.
- `late` is true iff the held-side mark at review start was already below the publication-time mark by more than `EXIT_LOSS_FRACTION * entryPriceCents` per contract (`EXIT_LOSS_FRACTION = 0.02`, from `src/paper/exitMath.ts`).
- `centsLostToLateness = max(0, (markAtPublication - fillPrice) * contracts)`; null when the publication mark is unknown.
- Candlestick history is best effort: when it is unavailable the lag chain is still recorded and `late` stays NULL; the sweep gives up after 10 minutes instead of retrying forever.
- The backtest defaults to a **dry run** (no model calls, no cost); it needs `--run` to call the API. It opens the real ledger **read-only** and never writes to it.
- Rollout is paper-only and per unit; merging this branch into `~/executor_module` (`main`) needs the user's explicit approval, as every earlier merge did.

## Review Focus

1. A Kalshi candlestick outage must not break the exit timer, must not loop forever, and must still record the lag chain (Task 1 tests).
2. A fill younger than 90 s must not be measured yet (the covering candle may not exist) (Task 1 test).
3. A backtest run without `--run` must make zero API calls and write nothing to the ledger (Task 3 verification).
4. A position whose stored `ladder_json` is missing or malformed must be skipped with a stated reason, not crash the whole replay (Task 2 test).
5. A replayed sell must use the quote at the item's time, never a later one, and the replay of a position must stop at its first sell (Task 2 tests).

---

## File Structure

- Create: `src/paper/lateness.ts` (pure `computeLateness`, DB `sweepLateness`)
- Modify: `src/paper/exitTimer.ts` (`afterPass` hook), `src/main.ts` (wire the sweep)
- Create: `src/backtest/exitReplay.ts` (pure replay), `scripts/backtest-exit.ts` (CLI); Modify: `package.json` (`backtest-exit` script)
- Create tests: `test/paper/lateness.test.ts`, `test/paper/exitTimerAfterPass.test.ts`, `test/backtest/exitReplay.test.ts`
- Modify: `HANDOFF.md` (operator section)

---

### Task 1: The lateness sweep

**Files:**
- Create: `src/paper/lateness.ts`
- Modify: `src/paper/exitTimer.ts`, `src/main.ts`
- Test: `test/paper/lateness.test.ts`, `test/paper/exitTimerAfterPass.test.ts`

**Interfaces:**
- Consumes: `fetchCandles`, `markAtOrBefore`, `Candle` (`src/decide/kalshiHistory.ts`, Plan B); `EXIT_LOSS_FRACTION` (`src/paper/exitMath.ts`); the `paper_exits.late` / `late_json` columns and `paper_exit_reviews.lag_json` (Plan A and B); `startExitTimer`, `ExitTimerDeps` (Plan B).
- Produces:
  - `LATENESS_SETTLE_DELAY_MS = 90_000`, `LATENESS_GIVE_UP_MS = 600_000`
  - `interface LagStamps { sourcePublishTs; eventTime; firstSeenTs; emittedTs; reviewStartedAt; modelReturnedAt; firstSellAttemptAt; fillAt }` (each `string | null`)
  - `interface LatenessInput { side: 'yes'|'no'; entryPriceCents: number; contracts: number; fillPriceCents: number; filledAt: string; lag: Partial<LagStamps> }`
  - `interface LatenessResult { source: 'candles'|'none'; publishedAt: string|null; markAtPublication: number|null; markAtReviewStart: number|null; fillPriceCents: number; late: boolean|null; centsLostToLateness: number|null; lagMs: { publishToFirstSeen; firstSeenToEmitted; emittedToReviewStart; reviewStartToModelReturned; modelReturnedToSellAttempt; sellAttemptToFill; publishToFill } /* each number|null */; measuredAt: string }`
  - `computeLateness(input: LatenessInput, candles: Candle[], nowMs: number): LatenessResult` (pure)
  - `sweepLateness(db, seriesTicker: string, deps?: { fetchCandles?: typeof fetchCandles; now?: () => number; limit?: number }): Promise<number>` (rows written)
  - `ExitTimerDeps.afterPass?: () => Promise<unknown> | void` (called after every timer pass, errors isolated)

- [ ] **Step 1: Write the failing tests**

Create `test/paper/lateness.test.ts`:

```ts
// test/paper/lateness.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { recordExitReview, recordExitFill, recordExitMarker } from '../../src/paper/exits.js';
import {
  computeLateness, sweepLateness, LATENESS_SETTLE_DELAY_MS, LATENESS_GIVE_UP_MS, type LatenessInput,
} from '../../src/paper/lateness.js';
import type { Candle } from '../../src/decide/kalshiHistory.js';

const T0 = Date.parse('2026-10-12T01:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);
// one-minute candles: held YES marks at the yes bid
const candle = (offsetMs: number, bid: number, ask: number): Candle => ({ endTs: sec(T0 + offsetMs), yesBidCents: bid, yesAskCents: ask });

const input = (over: Partial<LatenessInput> = {}): LatenessInput => ({
  side: 'yes', entryPriceCents: 50, contracts: 4, fillPriceCents: 38, filledAt: new Date(T0 + 150_000).toISOString(),
  lag: {
    sourcePublishTs: new Date(T0 + 5_000).toISOString(), firstSeenTs: new Date(T0 + 20_000).toISOString(),
    emittedTs: new Date(T0 + 21_000).toISOString(), reviewStartedAt: new Date(T0 + 100_000).toISOString(),
    modelReturnedAt: new Date(T0 + 130_000).toISOString(), firstSellAttemptAt: new Date(T0 + 131_000).toISOString(),
  },
  ...over,
});

describe('computeLateness', () => {
  it('on time: the mark had not moved when we started, nothing lost beyond the fill gap', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 50, 52), candle(120_000, 49, 51)];
    const r = computeLateness(input({ fillPriceCents: 49 }), candles, T0 + 200_000);
    expect(r).toMatchObject({ source: 'candles', markAtPublication: 50, markAtReviewStart: 50, late: false, fillPriceCents: 49 });
    expect(r.centsLostToLateness).toBe(4); // (50 - 49) * 4
  });

  it('late: the held side had already fallen by more than 2% of entry before the review started', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 40, 42), candle(120_000, 38, 40)];
    const r = computeLateness(input(), candles, T0 + 200_000);
    expect(r.markAtPublication).toBe(50);
    expect(r.markAtReviewStart).toBe(40);
    expect(r.late).toBe(true); // 10c > 2% of 50c = 1c
    expect(r.centsLostToLateness).toBe(48); // (50 - 38) * 4
  });

  it('a fall within 2% of entry is not late (the threshold is strict)', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 49, 51)];
    expect(computeLateness(input({ fillPriceCents: 49 }), candles, T0 + 200_000).late).toBe(false); // 1c is not > 1c
  });

  it('a NO position uses 100 - yes ask as its mark', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 60, 62)]; // NO mark 48 then 38
    const r = computeLateness(input({ side: 'no', entryPriceCents: 48, fillPriceCents: 37 }), candles, T0 + 200_000);
    expect(r).toMatchObject({ markAtPublication: 48, markAtReviewStart: 38, late: true });
  });

  it('a fill above the publication mark loses nothing to lateness (clamped at 0)', () => {
    const candles = [candle(0, 40, 42), candle(60_000, 45, 47)];
    expect(computeLateness(input({ fillPriceCents: 45 }), candles, T0 + 200_000).centsLostToLateness).toBe(0);
  });

  it('no candle history: source none, late and loss unknown, the lag chain still recorded', () => {
    const r = computeLateness(input(), [], T0 + 200_000);
    expect(r).toMatchObject({ source: 'none', markAtPublication: null, markAtReviewStart: null, late: null, centsLostToLateness: null });
    expect(r.lagMs).toEqual({
      publishToFirstSeen: 15_000, firstSeenToEmitted: 1_000, emittedToReviewStart: 79_000, reviewStartToModelReturned: 30_000,
      modelReturnedToSellAttempt: 1_000, sellAttemptToFill: 19_000, publishToFill: 145_000,
    });
  });

  it('missing timestamps give null stages, and the publication anchor falls back to event time then first seen', () => {
    const r = computeLateness(input({ lag: { eventTime: new Date(T0).toISOString(), reviewStartedAt: new Date(T0 + 100_000).toISOString() } }), [candle(0, 50, 52)], T0 + 200_000);
    expect(r.publishedAt).toBe(new Date(T0).toISOString());
    expect(r.lagMs.publishToFirstSeen).toBeNull();
    expect(r.lagMs.publishToFill).toBe(150_000);
    expect(computeLateness(input({ lag: { firstSeenTs: new Date(T0 + 20_000).toISOString() } }), [], T0).publishedAt).toBe(new Date(T0 + 20_000).toISOString());
  });
});

describe('sweepLateness', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lateness-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const lagJson = JSON.stringify({
    sourcePublishTs: new Date(T0 + 5_000).toISOString(), reviewStartedAt: new Date(T0 + 100_000).toISOString(),
    firstSellAttemptAt: new Date(T0 + 131_000).toISOString(),
  });
  const filledExit = (itemId: string, filledAtMs: number, contracts = 4, price = 38) => {
    const p = recordPaperPosition(db, {
      trade: 'kxwti', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: `T-${itemId}`, side: 'yes', contracts,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
    const r = recordExitReview(db, { trade: 'kxwti', itemId: `n-${itemId}`, positionId: p, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson });
    const fill = recordExitFill(db, { positionId: p, reviewId: r, contracts, priceCents: price, filledAt: new Date(filledAtMs).toISOString() });
    return { p, r, exitId: fill.exitId };
  };
  const row = (id: number) => db.prepare(`SELECT late, late_json FROM paper_exits WHERE id = ?`).get(id) as { late: number | null; late_json: string | null };
  const candles = [candle(0, 50, 52), candle(60_000, 40, 42), candle(120_000, 38, 40)];

  it('measures a settled fill once, writes late + late_json, and is idempotent', async () => {
    const { exitId } = filledExit('a', T0 + 150_000);
    const fetchCandles = vi.fn(async () => candles);
    const now = () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS + 1000;
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles, now })).toBe(1);
    expect(row(exitId).late).toBe(1);
    expect(JSON.parse(row(exitId).late_json!)).toMatchObject({ source: 'candles', markAtPublication: 50, markAtReviewStart: 40, late: true, centsLostToLateness: 48 });
    expect(fetchCandles).toHaveBeenCalledWith('KXWTI', 'T-a', expect.any(Number), expect.any(Number));
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles, now })).toBe(0);
    expect(fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('does not measure a fill younger than the settle delay', async () => {
    const { exitId } = filledExit('a', T0 + 150_000);
    const fetchCandles = vi.fn(async () => candles);
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles, now: () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS - 1000 })).toBe(0);
    expect(fetchCandles).not.toHaveBeenCalled();
    expect(row(exitId).late_json).toBeNull();
  });

  it('with no candles it retries while the fill is young and gives up (source none) once it is old', async () => {
    const { exitId } = filledExit('a', T0 + 150_000);
    const empty = vi.fn(async () => [] as Candle[]);
    const young = () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS + 1000;
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles: empty, now: young })).toBe(0);
    expect(row(exitId).late_json).toBeNull();
    const old = () => T0 + 150_000 + LATENESS_GIVE_UP_MS + 1000;
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles: empty, now: old })).toBe(1);
    const stored = JSON.parse(row(exitId).late_json!);
    expect(stored.source).toBe('none');
    expect(stored.lagMs.publishToFill).toBe(145_000);
    expect(row(exitId).late).toBeNull();
  });

  it('skips marker rows (unsellable / held_to_settlement) and isolates a failing row', async () => {
    const a = filledExit('a', T0 + 150_000);
    const b = filledExit('b', T0 + 150_000);
    const p = recordPaperPosition(db, {
      trade: 'kxwti', itemId: 'm', structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-m', side: 'yes', contracts: 2,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
    const r = recordExitReview(db, { trade: 'kxwti', itemId: 'n-m', positionId: p, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson });
    recordExitMarker(db, p, r, 'unsellable');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchCandles = vi.fn(async (_s: string, market: string) => {
      if (market === 'T-a') throw new Error('boom');
      return candles;
    });
    const written = await sweepLateness(db, 'KXWTI', { fetchCandles: fetchCandles as any, now: () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS + 1000 });
    expect(written).toBe(1);
    expect(row(a.exitId).late_json).toBeNull(); // failed row retried next sweep
    expect(row(b.exitId).late_json).not.toBeNull();
    expect(err).toHaveBeenCalled();
    expect(fetchCandles).toHaveBeenCalledTimes(2); // the marker row was never fetched
  });

  it('survives a malformed lag_json', async () => {
    const { exitId, r } = filledExit('a', T0 + 150_000);
    db.prepare(`UPDATE paper_exit_reviews SET lag_json = '{not json' WHERE id = ?`).run(r);
    const written = await sweepLateness(db, 'KXWTI', { fetchCandles: async () => [], now: () => T0 + 150_000 + LATENESS_GIVE_UP_MS + 1000 });
    expect(written).toBe(1);
    expect(JSON.parse(row(exitId).late_json!).source).toBe('none');
  });
});
```

Create `test/paper/exitTimerAfterPass.test.ts`:

```ts
// test/paper/exitTimerAfterPass.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLedger } from '../../src/decide/ledger.js';
import { startExitTimer } from '../../src/paper/exitTimer.js';

describe('startExitTimer afterPass', () => {
  afterEach(() => vi.useRealTimers());

  it('runs afterPass after every tick, survives its failures, and stops with the timer', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(tmpdir(), 'timer-after-'));
    const db = openLedger(path.join(dir, 'l.db'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const afterPass = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('sweep failed'); });
    const t = startExitTimer({ db, fetchLadderForEvent: async () => { throw new Error('unused'); }, afterPass }, 1000);
    await vi.advanceTimersByTimeAsync(3500);
    expect(afterPass).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalled();
    t.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(afterPass).toHaveBeenCalledTimes(3);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a pass that is still running makes the next tick skip both the pass and afterPass', async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(tmpdir(), 'timer-after2-'));
    const db = openLedger(path.join(dir, 'l.db'));
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const afterPass = vi.fn(async () => { await hold; });
    const t = startExitTimer({ db, fetchLadderForEvent: async () => { throw new Error('unused'); }, afterPass }, 1000);
    await vi.advanceTimersByTimeAsync(3500);
    expect(afterPass).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    t.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/paper/lateness.test.ts test/paper/exitTimerAfterPass.test.ts`
Expected: FAIL (`lateness.js` not found; `afterPass` is never called).

- [ ] **Step 3: Implement `lateness.ts`**

Create `src/paper/lateness.ts`:

```ts
// src/paper/lateness.ts
//
// How late was an exit (spec section 5)? A SWEEP, never part of the sell: it finds fills that have no
// late_json yet, waits until the candle covering the fill can exist, fetches Kalshi candlesticks and
// records price at publication / at review start / at the fill, a late flag and the cents lost to lateness.
import type Database from 'better-sqlite3';
import { fetchCandles as defaultFetchCandles, markAtOrBefore, type Candle } from '../decide/kalshiHistory.js';
import { EXIT_LOSS_FRACTION } from './exitMath.js';

/** Wait this long after a fill before measuring, so the one-minute candle covering it exists. */
export const LATENESS_SETTLE_DELAY_MS = 90_000;
/** With no history after this long, record "source none" instead of retrying forever. */
export const LATENESS_GIVE_UP_MS = 10 * 60_000;

export interface LagStamps {
  sourcePublishTs: string | null;
  eventTime: string | null;
  firstSeenTs: string | null;
  emittedTs: string | null;
  reviewStartedAt: string | null;
  modelReturnedAt: string | null;
  firstSellAttemptAt: string | null;
  fillAt: string | null;
}

export interface LatenessInput {
  side: 'yes' | 'no';
  entryPriceCents: number;
  contracts: number;
  fillPriceCents: number;
  filledAt: string;
  lag: Partial<LagStamps>;
}

export interface LatenessResult {
  source: 'candles' | 'none';
  publishedAt: string | null;
  markAtPublication: number | null;
  markAtReviewStart: number | null;
  fillPriceCents: number;
  late: boolean | null;
  centsLostToLateness: number | null;
  lagMs: {
    publishToFirstSeen: number | null;
    firstSeenToEmitted: number | null;
    emittedToReviewStart: number | null;
    reviewStartToModelReturned: number | null;
    modelReturnedToSellAttempt: number | null;
    sellAttemptToFill: number | null;
    publishToFill: number | null;
  };
  measuredAt: string;
}

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const diff = (from: number | null, to: number | null): number | null => (from === null || to === null ? null : to - from);

/** When the news was published: source publish time, else the event time, else when we first saw it. */
export function publicationMs(lag: Partial<LagStamps>): number | null {
  return ms(lag.sourcePublishTs) ?? ms(lag.eventTime) ?? ms(lag.firstSeenTs);
}

export function computeLateness(input: LatenessInput, candles: Candle[], nowMs: number): LatenessResult {
  const pub = publicationMs(input.lag);
  const start = ms(input.lag.reviewStartedAt);
  const fill = ms(input.filledAt);
  const have = candles.length > 0;
  const markPub = have && pub !== null ? markAtOrBefore(candles, Math.floor(pub / 1000), input.side) : null;
  const markStart = have && start !== null ? markAtOrBefore(candles, Math.floor(start / 1000), input.side) : null;
  const late = markPub !== null && markStart !== null ? markPub - markStart > EXIT_LOSS_FRACTION * input.entryPriceCents : null;
  const lost = markPub !== null ? Math.max(0, (markPub - input.fillPriceCents) * input.contracts) : null;
  const lag = input.lag;
  return {
    source: have ? 'candles' : 'none',
    publishedAt: pub === null ? null : new Date(pub).toISOString(),
    markAtPublication: markPub,
    markAtReviewStart: markStart,
    fillPriceCents: input.fillPriceCents,
    late,
    centsLostToLateness: lost,
    lagMs: {
      publishToFirstSeen: diff(pub, ms(lag.firstSeenTs)),
      firstSeenToEmitted: diff(ms(lag.firstSeenTs), ms(lag.emittedTs)),
      emittedToReviewStart: diff(ms(lag.emittedTs), start),
      reviewStartToModelReturned: diff(start, ms(lag.modelReturnedAt)),
      modelReturnedToSellAttempt: diff(ms(lag.modelReturnedAt), ms(lag.firstSellAttemptAt)),
      sellAttemptToFill: diff(ms(lag.firstSellAttemptAt), fill),
      publishToFill: diff(pub, fill),
    },
    measuredAt: new Date(nowMs).toISOString(),
  };
}

interface SweepRow {
  id: number;
  contracts: number;
  fillPrice: number;
  filledAt: string;
  side: 'yes' | 'no';
  market: string;
  entry: number;
  lagJson: string | null;
  trade: string;
}

function parseLag(raw: string | null): Partial<LagStamps> {
  if (raw === null) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Partial<LagStamps>) : {};
  } catch {
    return {};
  }
}

/** Measures up to `limit` unmeasured fills. Returns the number of rows written. Never throws. */
export async function sweepLateness(
  db: Database.Database,
  seriesTicker: string,
  deps: { fetchCandles?: typeof defaultFetchCandles; now?: () => number; limit?: number } = {}
): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const fetchCandles = deps.fetchCandles ?? defaultFetchCandles;
  let rows: SweepRow[];
  try {
    rows = db
      .prepare(
        `SELECT e.id, e.contracts, e.price_cents AS fillPrice, e.filled_at AS filledAt, p.side, p.market_ticker AS market,
                p.entry_price_cents AS entry, r.lag_json AS lagJson, p.trade AS trade
           FROM paper_exits e
           JOIN paper_positions p ON p.id = e.position_id
           JOIN paper_exit_reviews r ON r.id = e.review_id
          WHERE e.status IN ('filled', 'partial') AND e.late_json IS NULL AND e.filled_at IS NOT NULL AND e.filled_at <= ?
          ORDER BY e.id LIMIT ?`
      )
      .all(new Date(now - LATENESS_SETTLE_DELAY_MS).toISOString(), deps.limit ?? 20) as SweepRow[];
  } catch (err) {
    console.error('[exit-lateness] sweep query failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }

  let written = 0;
  for (const row of rows) {
    try {
      const lag = parseLag(row.lagJson);
      const fillMs = Date.parse(row.filledAt);
      const pub = publicationMs(lag);
      const startTs = Math.floor(((pub ?? fillMs - 15 * 60_000) - 2 * 60_000) / 1000);
      const endTs = Math.floor(fillMs / 1000) + 120;
      const candles = await fetchCandles(seriesTicker, row.market, startTs, endTs);
      if (candles.length === 0 && now - fillMs < LATENESS_GIVE_UP_MS) continue; // history may simply not be there yet
      const result = computeLateness(
        { side: row.side, entryPriceCents: row.entry, contracts: row.contracts, fillPriceCents: row.fillPrice, filledAt: row.filledAt, lag },
        candles,
        now
      );
      db.prepare(`UPDATE paper_exits SET late = ?, late_json = ? WHERE id = ?`).run(
        result.late === null ? null : result.late ? 1 : 0,
        JSON.stringify(result),
        row.id
      );
      written += 1;
      const seconds = result.lagMs.publishToFill === null ? '?' : (result.lagMs.publishToFill / 1000).toFixed(0);
      if (result.late === true) {
        console.warn(
          `[EXIT LATE] trade=${row.trade} market=${row.market} side=${row.side} published=${result.publishedAt} ` +
            `mark ${result.markAtPublication}c -> ${result.markAtReviewStart}c at review start, sold ${row.contracts} @${row.fillPrice}c, ` +
            `lost ${result.centsLostToLateness}c to lateness, publish-to-fill ${seconds}s`
        );
      } else {
        console.log(`[EXIT LAG] trade=${row.trade} market=${row.market} late=${result.late} source=${result.source} publish-to-fill ${seconds}s`);
      }
    } catch (err) {
      console.error(`[exit-lateness] measuring exit ${row.id} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return written;
}
```

- [ ] **Step 4: Add the `afterPass` hook to the timer**

In `src/paper/exitTimer.ts`, add to `ExitTimerDeps`:

```ts
  /** Runs after every pass (the lateness sweep uses it); its failures are logged and never stop the timer. */
  afterPass?: () => Promise<unknown> | void;
```

and replace `startExitTimer` with:

```ts
export function startExitTimer(deps: ExitTimerDeps, intervalMs: number): { stop: () => void } {
  let inProgress = false;
  const timer = setInterval(() => {
    if (inProgress) return; // a slow pass skips the next tick, never overlaps
    inProgress = true;
    (async () => {
      try {
        await runPendingExits(deps);
      } catch (err) {
        console.error('[exit-timer] pass failed:', err);
      }
      try {
        await deps.afterPass?.();
      } catch (err) {
        console.error('[exit-timer] afterPass failed:', err);
      }
    })().finally(() => { inProgress = false; });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 5: Wire the sweep in `main.ts`**

In `src/main.ts` add `import { sweepLateness } from './paper/lateness.js';` and change the exit-timer construction (added in Plan B Task 9) to:

```ts
  const exitTimer = exitCfg.enabled
    ? startExitTimer(
        { db, fetchLadderForEvent, afterPass: () => sweepLateness(db, loaded.profile.seriesTicker) },
        exitCfg.retryMs
      )
    : null;
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/paper test/decide/exitPipeline.test.ts && npx tsc --noEmit`
Expected: PASS (new lateness and afterPass tests, and Plan B's `exitTimer.test.ts` unchanged); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/paper/lateness.ts src/paper/exitTimer.ts src/main.ts test/paper/lateness.test.ts test/paper/exitTimerAfterPass.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(paper): lateness sweep for exits (lag chain + candlestick marks)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The replay core (pure)

Everything the backtest decides is in pure, testable functions; the CLI in Task 3 only does I/O.

**Files:**
- Create: `src/backtest/exitReplay.ts`
- Test: `test/backtest/exitReplay.test.ts`

**Interfaces:**
- Consumes: `evaluateExit` (`src/paper/exitMath.ts`); `Candle`, `TrajectoryPoint`, `TRAJECTORY_MINUTES`, `markAtOrBefore` (`src/decide/kalshiHistory.ts`); `BandMarket`.
- Produces (all exported from `src/backtest/exitReplay.ts`):
  - `extractArticleText(requestJson: string): string | null`
  - `type CandleMap = Map<string, Candle[]>` (ticker to sorted candles)
  - `parseLadderJson(ladderJson: string): BandMarket[] | null` (null when missing/malformed/empty)
  - `bandsAt(ladder: BandMarket[], candles: CandleMap, tsSec: number): BandMarket[]` (quotes from the last candle at or before `tsSec`; no candle means null quotes; sizes 1000; status `active`)
  - `trajectoryAt(candles: Candle[], side: 'yes'|'no', tsSec: number): TrajectoryPoint[]`
  - `interface ReplayItem { itemId: string; seenAtSec: number; text: string }`
  - `interface ReplayPosition { id: number; side: 'yes'|'no'; structure: 'band'|'threshold'|'binary'; marketTicker: string; contracts: number; entryPriceCents: number; createdAtSec: number; endSec: number | null; actualPnlCents: number | null; ladder: BandMarket[] }`
  - `type ReviewFn = (a: { item: ReplayItem; position: ReplayPosition; market: BandMarket; bands: BandMarket[]; trajectory: TrajectoryPoint[] }) => Promise<{ shift: number; confidence: number; reason: string }>`
  - `interface ReplayRow { itemId: string; atSec: number; verdict: 'sell' | 'hold' | 'skip'; reason: string; shift: number | null; confidence: number | null; lossCents: number | null }`
  - `interface ReplayResult { positionId: number; marketTicker: string; side: 'yes'|'no'; contracts: number; entryPriceCents: number; reviewed: number; sold: { atSec: number; itemId: string; priceCents: number; hypPnlCents: number } | null; actualPnlCents: number | null; deltaCents: number | null; rows: ReplayRow[] }`
  - `replayPosition(position, items, candles, review, opts?: { exitFeeCents?: number; maxItems?: number }): Promise<ReplayResult>`
  - `summarizeReplay(results: ReplayResult[]): { positions: number; reviewed: number; sells: number; regretSells: number; hypPnlCents: number; actualPnlCents: number; deltaCents: number }`

- [ ] **Step 1: Write the failing test**

Create `test/backtest/exitReplay.test.ts`:

```ts
// test/backtest/exitReplay.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  extractArticleText, parseLadderJson, bandsAt, trajectoryAt, replayPosition, summarizeReplay,
  type CandleMap, type ReplayItem, type ReplayPosition, type ReviewFn,
} from '../../src/backtest/exitReplay.js';
import type { Candle } from '../../src/decide/kalshiHistory.js';
import type { BandMarket } from '../../src/decide/kalshi.js';
import { thresholdBands } from '../paper/exitFixtures.js';

describe('extractArticleText', () => {
  it('takes the text between <article> tags from a messages-shaped request', () => {
    const req = JSON.stringify({ system: 's', messages: [{ role: 'user', content: 'Evidentiary rung: reported\n\n<article>\nTitle: X\nExcerpt: Y\n</article>' }] });
    expect(extractArticleText(req)).toBe('Title: X\nExcerpt: Y');
  });
  it('uses the whole user string of a gate-shaped request when there are no tags', () => {
    expect(extractArticleText(JSON.stringify({ system: 's', user: 'Title: Gate item', options: {} }))).toBe('Title: Gate item');
  });
  it('returns null for malformed json or a request with no text', () => {
    expect(extractArticleText('{nope')).toBeNull();
    expect(extractArticleText(JSON.stringify({ system: 's' }))).toBeNull();
    expect(extractArticleText(JSON.stringify({ messages: [{ role: 'user', content: '   ' }] }))).toBeNull();
  });
});

describe('parseLadderJson', () => {
  it('returns the bands, or null for missing / malformed / empty ladders', () => {
    const bands = thresholdBands(1);
    expect(parseLadderJson(JSON.stringify({ eventTicker: 'EV', bands }))).toHaveLength(5);
    expect(parseLadderJson('[]')).toBeNull();
    expect(parseLadderJson('{bad')).toBeNull();
    expect(parseLadderJson(JSON.stringify({ eventTicker: 'EV', bands: [] }))).toBeNull();
    expect(parseLadderJson(JSON.stringify({ eventTicker: 'EV' }))).toBeNull();
  });
});

// candles: each ticker quotes its fixture mid +/- 1c from t=2000 on
function candlesFor(adjust: (ticker: string, ts: number, bid: number, ask: number) => [number, number] = (_t, _ts, b, a) => [b, a]): CandleMap {
  const map: CandleMap = new Map();
  for (const b of thresholdBands(1)) {
    const cs: Candle[] = [];
    for (const ts of [2000, 2060, 2120, 2180, 2240]) {
      const [bid, ask] = adjust(b.ticker, ts, b.yesBidCents!, b.yesAskCents!);
      cs.push({ endTs: ts, yesBidCents: bid, yesAskCents: ask });
    }
    map.set(b.ticker, cs);
  }
  return map;
}

describe('bandsAt / trajectoryAt', () => {
  it('quotes each band from the last candle at or before the time; none yet means null quotes', () => {
    const ladder = thresholdBands(1);
    const map = candlesFor((t, ts, b, a) => (t === 'T-94' && ts >= 2120 ? [b - 10, a - 10] : [b, a]));
    const early = bandsAt(ladder, map, 1999);
    expect(early.every((b) => b.yesBidCents === null && b.yesAskCents === null)).toBe(true);
    const mid = bandsAt(ladder, map, 2100);
    expect(mid.find((b) => b.ticker === 'T-94')).toMatchObject({ yesBidCents: 49, yesAskCents: 51, status: 'active', yesBidSizeContracts: 1000, yesAskSizeContracts: 1000, floorStrike: 94, strikeType: 'greater' });
    expect(bandsAt(ladder, map, 2130).find((b) => b.ticker === 'T-94')).toMatchObject({ yesBidCents: 39, yesAskCents: 41 });
  });

  it('trajectoryAt reads the held-side mark 5, 15 and 60 minutes earlier', () => {
    const cs: Candle[] = [
      { endTs: 1000, yesBidCents: 60, yesAskCents: 62 }, { endTs: 1000 + 45 * 60, yesBidCents: 50, yesAskCents: 52 },
      { endTs: 1000 + 55 * 60, yesBidCents: 45, yesAskCents: 47 },
    ];
    const t = trajectoryAt(cs, 'yes', 1000 + 60 * 60);
    expect(t).toEqual([
      { minutesAgo: 5, markCents: 45 }, { minutesAgo: 15, markCents: 50 }, { minutesAgo: 60, markCents: 60 },
    ]);
  });
});

describe('replayPosition', () => {
  const position = (over: Partial<ReplayPosition> = {}): ReplayPosition => ({
    id: 1, side: 'yes', structure: 'threshold', marketTicker: 'T-94', contracts: 4, entryPriceCents: 50, createdAtSec: 1000,
    endSec: 100_000, actualPnlCents: -200, ladder: thresholdBands(1), ...over,
  });
  const item = (id: string, at: number): ReplayItem => ({ itemId: id, seenAtSec: at, text: `text of ${id}` });
  const adverse = { shift: -2, confidence: 1, reason: 'bearish' };
  const quiet = { shift: 0, confidence: 0.1, reason: 'noise' };

  it('stops at the first sell, prices it at the quote at that item time, and compares with what happened', async () => {
    const review: ReviewFn = vi.fn(async ({ item: it }) => (it.itemId === 'i3' ? adverse : quiet));
    const items = [item('i0', 500), item('i1', 1500), item('i2', 2100), item('i3', 2200), item('i4', 2300)];
    const r = await replayPosition(position(), items, candlesFor(), review);
    expect(r.rows.map((x) => [x.itemId, x.verdict])).toEqual([['i1', 'skip'], ['i2', 'hold'], ['i3', 'sell']]);
    expect(r.rows[0].reason).toMatch(/no quote/);
    expect(r.reviewed).toBe(2); // the model was called for i2 and i3 only (i0 predates the position, i1 had no quote, i4 comes after the sell)
    expect(review).toHaveBeenCalledTimes(2);
    expect(r.sold).toEqual({ atSec: 2200, itemId: 'i3', priceCents: 49, hypPnlCents: 4 * (49 - 50) });
    expect(r.actualPnlCents).toBe(-200);
    expect(r.deltaCents).toBe(-4 - -200);
  });

  it('uses the quote at the item time, never a later one', async () => {
    const map = candlesFor((t, ts, b, a) => (t === 'T-94' && ts >= 2180 ? [b - 30, a - 30] : [b, a])); // crash AFTER the item
    const r = await replayPosition(position(), [item('i1', 2150)], map, async () => adverse);
    expect(r.sold!.priceCents).toBe(49);
  });

  it('never sells: hypothetical equals actual and the delta is zero', async () => {
    const r = await replayPosition(position(), [item('i1', 2100), item('i2', 2200)], candlesFor(), async () => quiet);
    expect(r.sold).toBeNull();
    expect(r.deltaCents).toBe(0);
    expect(r.rows.map((x) => x.verdict)).toEqual(['hold', 'hold']);
  });

  it('an unknown actual outcome gives a null delta', async () => {
    const r = await replayPosition(position({ actualPnlCents: null }), [item('i1', 2100)], candlesFor(), async () => adverse);
    expect(r.sold).not.toBeNull();
    expect(r.deltaCents).toBeNull();
  });

  it('a sell trigger with no held-side bid at that time is a skip, and the replay continues to the next item', async () => {
    // a binary market: with no bid its mid is the quoted ask, so the trigger fires but nothing can be sold yet
    const binary: BandMarket = { ...thresholdBands(1)[2], strikeType: null, floorStrike: null };
    const map: CandleMap = new Map([
      ['T-94', [
        { endTs: 2060, yesBidCents: null, yesAskCents: 30 },
        { endTs: 2160, yesBidCents: 29, yesAskCents: 31 },
      ]],
    ]);
    const p = position({ structure: 'binary', ladder: [binary], entryPriceCents: 30, actualPnlCents: -120 });
    const r = await replayPosition(p, [item('i1', 2100), item('i2', 2200)], map, async () => adverse);
    expect(r.rows[0]).toMatchObject({ itemId: 'i1', verdict: 'skip' });
    expect(r.rows[0].reason).toMatch(/no bid/);
    expect(r.sold).toEqual({ atSec: 2200, itemId: 'i2', priceCents: 29, hypPnlCents: 4 * (29 - 30) });
  });

  it('a review that throws is a skip with the message, not a crash', async () => {
    const r = await replayPosition(position(), [item('i1', 2100), item('i2', 2200)], candlesFor(), async ({ item: it }) => {
      if (it.itemId === 'i1') throw new Error('API 529');
      return quiet;
    });
    expect(r.rows[0]).toMatchObject({ verdict: 'skip' });
    expect(r.rows[0].reason).toMatch(/529/);
    expect(r.rows[1].verdict).toBe('hold');
  });

  it('honours maxItems and the position window (items after endSec are ignored)', async () => {
    const review = vi.fn(async () => quiet);
    const items = [item('a', 2100), item('b', 2110), item('c', 2120), item('d', 200_000)];
    const r = await replayPosition(position(), items, candlesFor(), review, { maxItems: 2 });
    expect(r.rows).toHaveLength(2);
    expect(review).toHaveBeenCalledTimes(2);
    const r2 = await replayPosition(position({ endSec: 2105 }), items, candlesFor(), review);
    expect(r2.rows.map((x) => x.itemId)).toEqual(['a']);
  });

  it('applies the exit fee from the options', async () => {
    const r = await replayPosition(position(), [item('i1', 2100)], candlesFor(), async () => adverse, { exitFeeCents: 50 });
    expect(r.sold).toBeNull(); // 20c loss does not beat a 51c exit cost
    expect(r.rows[0].verdict).toBe('hold');
  });
});

describe('summarizeReplay', () => {
  it('totals reviews, sells, regret (selling was worse than holding) and P&L', () => {
    const base = { marketTicker: 'M', side: 'yes' as const, contracts: 1, entryPriceCents: 50, rows: [] };
    const s = summarizeReplay([
      { ...base, positionId: 1, reviewed: 3, sold: { atSec: 1, itemId: 'a', priceCents: 40, hypPnlCents: -10 }, actualPnlCents: -50, deltaCents: 40 },
      { ...base, positionId: 2, reviewed: 2, sold: { atSec: 1, itemId: 'b', priceCents: 40, hypPnlCents: -10 }, actualPnlCents: 50, deltaCents: -60 },
      { ...base, positionId: 3, reviewed: 1, sold: null, actualPnlCents: -20, deltaCents: 0 },
      { ...base, positionId: 4, reviewed: 1, sold: null, actualPnlCents: null, deltaCents: null },
    ]);
    expect(s).toEqual({ positions: 4, reviewed: 7, sells: 2, regretSells: 1, hypPnlCents: -10 + -10 + -20, actualPnlCents: -50 + 50 + -20, deltaCents: 40 + -60 + 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/backtest/exitReplay.test.ts`
Expected: FAIL (`exitReplay.js` not found).

- [ ] **Step 3: Implement**

Create `src/backtest/exitReplay.ts`:

```ts
// src/backtest/exitReplay.ts
//
// Pure core of the exit-review backtest (spec section 8, step 5). Given a past position, the news items
// the pipeline logged after it was opened, and Kalshi candlesticks for every market of its event, replay
// what the exit review would have done: at each item, rebuild the ladder as quoted at that moment, ask the
// (injected) reviewer for shift + confidence, run evaluateExit, and on the first sell price the fill at the
// held-side bid of that same moment. No I/O here: the CLI supplies the data and the reviewer.
import type { BandMarket } from '../decide/kalshi.js';
import { markAtOrBefore, TRAJECTORY_MINUTES, type Candle, type TrajectoryPoint } from '../decide/kalshiHistory.js';
import { evaluateExit } from '../paper/exitMath.js';

export type CandleMap = Map<string, Candle[]>;

/** The article text a logged model call saw: between <article> tags when present, else the whole user text. */
export function extractArticleText(requestJson: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return null;
  }
  const raw = parsed?.messages?.[0]?.content ?? parsed?.user;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/<article>\s*([\s\S]*?)\s*<\/article>/);
  const text = (m ? m[1] : raw).trim();
  return text === '' ? null : text;
}

/** The bands saved with a paper position at entry; null when missing, malformed or empty. */
export function parseLadderJson(ladderJson: string): BandMarket[] | null {
  try {
    const v = JSON.parse(ladderJson);
    const bands = v?.bands;
    return Array.isArray(bands) && bands.length > 0 ? (bands as BandMarket[]) : null;
  } catch {
    return null;
  }
}

function quoteAt(candles: Candle[] | undefined, tsSec: number): Candle | null {
  if (candles === undefined) return null;
  let found: Candle | null = null;
  for (const c of candles) {
    if (c.endTs <= tsSec) found = c;
    else break;
  }
  return found;
}

/** The ladder as quoted at `tsSec`: static fields from the saved ladder, bid/ask from the last candle at or before. */
export function bandsAt(ladder: BandMarket[], candles: CandleMap, tsSec: number): BandMarket[] {
  return ladder.map((b) => {
    const q = quoteAt(candles.get(b.ticker), tsSec);
    return {
      ...b,
      status: 'active',
      yesBidCents: q?.yesBidCents ?? null,
      yesAskCents: q?.yesAskCents ?? null,
      yesBidSizeContracts: 1000, // candles carry no depth: assume the touch can absorb a paper-sized order
      yesAskSizeContracts: 1000,
    };
  });
}

export function trajectoryAt(candles: Candle[], side: 'yes' | 'no', tsSec: number): TrajectoryPoint[] {
  return TRAJECTORY_MINUTES.map((m) => ({ minutesAgo: m, markCents: markAtOrBefore(candles, tsSec - m * 60, side) }));
}

export interface ReplayItem {
  itemId: string;
  seenAtSec: number;
  text: string;
}

export interface ReplayPosition {
  id: number;
  side: 'yes' | 'no';
  structure: 'band' | 'threshold' | 'binary';
  marketTicker: string;
  contracts: number;
  entryPriceCents: number;
  createdAtSec: number;
  /** When it settled (unix s), or null while still open. */
  endSec: number | null;
  /** What actually happened: settlement P&L, or the open mark; null when unknown. */
  actualPnlCents: number | null;
  ladder: BandMarket[];
}

export type ReviewFn = (a: {
  item: ReplayItem;
  position: ReplayPosition;
  market: BandMarket;
  bands: BandMarket[];
  trajectory: TrajectoryPoint[];
}) => Promise<{ shift: number; confidence: number; reason: string }>;

export interface ReplayRow {
  itemId: string;
  atSec: number;
  verdict: 'sell' | 'hold' | 'skip';
  reason: string;
  shift: number | null;
  confidence: number | null;
  lossCents: number | null;
}

export interface ReplayResult {
  positionId: number;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
  /** Model calls actually made. */
  reviewed: number;
  sold: { atSec: number; itemId: string; priceCents: number; hypPnlCents: number } | null;
  actualPnlCents: number | null;
  /** hypothetical - actual (positive = selling would have been better); null when the actual is unknown. */
  deltaCents: number | null;
  rows: ReplayRow[];
}

export async function replayPosition(
  position: ReplayPosition,
  items: ReplayItem[],
  candles: CandleMap,
  review: ReviewFn,
  opts: { exitFeeCents?: number; maxItems?: number } = {}
): Promise<ReplayResult> {
  const window = items
    .filter((i) => i.seenAtSec > position.createdAtSec && (position.endSec === null || i.seenAtSec < position.endSec))
    .sort((a, b) => a.seenAtSec - b.seenAtSec)
    .slice(0, opts.maxItems ?? Number.POSITIVE_INFINITY);

  const rows: ReplayRow[] = [];
  let reviewed = 0;
  let sold: ReplayResult['sold'] = null;
  const skip = (item: ReplayItem, reason: string): void => {
    rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'skip', reason, shift: null, confidence: null, lossCents: null });
  };

  for (const item of window) {
    const bands = bandsAt(position.ladder, candles, item.seenAtSec);
    const market = bands.find((b) => b.ticker === position.marketTicker);
    if (market === undefined || (market.yesBidCents === null && market.yesAskCents === null)) {
      skip(item, 'no quote for the held market at that time');
      continue;
    }
    const trajectory = trajectoryAt(candles.get(position.marketTicker) ?? [], position.side, item.seenAtSec);
    let answer;
    try {
      reviewed += 1;
      answer = await review({ item, position, market, bands, trajectory });
    } catch (err) {
      skip(item, `review failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const math = evaluateExit({
      structure: position.structure, side: position.side, contracts: position.contracts, remaining: position.contracts,
      entryPriceCents: position.entryPriceCents, market, bands, shift: answer.shift, confidence: answer.confidence,
      exitFeeCents: opts.exitFeeCents,
    });
    if (!math.sell) {
      rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'hold', reason: math.reason, shift: answer.shift, confidence: answer.confidence, lossCents: math.lossCents });
      continue;
    }
    const bid = position.side === 'yes' ? market.yesBidCents : market.yesAskCents === null ? null : 100 - market.yesAskCents;
    if (bid === null || bid <= 0) {
      rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'skip', reason: 'sell triggered but there was no bid at that time', shift: answer.shift, confidence: answer.confidence, lossCents: math.lossCents });
      continue;
    }
    rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'sell', reason: math.reason, shift: answer.shift, confidence: answer.confidence, lossCents: math.lossCents });
    sold = { atSec: item.seenAtSec, itemId: item.itemId, priceCents: bid, hypPnlCents: position.contracts * (bid - position.entryPriceCents) };
    break;
  }

  const hyp = sold !== null ? sold.hypPnlCents : position.actualPnlCents;
  return {
    positionId: position.id, marketTicker: position.marketTicker, side: position.side, contracts: position.contracts,
    entryPriceCents: position.entryPriceCents, reviewed, sold, actualPnlCents: position.actualPnlCents,
    deltaCents: hyp === null || position.actualPnlCents === null ? null : hyp - position.actualPnlCents,
    rows,
  };
}

export function summarizeReplay(results: ReplayResult[]): {
  positions: number; reviewed: number; sells: number; regretSells: number; hypPnlCents: number; actualPnlCents: number; deltaCents: number;
} {
  let reviewed = 0, sells = 0, regretSells = 0, hyp = 0, actual = 0, delta = 0;
  for (const r of results) {
    reviewed += r.reviewed;
    if (r.sold !== null) {
      sells += 1;
      if (r.deltaCents !== null && r.deltaCents < 0) regretSells += 1;
    }
    const h = r.sold !== null ? r.sold.hypPnlCents : r.actualPnlCents;
    if (h !== null) hyp += h;
    if (r.actualPnlCents !== null) actual += r.actualPnlCents;
    if (r.deltaCents !== null) delta += r.deltaCents;
  }
  return { positions: results.length, reviewed, sells, regretSells, hypPnlCents: hyp, actualPnlCents: actual, deltaCents: delta };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/backtest/exitReplay.test.ts && npx tsc --noEmit`
Expected: PASS (all tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/backtest/exitReplay.ts test/backtest/exitReplay.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(backtest): pure replay core for the exit review" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The backtest CLI

**Files:**
- Create: `scripts/backtest-exit.ts`
- Modify: `package.json` (add `"backtest-exit": "tsx scripts/backtest-exit.ts"` to `scripts`, after `"score-paper"`)
- Test: none beyond Task 2 (the CLI is I/O only); verified by the dry run and one real run below.

**Interfaces:**
- Consumes: Task 2's `replayPosition`, `summarizeReplay`, `extractArticleText`, `parseLadderJson`; `fetchCandles` (`src/decide/kalshiHistory.ts`); `reviewForExit` (`src/decide/exitReview.ts`); `loadProfile` (`src/profile/profile.ts`); `openLedger`.
- Produces: `npm run backtest-exit -- --trade <name> [--data <dir>] [--run] [--model <id>] [--max-items <n>] [--fee <cents>] [--out <dir>]`. `--data` is the directory holding `<trade>/decisions.db` (default `<repo>/data`; the worktree has none, so pass `--data ~/executor_module/data`). Without `--run` it is a dry run (counts the planned model calls, no API cost, no candle fetches). It writes `<out>/<trade>-<yyyy-mm-dd>.md` (default `~/exit-backtest`) and prints the summary.

- [ ] **Step 1: Create the script**

Create `scripts/backtest-exit.ts`:

```ts
// scripts/backtest-exit.ts
//
// Replays the news a paper trade's ledger logged against the positions it opened, to show what the exit
// review WOULD have done (spec section 8, step 5). READ-ONLY against the real ledger; model calls (only
// with --run) are logged to an in-memory scratch ledger. Default is a dry run: it spends nothing.
//   npm run backtest-exit -- --trade kxwti                    # dry run: counts planned model calls
//   npm run backtest-exit -- --trade kxwti --run --max-items 40
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { openLedger } from '../src/decide/ledger.js';
import { loadProfile } from '../src/profile/profile.js';
import { fetchCandles, type Candle } from '../src/decide/kalshiHistory.js';
import { reviewForExit } from '../src/decide/exitReview.js';
import {
  extractArticleText, parseLadderJson, replayPosition, summarizeReplay,
  type CandleMap, type ReplayItem, type ReplayPosition, type ReviewFn, type ReplayResult,
} from '../src/backtest/exitReplay.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDLE_CHUNK_SEC = 4000 * 60; // stay under the per-request candle limit
const THROTTLE_MS = 400; // Kalshi's public API 429s when hit about 40 times quickly

interface Args { trade: string; data: string; run: boolean; model: string | undefined; maxItems: number; fee: number; out: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { trade: '', data: path.join(REPO_ROOT, 'data'), run: false, model: undefined, maxItems: 80, fee: 0, out: path.join(os.homedir(), 'exit-backtest') };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined || x.startsWith('--')) throw new Error(`${f} requires a value`); return x; };
    if (f === '--trade') a.trade = v();
    else if (f === '--data') a.data = path.resolve(v());
    else if (f === '--run') a.run = true;
    else if (f === '--model') a.model = v();
    else if (f === '--max-items') a.maxItems = Number(v());
    else if (f === '--fee') a.fee = Number(v());
    else if (f === '--out') a.out = v();
    else throw new Error(`unknown argument ${JSON.stringify(f)}`);
  }
  if (!a.trade) throw new Error('--trade <name> is required');
  if (!Number.isInteger(a.maxItems) || a.maxItems < 1) throw new Error('--max-items must be a positive integer');
  if (!Number.isFinite(a.fee) || a.fee < 0) throw new Error('--fee must be a number >= 0');
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

async function candlesForRange(series: string, ticker: string, startSec: number, endSec: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let from = startSec; from < endSec; from += CANDLE_CHUNK_SEC) {
    out.push(...(await fetchCandles(series, ticker, from, Math.min(endSec, from + CANDLE_CHUNK_SEC))));
    await sleep(THROTTLE_MS);
  }
  return out.sort((x, y) => x.endTs - y.endTs);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadProfile(args.trade);
  const series = loaded.profile.seriesTicker;
  const ledgerPath = path.join(args.data, args.trade, 'decisions.db');
  if (!fs.existsSync(ledgerPath)) throw new Error(`ledger not found: ${ledgerPath}`);
  const src = new Database(ledgerPath, { readonly: true, fileMustExist: true });

  // positions with a side, and what actually happened to them
  const posRows = src
    .prepare(
      `SELECT id, side, structure, market_ticker AS marketTicker, contracts, entry_price_cents AS entry, created_at AS createdAt,
              settled_at AS settledAt, pnl_cents AS pnl, ladder_json AS ladderJson
         FROM paper_positions WHERE side IS NOT NULL ORDER BY id`
    )
    .all() as Array<{ id: number; side: 'yes' | 'no'; structure: string; marketTicker: string; contracts: number; entry: number; createdAt: string; settledAt: string | null; pnl: number | null; ladderJson: string }>;

  // news that passed the gate, with the text a model saw (gate request first seen time = when it reached us)
  const itemRows = src
    .prepare(
      `SELECT g.item_id AS itemId, MIN(g.called_at) AS seen,
              (SELECT request_json FROM ai_calls x WHERE x.item_id = g.item_id AND x.stage IN ('decide','triage') AND x.error IS NULL ORDER BY x.id LIMIT 1) AS richJson,
              (SELECT request_json FROM ai_calls y WHERE y.item_id = g.item_id AND y.stage = 'gate' AND y.error IS NULL ORDER BY y.id LIMIT 1) AS gateJson
         FROM ai_calls g WHERE g.stage = 'gate' AND g.verdict = 'true' AND g.item_id IS NOT NULL GROUP BY g.item_id ORDER BY seen`
    )
    .all() as Array<{ itemId: string; seen: string; richJson: string | null; gateJson: string | null }>;
  const items: ReplayItem[] = [];
  for (const r of itemRows) {
    const text = (r.richJson !== null ? extractArticleText(r.richJson) : null) ?? (r.gateJson !== null ? extractArticleText(r.gateJson) : null);
    if (text !== null) items.push({ itemId: r.itemId, seenAtSec: epoch(r.seen), text });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const positions: Array<ReplayPosition & { skipped?: string }> = [];
  const skipped: string[] = [];
  for (const r of posRows) {
    const ladder = parseLadderJson(r.ladderJson);
    if (ladder === null) { skipped.push(`position ${r.id} (${r.marketTicker}): saved ladder missing or malformed`); continue; }
    if (r.structure !== 'band' && r.structure !== 'threshold' && r.structure !== 'binary') { skipped.push(`position ${r.id}: structure ${r.structure} is not exit-reviewable`); continue; }
    positions.push({
      id: r.id, side: r.side, structure: r.structure, marketTicker: r.marketTicker, contracts: r.contracts, entryPriceCents: r.entry,
      createdAtSec: epoch(r.createdAt), endSec: r.settledAt === null ? null : epoch(r.settledAt), actualPnlCents: r.pnl, ladder,
    });
  }

  const plannedCalls = positions.reduce((n, p) => n + Math.min(args.maxItems, items.filter((i) => i.seenAtSec > p.createdAtSec && (p.endSec === null || i.seenAtSec < p.endSec)).length), 0);
  console.log(`[backtest-exit] trade=${args.trade} series=${series} positions=${positions.length} (skipped ${skipped.length}) gated items=${items.length} planned model calls<=${plannedCalls}`);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  if (!args.run) {
    console.log('[backtest-exit] DRY RUN: nothing fetched, nothing spent. Re-run with --run to replay (about $0.01 per Sonnet call).');
    src.close();
    return;
  }

  // candles for every market of every event, once each
  const candles: CandleMap = new Map();
  const nowEnd = nowSec;
  for (const p of positions) {
    const start = p.createdAtSec - 65 * 60;
    const end = p.endSec ?? nowEnd;
    for (const band of p.ladder) {
      const have = candles.get(band.ticker);
      if (have !== undefined && have.length > 0) continue;
      candles.set(band.ticker, await candlesForRange(series, band.ticker, start, end));
    }
  }
  for (const p of positions) {
    if (p.actualPnlCents === null) { // still open: use the last candle's held-side mark
      const cs = candles.get(p.marketTicker) ?? [];
      const last = cs[cs.length - 1];
      const mark = last === undefined ? null : p.side === 'yes' ? last.yesBidCents : last.yesAskCents === null ? null : 100 - last.yesAskCents;
      p.actualPnlCents = mark === null ? null : p.contracts * (mark - p.entryPriceCents);
    }
  }

  const client = new Anthropic();
  const scratch = openLedger(':memory:');
  const review: ReviewFn = async ({ item, position, market, trajectory }) =>
    reviewForExit(client, scratch, {
      loaded, itemId: item.itemId, articleText: item.text, excerptSource: 'snippet', tripwireHit: false, sourceTrustTier: 3,
      publishedAt: new Date(item.seenAtSec * 1000).toISOString(),
      position: { marketTicker: position.marketTicker, side: position.side, contracts: position.contracts, remaining: position.contracts, entryPriceCents: position.entryPriceCents },
      market, trajectory, model: args.model,
    });

  const results: ReplayResult[] = [];
  for (const p of positions) {
    const r = await replayPosition(p, items, candles, review, { exitFeeCents: args.fee, maxItems: args.maxItems });
    results.push(r);
    console.log(`  position ${p.id} ${p.side.toUpperCase()} ${p.marketTicker} x${p.contracts}@${p.entryPriceCents}: reviewed ${r.reviewed}, ` +
      (r.sold ? `SELL at ${new Date(r.sold.atSec * 1000).toISOString()} @${r.sold.priceCents}c (hyp ${r.sold.hypPnlCents}c vs actual ${r.actualPnlCents}c)` : `no sell (actual ${r.actualPnlCents}c)`));
  }
  const summary = summarizeReplay(results);
  console.log('[backtest-exit] summary', JSON.stringify(summary));

  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `${args.trade}-${new Date().toISOString().slice(0, 10)}.md`);
  const lines: string[] = [
    `# Exit-review backtest: ${args.trade}`, '',
    `Run ${new Date().toISOString()}; model ${args.model ?? 'claude-sonnet-5 (default)'}; fee ${args.fee}c; max ${args.maxItems} items per position.`,
    `Gated items with text: ${items.length}. Positions replayed: ${positions.length}. Skipped: ${skipped.length}.`, '',
    '## Summary', '```', JSON.stringify(summary, null, 2), '```', '',
    'Positive delta = selling at the trigger would have beaten holding. Profiles for dated weekly markets may be stale; fills assume the touch absorbs the order (candles carry no depth).', '',
    '## Positions',
  ];
  for (const r of results) {
    lines.push(`### position ${r.positionId} ${r.side.toUpperCase()} ${r.marketTicker} x${r.contracts} @${r.entryPriceCents}c`);
    lines.push(`reviewed ${r.reviewed}; actual ${r.actualPnlCents}c; ` + (r.sold ? `SOLD ${new Date(r.sold.atSec * 1000).toISOString()} @${r.sold.priceCents}c = ${r.sold.hypPnlCents}c (delta ${r.deltaCents}c)` : 'never sold'));
    for (const row of r.rows.filter((x) => x.verdict !== 'skip').slice(0, 40)) {
      lines.push(`- ${new Date(row.atSec * 1000).toISOString()} ${row.verdict.toUpperCase()} shift=${row.shift} conf=${row.confidence} loss=${row.lossCents?.toFixed(2)}c :: ${row.reason}`);
    }
    lines.push('');
  }
  fs.writeFileSync(file, lines.join('\n'));
  console.log(`[backtest-exit] wrote ${file}`);
  scratch.close();
  src.close();
}

main().catch((err) => {
  console.error('[backtest-exit] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, in `scripts`, after the line `"score-paper": "tsx scripts/score-paper.ts",` add `"backtest-exit": "tsx scripts/backtest-exit.ts",`.

- [ ] **Step 3: Typecheck, then dry-run against the real ledger**

Run (the worktree has no `data/` directory, so point `--data` at the main checkout's ledgers; they are only read):
```bash
npx tsc --noEmit
ls -l --time-style=full-iso ~/executor_module/data/kxwti/decisions.db      # note the modified time
npm run backtest-exit -- --trade kxwti --data ~/executor_module/data
ls -l --time-style=full-iso ~/executor_module/data/kxwti/decisions.db      # unchanged by a dry run (a running unit may touch it; the -wal file moves, the dry run writes nothing)
git status --short | head -3                                               # must be clean
```
Expected: a line `[backtest-exit] trade=kxwti series=KXWTI positions=<n> (skipped <k>) gated items=<m> planned model calls<=<c>` and `DRY RUN: nothing fetched, nothing spent`. Confirm `<n>` plus the skipped count equals the number of `paper_positions` rows with a side in the kxwti ledger (`python3 -c "import sqlite3;print(sqlite3.connect('file:/home/emac/executor_module/data/kxwti/decisions.db?mode=ro',uri=True).execute('select count(*) from paper_positions where side is not null').fetchone())"`) and that no output file was written under `~/exit-backtest`.

- [ ] **Step 4: One real run on the three trades (costs a few dollars; ask the user first)**

This calls the Anthropic API. **Before running, tell the user the planned-call counts from the dry runs and the approximate cost (about $0.01 per Sonnet call) and wait for a yes.** On approval:

```bash
set -a; . ~/executor_module/.env; set +a      # supplies ANTHROPIC_API_KEY; never print it
for t in kxwti kxaaagasw kxtrumpact; do npm run backtest-exit -- --trade $t --data ~/executor_module/data --run --max-items 40; done
```
Expected: for each trade a per-position line, a `summary` JSON, and `~/exit-backtest/<trade>-<date>.md`. Read the three reports. They are the evidence for tuning the prompt, model and fee **before** anything is enabled (spec section 8, step 5): note in particular how many sells have a negative `deltaCents` (regret) and how many of the WTI/TRUMP ACT positions would have been exited, and when.

- [ ] **Step 5: Commit**

```bash
git add scripts/backtest-exit.ts package.json
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(scripts): backtest-exit replays logged news against past paper positions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Operator notes and the rollout

This task is documentation plus a runbook. **It contains steps that need the user's approval; do not run Steps 3 to 7 without it.**

**Files:**
- Modify: `HANDOFF.md` (new section "Exit review (paper)")

- [ ] **Step 1: Add the operator section to `HANDOFF.md`**

Append a section titled `## Exit review (paper): operator notes` containing exactly these facts (reword for the file's style):
- What it is: the paper-only exit review described in `docs/superpowers/specs/2026-10-12-exit-review-design.md`; default **off**.
- Enable per paper unit by copying `deploy/mini-mac/executor-module@.service.d/exit-review.conf.example` to `~/.config/systemd/user/executor-module@<name>.service.d/exit-review.conf`, then `systemctl --user daemon-reload && systemctl --user restart executor-module@<name>`. Roll back by deleting that file, `daemon-reload`, restart.
- The process refuses to start with `EXIT_REVIEW=on` on the live unit, a non-dry-run process or the live ledger; the startup `[profile]` line ends with `exitReview=on|off`.
- Tables in each trade's `decisions.db`: `paper_exit_reviews` (every review), `paper_exits` (fills and markers), `ai_calls.stage='exit_review'`. A fully sold position is closed with `settled_at` set, `result` NULL and `pnl_cents` = sum of its exit P&L.
- Settings: `EXIT_REVIEW_MODEL`, `EXIT_FEE_CENTS`, `EXIT_RETRY_MS` (20000), `EXIT_DAILY_USD_CAP` (alert only).
- Logs to grep: `[EXIT TRIGGER]`, `[EXIT FILL]`, `[EXIT UNSELLABLE]`, `[EXIT HELD_TO_SETTLEMENT]`, `[EXIT LATE]`, `[EXIT LAG]`, `[EXIT-REVIEW ERROR]`, `[EXIT-REVIEW BUDGET]`.
- Backtest: `npm run backtest-exit -- --trade <name> [--run]`; dry run by default.
- The wall publisher (`~/wall/paper-grid-publish.py`, not in git) counts exits; its backups are `*.bak-pre-exits-*`.

- [ ] **Step 2: Commit the docs**

```bash
git add HANDOFF.md
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "docs(handoff): exit review operator notes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Whole-branch verification (before asking to merge)**

Run:
```bash
npx tsc --noEmit
npx vitest run 2>&1 | tail -15
git log --oneline main..feat/exit-review
```
Expected: typecheck clean; failed count equals the baseline you recorded (no new failures); the log shows the Plan A, B and C commits only.

- [ ] **Step 4: Ask the user to approve the merge (STOP here until they answer)**

Report the Step 3 results and the backtest reports from Task 3, and ask explicitly: "Merge `feat/exit-review` into `~/executor_module` main?" The services run from the main checkout (`WorkingDirectory=%h/executor_module`), so nothing below can take effect until this merge, and every earlier merge needed an explicit yes. Note for the user that `main` currently carries uncommitted `trades/` changes from other work; the merge does not touch those paths.

- [ ] **Step 5: On approval, merge**

```bash
cd ~/executor_module
git status --short | head        # other sessions' uncommitted trades/ files may be listed; leave them alone
git merge --no-ff feat/exit-review -m "Merge feat/exit-review: paper exit review" 
git log --oneline -3
```
(Commit identity: pass `-c user.name=... -c user.email=...` exactly as in the commit snippet above.) If the merge reports conflicts or "local changes would be overwritten", stop and report; never stash, reset or discard other sessions' work.

- [ ] **Step 6: Enable on three units (still paper, per-unit, reversible)**

```bash
for t in kxwti kxtrumpact kxaaagasw; do
  d=~/.config/systemd/user/executor-module@$t.service.d
  mkdir -p $d
  cp ~/executor_module/deploy/mini-mac/executor-module@.service.d/exit-review.conf.example $d/exit-review.conf
done
systemctl --user daemon-reload
systemctl --user restart executor-module@kxwti executor-module@kxtrumpact executor-module@kxaaagasw
sleep 30
for t in kxwti kxtrumpact kxaaagasw; do
  systemctl --user is-active executor-module@$t
  journalctl --user -u executor-module@$t --since "-60s" --no-pager | grep -E "\[profile\]" | grep -o "exitReview=[a-z]*"
done
```
Expected: each unit `active` and `exitReview=on`. If a unit is not active, read its journal, delete its `exit-review.conf`, `daemon-reload`, restart (that is the full rollback), and report.

- [ ] **Step 7: Verify it is alive, then report**

After a few hours of live items, query each trade's ledger (read-only):

```bash
python3 - <<'EOF'
import sqlite3
for t in ("kxwti","kxtrumpact","kxaaagasw"):
    c=sqlite3.connect(f"file:/home/emac/executor_module/data/{t}/decisions.db?mode=ro", uri=True)
    print("==",t)
    print(" reviews by verdict:", c.execute("select verdict,count(*) from paper_exit_reviews group by 1").fetchall())
    for r in c.execute("select created_at,item_id,position_id,verdict,round(loss_cents,1),round(exit_cost_cents,1),substr(verdict_reason,1,90) from paper_exit_reviews order by id desc limit 8"): print("  ",r)
    print(" exits:", c.execute("select status,count(*),sum(contracts),sum(pnl_cents) from paper_exits group by 1").fetchall())
    print(" late:", c.execute("select late,count(*) from paper_exits where status in ('filled','partial') group by 1").fetchall())
EOF
```
Also confirm the wall tile still renders and that exited positions show as `exited` in the cell detail. Report to the user: reviews per trade, any sells with their times, prices and lateness, any `error` verdicts, and the spend estimate. **Widening to all 40 paper units is a separate decision for the user after they have read this report.**

---

## Plan C self-review

- **Spec coverage:** section 5 (lag chain, candle marks, late flag, cents lost, `[EXIT LATE]`, never on the sell path, null fields when history is unavailable) is Task 1; section 8 step 5 (backtest) is Tasks 2 and 3; section 8 step 6 (enable on kxwti, kxtrumpact, kxaaagasw first, widen after review) and the reversible, paper-only rollout are Task 4; section 9's open items are resolved (candlesticks in Plan B Task 1; fee stays configurable with default 0; sequential review of several positions, noted in Plan B).
- **Placeholders:** none; Task 3 Step 4 and Task 4 Steps 4 to 7 are explicit approval-gated manual steps with exact commands, not unfilled content.
- **Type consistency:** `Candle`, `TrajectoryPoint`, `markAtOrBefore`, `fetchCandles` come from Plan B Task 1 and are used with the same signatures; `EXIT_LOSS_FRACTION` from Plan B Task 2; `lag_json` keys written by Plan B Task 6 (`sourcePublishTs`, `eventTime`, `firstSeenTs`, `emittedTs`, `reviewStartedAt`, `modelReturnedAt`, `firstSellAttemptAt`, `fillAt`, `outcome`) are exactly the ones `computeLateness` reads; `ExitTimerDeps.afterPass` extends the Plan B interface without changing existing fields.
