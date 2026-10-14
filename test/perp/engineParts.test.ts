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
