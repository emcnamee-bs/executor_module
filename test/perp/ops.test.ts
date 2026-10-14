import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/perp/ops/args.js';
import { fundPaperInDb } from '../../src/perp/ops/paperFund.js';
import { getState, listJournal, openPerpDb, setState } from '../../src/perp/store/db.js';
import type { PaperState } from '../../src/perp/broker/paper.js';

describe('fundPaperInDb (W1)', () => {
  const withState = (s: PaperState) => {
    const db = openPerpDb(':memory:');
    setState(db, 'paper', s);
    return db;
  };
  const pos = { side: 'long' as const, contracts: 1, entryPrice: 13.76, extreme: 13.8, stopBps: 388, entryFeeUsd: 0.001 };

  it('adds the amount to the saved cash, keeps the position, and journals paper_funded', () => {
    const db = withState({ cash: 2.9, pos });
    expect(fundPaperInDb(db, 1.5, 1234)).toEqual({ cashBefore: 2.9, cashAfter: 4.4 });
    expect(getState<PaperState>(db, 'paper')).toEqual({ cash: 4.4, pos });
    expect(listJournal(db, 'paper_funded', 5)).toEqual([{ tsMs: 1234, payload: { usd: 1.5, cashBefore: 2.9, cashAfter: 4.4 } }]);
  });

  it.each([0, -1, NaN, Infinity, 1000.01])('rejects usd=%s and changes nothing', (usd) => {
    const db = withState({ cash: 2.9, pos: null });
    expect(() => fundPaperInDb(db, usd, 1)).toThrow(/usd must be/);
    expect(getState<PaperState>(db, 'paper')?.cash).toBe(2.9);
    expect(listJournal(db, 'paper_funded', 5)).toHaveLength(0);
  });

  it('accepts exactly 1000', () => {
    expect(fundPaperInDb(withState({ cash: 0, pos: null }), 1000, 1).cashAfter).toBe(1000);
  });

  it('refuses when there is no saved paper state yet', () => {
    const db = openPerpDb(':memory:');
    expect(() => fundPaperInDb(db, 1, 1)).toThrow('no paper state yet: start the bot once first');
    expect(getState(db, 'paper')).toBeNull();
    expect(listJournal(db, 'paper_funded', 5)).toHaveLength(0);
  });
});

describe('parseArgs (operator scripts, W1/W12)', () => {
  const spec = { values: ['db', 'days'], booleans: ['force'] };
  it('parses value and boolean flags', () => {
    const r = parseArgs(['--db', 'x.db', '--force', '--days', '7'], spec);
    expect(r).toEqual({ ok: true, values: { db: 'x.db', days: '7' }, flags: new Set(['force']) });
  });
  it.each([
    [['--db', '--force'], /--db needs a value/],
    [['--db'], /--db needs a value/],
    [['--db', ''], /--db needs a value/],
    [['--days'], /--days needs a value/],
    [['--db', 'a', '--db', 'b'], /more than once/],
    [['--nope'], /unknown option --nope/],
    [['x.db'], /unexpected argument/],
  ])('rejects %j', (argv, msg) => {
    const r = parseArgs(argv, spec);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toMatch(msg);
  });
});
