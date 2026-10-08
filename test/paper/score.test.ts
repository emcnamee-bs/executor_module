// test/paper/score.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition, type PaperPositionRecord } from '../../src/paper/paper.js';
import { pnlCents, settlePaperRows } from '../../src/paper/score.js';

function rec(itemId: string, ticker: string | null, overrides: Partial<PaperPositionRecord> = {}): PaperPositionRecord {
  return {
    trade: 't',
    itemId,
    structure: 'threshold',
    eventTicker: 'EV',
    marketTicker: ticker,
    side: ticker === null ? null : 'yes',
    contracts: ticker === null ? 0 : 3,
    entryPriceCents: ticker === null ? null : 40,
    direction: 'up',
    magnitude: 0.1,
    edgeCents: 5,
    reasoning: 'r',
    ladderJson: '[]',
    ...overrides,
  };
}

describe('pnlCents (gross of fees)', () => {
  it.each([
    ['yes wins', 'yes', 3, 40, 'yes', 180],
    ['yes loses', 'yes', 3, 40, 'no', -120],
    ['no wins', 'no', 2, 62, 'no', 76],
    ['no loses', 'no', 2, 62, 'yes', -124],
  ] as const)('%s', (_name, side, contracts, entry, result, expected) => {
    expect(pnlCents(side, contracts, entry, result)).toBe(expected);
  });
});

describe('settlePaperRows', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'score-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const row = (itemId: string) =>
    db.prepare(`SELECT settled_at, result, pnl_cents FROM paper_positions WHERE item_id = ?`).get(itemId) as {
      settled_at: string | null;
      result: string | null;
      pnl_cents: number | null;
    };

  it('settles a finalized market and computes pnl from the position side and price', async () => {
    recordPaperPosition(db, rec('a', 'M-WIN'));
    recordPaperPosition(db, rec('b', 'M-LOSE'));
    const n = await settlePaperRows(db, async (ticker) => ({ status: 'finalized', result: ticker === 'M-WIN' ? 'yes' : 'no' }));
    expect(n).toBe(2);
    expect(row('a')).toMatchObject({ result: 'yes', pnl_cents: 180 });
    expect(row('a').settled_at).not.toBeNull();
    expect(row('b')).toMatchObject({ result: 'no', pnl_cents: -120 });
  });

  it('accepts status "settled" as well as "finalized"', async () => {
    recordPaperPosition(db, rec('a', 'M-1'));
    expect(await settlePaperRows(db, async () => ({ status: 'settled', result: 'yes' }))).toBe(1);
  });

  it('does not settle a market that is still open or has a non-yes/no result', async () => {
    recordPaperPosition(db, rec('open', 'M-OPEN'));
    recordPaperPosition(db, rec('blank', 'M-BLANK'));
    const n = await settlePaperRows(db, async (ticker) =>
      ticker === 'M-OPEN' ? { status: 'active', result: '' } : { status: 'finalized', result: '' }
    );
    expect(n).toBe(0);
    expect(row('open').settled_at).toBeNull();
    expect(row('blank').pnl_cents).toBeNull();
  });

  it('skips a row whose fetch throws without failing the others', async () => {
    recordPaperPosition(db, rec('boom', 'M-BOOM'));
    recordPaperPosition(db, rec('ok', 'M-OK'));
    const n = await settlePaperRows(db, async (ticker) => {
      if (ticker === 'M-BOOM') throw new Error('network down');
      return { status: 'finalized', result: 'yes' };
    });
    expect(n).toBe(1);
    expect(row('boom').settled_at).toBeNull();
    expect(row('ok').result).toBe('yes');
  });

  it('never settles capture rows (no side) and never re-settles a settled row', async () => {
    recordPaperPosition(db, rec('cap', null, { structure: 'capture' }));
    recordPaperPosition(db, rec('real', 'M-1'));
    let calls = 0;
    const fetchResult = async () => {
      calls += 1;
      return { status: 'finalized', result: 'yes' };
    };
    expect(await settlePaperRows(db, fetchResult)).toBe(1);
    expect(row('cap')).toEqual({ settled_at: null, result: null, pnl_cents: null });
    expect(await settlePaperRows(db, fetchResult)).toBe(0);
    expect(calls).toBe(1);
    expect(row('real').pnl_cents).toBe(180);
  });
});
