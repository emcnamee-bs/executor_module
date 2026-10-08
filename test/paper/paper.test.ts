// test/paper/paper.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition, hasPaperPosition, PAPER_CAPS, paperExposureCents, type PaperPositionRecord } from '../../src/paper/paper.js';

function rec(overrides: Partial<PaperPositionRecord> = {}): PaperPositionRecord {
  return {
    trade: 'kxaaagasw',
    itemId: 'item-1',
    structure: 'threshold',
    eventTicker: 'KXAAAGASW-26OCT12',
    marketTicker: 'KXAAAGASW-26OCT12-4.3800',
    side: 'yes',
    contracts: 1,
    entryPriceCents: 31,
    direction: 'up',
    magnitude: 0.04,
    edgeCents: 27,
    reasoning: 'barge restrictions delay fuel',
    ladderJson: JSON.stringify([{ ticker: 'KXAAAGASW-26OCT12-4.3800', yesBid: 29, yesAsk: 31 }]),
    ...overrides,
  };
}

describe('paper_positions', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'paper-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a threshold position and reports it via hasPaperPosition', () => {
    expect(hasPaperPosition(db, 'item-1')).toBe(false);
    const id = recordPaperPosition(db, rec());
    expect(id).toBeGreaterThan(0);
    expect(hasPaperPosition(db, 'item-1')).toBe(true);
    const row = db.prepare(`SELECT * FROM paper_positions WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      trade: 'kxaaagasw',
      item_id: 'item-1',
      structure: 'threshold',
      event_ticker: 'KXAAAGASW-26OCT12',
      market_ticker: 'KXAAAGASW-26OCT12-4.3800',
      side: 'yes',
      contracts: 1,
      entry_price_cents: 31,
      direction: 'up',
      magnitude: 0.04,
      edge_cents: 27,
      reasoning: 'barge restrictions delay fuel',
      settled_at: null,
      result: null,
      pnl_cents: null,
    });
  });

  it('allows a capture row: no market, no side, zero contracts, ladder snapshot only', () => {
    const id = recordPaperPosition(
      db,
      rec({ itemId: 'item-cap', structure: 'capture', marketTicker: null, side: null, contracts: 0, entryPriceCents: null, direction: null, magnitude: null, edgeCents: null })
    );
    const row = db.prepare(`SELECT side, market_ticker, contracts FROM paper_positions WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row).toEqual({ side: null, market_ticker: null, contracts: 0 });
  });

  it('rejects a side with zero contracts (CHECK constraint)', () => {
    expect(() => recordPaperPosition(db, rec({ itemId: 'bad-1', contracts: 0 }))).toThrow(/CHECK constraint failed/);
  });

  it('rejects a side with no market ticker or no entry price (CHECK constraint)', () => {
    expect(() => recordPaperPosition(db, rec({ itemId: 'bad-2', marketTicker: null }))).toThrow(/CHECK constraint failed/);
    expect(() => recordPaperPosition(db, rec({ itemId: 'bad-3', entryPriceCents: null }))).toThrow(/CHECK constraint failed/);
  });

  it('rejects an entry price outside (0,100)', () => {
    expect(() => recordPaperPosition(db, rec({ itemId: 'bad-4', entryPriceCents: 0 }))).toThrow(/CHECK constraint failed/);
    expect(() => recordPaperPosition(db, rec({ itemId: 'bad-5', entryPriceCents: 100 }))).toThrow(/CHECK constraint failed/);
  });

  it('enforces one paper position per item_id (UNIQUE)', () => {
    recordPaperPosition(db, rec({ itemId: 'dup' }));
    expect(() => recordPaperPosition(db, rec({ itemId: 'dup' }))).toThrow(/UNIQUE constraint failed/);
  });
});

describe('paper caps and exposure', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'paper-caps-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('has a $10 per-trade and $50 total research bankroll, distinct from the live caps', () => {
    expect(PAPER_CAPS).toEqual({ perTradeCents: 1000, totalExposureCents: 5000 });
  });

  it('sums contracts x entry price over this event only, ignoring capture rows', () => {
    const row = (itemId: string, event: string, side: 'yes' | 'no' | null, contracts: number, price: number | null) =>
      recordPaperPosition(db, {
        trade: 't', itemId, structure: side ? 'threshold' : 'capture', eventTicker: event, marketTicker: side ? `${event}-M` : null, side, contracts,
        entryPriceCents: price, direction: 'up', magnitude: 0.1, edgeCents: 5, reasoning: 'r', ladderJson: '{}',
      });
    row('a', 'EV-1', 'yes', 3, 31);
    row('b', 'EV-1', 'no', 2, 40);
    row('c', 'EV-2', 'yes', 9, 50);
    row('d', 'EV-1', null, 0, null);
    expect(paperExposureCents(db, 'EV-1')).toBe(3 * 31 + 2 * 40);
    expect(paperExposureCents(db, 'EV-2')).toBe(450);
    expect(paperExposureCents(db, 'EV-3')).toBe(0);
  });
});
