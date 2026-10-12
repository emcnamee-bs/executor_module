// test/paper/exitTimerAfterPass.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { recordExitReview } from '../../src/paper/exits.js';
import { startExitTimer } from '../../src/paper/exitTimer.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import { thresholdBands, thr } from './exitFixtures.js';

describe('startExitTimer afterPass', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'timer-after-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // A position with a sell trigger whose market has no bid: it stays pending, so every pass fetches the ladder again.
  const pendingNoBid = () => {
    const id = recordPaperPosition(db, {
      trade: 'kxwti', itemId: 'p1', structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-94', side: 'yes', contracts: 4,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
    recordExitReview(db, { trade: 'kxwti', itemId: 'n-p1', positionId: id, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null });
    const noBid = thresholdBands(1);
    noBid[2] = thr(94, 50, 1, { yesBidCents: null });
    return vi.fn(async (event: string): Promise<ActiveLadder> => ({ eventTicker: event, strikeDate: null, bands: noBid }));
  };

  it('runs afterPass after every tick, survives its failures, and stops with the timer', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const afterPass = vi.fn(async () => { calls += 1; if (calls === 1) throw new Error('sweep failed'); });
    const t = startExitTimer({ db, fetchLadderForEvent: async () => { throw new Error('unused'); }, afterPass }, 1000);
    await vi.advanceTimersByTimeAsync(3500);
    expect(afterPass).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalledWith('[exit-timer] afterPass failed:', expect.any(Error));
    t.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(afterPass).toHaveBeenCalledTimes(3);
  });

  it('a synchronous throw from afterPass is caught and logged, and the next tick still runs it', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const afterPass = vi.fn(() => { throw new Error('sync boom'); });
    const t = startExitTimer({ db, fetchLadderForEvent: async () => { throw new Error('unused'); }, afterPass }, 1000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(afterPass).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledWith('[exit-timer] afterPass failed:', expect.any(Error));
    t.stop();
  });

  it('an afterPass that never finishes does not hold up the pending-exit pass, and is itself never overlapped', async () => {
    vi.useFakeTimers();
    const f = pendingNoBid();
    const afterPass = vi.fn(() => new Promise<void>(() => {})); // the sweep is stuck on a slow candlestick API
    const t = startExitTimer({ db, fetchLadderForEvent: f, afterPass }, 1000);
    await vi.advanceTimersByTimeAsync(5500);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(5); // a sale-retry pass on every interval
    expect(afterPass).toHaveBeenCalledTimes(1); // its own overlap guard
    t.stop();
  });

  it('a stuck pending-exit pass does not stop afterPass from running', async () => {
    vi.useFakeTimers();
    pendingNoBid();
    const f = vi.fn(() => new Promise<ActiveLadder>(() => {})); // the ladder fetch hangs
    const afterPass = vi.fn(async () => {});
    const t = startExitTimer({ db, fetchLadderForEvent: f, afterPass }, 1000);
    await vi.advanceTimersByTimeAsync(3500);
    expect(f).toHaveBeenCalledTimes(1); // the pass guard holds, the pass never overlaps itself
    expect(afterPass).toHaveBeenCalledTimes(3);
    t.stop();
  });

  it('stop() stops both the passes and afterPass', async () => {
    vi.useFakeTimers();
    const f = pendingNoBid();
    const afterPass = vi.fn(async () => {});
    const t = startExitTimer({ db, fetchLadderForEvent: f, afterPass }, 1000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(2); // running: not a vacuous stop check
    expect(afterPass.mock.calls.length).toBeGreaterThanOrEqual(2);
    t.stop();
    const fAtStop = f.mock.calls.length;
    const afterAtStop = afterPass.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.mock.calls.length).toBe(fAtStop);
    expect(afterPass.mock.calls.length).toBe(afterAtStop);
  });
});
