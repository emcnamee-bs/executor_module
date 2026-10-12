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
