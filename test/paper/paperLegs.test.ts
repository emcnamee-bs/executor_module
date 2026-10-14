// test/paper/paperLegs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import {
  recordPaperPosition, recordPaperLegs, hasPaperPosition, paperExposureCents, secondLegItemId, type PaperPositionRecord,
} from '../../src/paper/paper.js';

const leg = (market: string, over: Partial<PaperPositionRecord> = {}): PaperPositionRecord => ({
  trade: 'kxfeddecision', itemId: 'ignored', structure: 'multi', eventTicker: 'EV', marketTicker: market, side: 'yes', contracts: 5,
  entryPriceCents: 40, direction: 'up', magnitude: 6, edgeCents: 4, reasoning: 'r', ladderJson: '[]', ...over,
});

describe('paper legs', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'legs-')); db = openLedger(path.join(dir, 'l.db')); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const rows = () => db.prepare(`SELECT item_id, source_item_id, leg, market_ticker FROM paper_positions ORDER BY id`).all() as any[];

  it('names the second leg item#2', () => {
    expect(secondLegItemId('news-1')).toBe('news-1#2');
  });

  it('writes two legs with the pairing columns, in one call', () => {
    const ids = recordPaperLegs(db, 'news-1', [leg('A'), leg('B', { side: 'no' })]);
    expect(ids).toHaveLength(2);
    expect(rows()).toEqual([
      { item_id: 'news-1', source_item_id: 'news-1', leg: 1, market_ticker: 'A' },
      { item_id: 'news-1#2', source_item_id: 'news-1', leg: 2, market_ticker: 'B' },
    ]);
  });

  it('writes one leg as leg 1', () => {
    recordPaperLegs(db, 'news-1', [leg('A')]);
    expect(rows()).toEqual([{ item_id: 'news-1', source_item_id: 'news-1', leg: 1, market_ticker: 'A' }]);
  });

  it('is idempotent: a redelivered item adds nothing, whether it opened one leg or two', () => {
    recordPaperLegs(db, 'news-1', [leg('A'), leg('B')]);
    expect(recordPaperLegs(db, 'news-1', [leg('A'), leg('B')])).toEqual([]);
    recordPaperLegs(db, 'news-2', [leg('C')]);
    expect(recordPaperLegs(db, 'news-2', [leg('C')])).toEqual([]);
    expect(rows()).toHaveLength(3);
    expect(hasPaperPosition(db, 'news-1')).toBe(true);
    expect(hasPaperPosition(db, 'news-3')).toBe(false);
  });

  it('treats item#2 alone as the same delivery', () => {
    recordPaperPosition(db, { ...leg('A'), itemId: 'news-9#2' });
    expect(hasPaperPosition(db, 'news-9')).toBe(true);
  });

  it('refuses 0 legs, 3 legs, and two legs on one market, writing nothing', () => {
    expect(() => recordPaperLegs(db, 'n', [])).toThrow(/one or two/);
    expect(() => recordPaperLegs(db, 'n', [leg('A'), leg('B'), leg('C')])).toThrow(/one or two/);
    expect(() => recordPaperLegs(db, 'n', [leg('A'), leg('A')])).toThrow(/different markets/);
    expect(rows()).toHaveLength(0);
  });

  it('rolls both legs back when the second insert fails', () => {
    expect(() => recordPaperLegs(db, 'n', [leg('A'), leg('B', { contracts: 0 })])).toThrow();
    expect(rows()).toHaveLength(0);
  });

  it('counts both legs in the event exposure', () => {
    recordPaperLegs(db, 'news-1', [leg('A', { contracts: 5, entryPriceCents: 40 }), leg('B', { contracts: 2, entryPriceCents: 30 })]);
    expect(paperExposureCents(db, 'EV')).toBe(5 * 40 + 2 * 30);
  });

  it('keeps old rows NULL in the new columns', () => {
    recordPaperPosition(db, { ...leg('A'), itemId: 'old-1', structure: 'binary' });
    expect(rows()).toEqual([{ item_id: 'old-1', source_item_id: null, leg: null, market_ticker: 'A' }]);
  });

  it('migrates a ledger created before the columns existed, keeping its rows', () => {
    recordPaperPosition(db, { ...leg('A'), itemId: 'old-1', structure: 'binary' });
    db.exec(`DROP INDEX IF EXISTS idx_paper_positions_source`);
    db.exec(`ALTER TABLE paper_positions DROP COLUMN source_item_id`);
    db.exec(`ALTER TABLE paper_positions DROP COLUMN leg`);
    db.close();
    db = openLedger(path.join(dir, 'l.db'));
    const cols = (db.prepare(`PRAGMA table_info(paper_positions)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['source_item_id', 'leg']));
    expect(rows()).toEqual([{ item_id: 'old-1', source_item_id: null, leg: null, market_ticker: 'A' }]);
    recordPaperLegs(db, 'new-1', [leg('B'), leg('C')]);
    expect(rows()).toHaveLength(3);
  });

  it('rejects a leg number other than 1 or 2 at the database level', () => {
    expect(() => db.prepare(`UPDATE paper_positions SET leg = 3`).run()).not.toThrow(); // no rows yet: nothing to violate
    recordPaperLegs(db, 'n', [leg('A')]);
    expect(() => db.prepare(`UPDATE paper_positions SET leg = 3`).run()).toThrow();
  });
});
