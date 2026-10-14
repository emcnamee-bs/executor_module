// test/paper/exitsUnifiedColumns.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { recordExitReview, type ExitReviewRecord } from '../../src/paper/exits.js';

const review = (over: Partial<ExitReviewRecord> = {}): ExitReviewRecord => ({
  trade: 't', itemId: 'n1', positionId: 1, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20,
  exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: '{}', ...over,
});

describe('paper_exit_reviews model_action / decision_mode', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exitcols-'));
    db = openLedger(path.join(dir, 'l.db'));
    recordPaperPosition(db, { trade: 't', itemId: 'p1', structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-94', side: 'yes', contracts: 4, entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]' });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const row = (id: string) => db.prepare(`SELECT model_action AS a, decision_mode AS m FROM paper_exit_reviews WHERE item_id = ?`).get(id) as any;

  it('stores NULL for both when they are not given (a classic review)', () => {
    recordExitReview(db, review());
    expect(row('n1')).toEqual({ a: null, m: null });
  });

  it('stores the model recommendation and the mode', () => {
    recordExitReview(db, review({ itemId: 'n2', modelAction: 'hold', decisionMode: 'unified', verdict: 'hold' }));
    expect(row('n2')).toEqual({ a: 'hold', m: 'unified' });
  });

  it('rejects an unknown action or mode at the database level', () => {
    expect(() => recordExitReview(db, review({ itemId: 'n3', modelAction: 'buy' as any }))).toThrow();
    expect(() => recordExitReview(db, review({ itemId: 'n4', decisionMode: 'both' as any }))).toThrow();
  });

  it('migrates a ledger created before the columns existed, keeping its reviews', () => {
    recordExitReview(db, review());
    db.exec(`ALTER TABLE paper_exit_reviews DROP COLUMN model_action`);
    db.exec(`ALTER TABLE paper_exit_reviews DROP COLUMN decision_mode`);
    db.close();
    db = openLedger(path.join(dir, 'l.db'));
    const cols = (db.prepare(`PRAGMA table_info(paper_exit_reviews)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['model_action', 'decision_mode']));
    expect(row('n1')).toEqual({ a: null, m: null });
    recordExitReview(db, review({ itemId: 'n5', modelAction: 'sell', decisionMode: 'unified' }));
    expect(row('n5')).toEqual({ a: 'sell', m: 'unified' });
  });
});
