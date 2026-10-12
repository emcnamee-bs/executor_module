// test/paper/exits.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition, type PaperPositionRecord } from '../../src/paper/paper.js';
import {
  listOpenPaperPositions,
  remainingContracts,
  recordExitReview,
  updateReviewLag,
  hasExitReview,
  positionHasSellReview,
  hasSellTrigger,
  recordExitFill,
  recordExitMarker,
  pendingExits,
  type ExitReviewRecord,
} from '../../src/paper/exits.js';

function pos(itemId: string, overrides: Partial<PaperPositionRecord> = {}): PaperPositionRecord {
  return {
    trade: 't', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: 'MKT-A', side: 'yes',
    contracts: 4, entryPriceCents: 40, direction: 'up', magnitude: 0.1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    ...overrides,
  };
}

function review(itemId: string, positionId: number, verdict: ExitReviewRecord['verdict'] = 'sell'): ExitReviewRecord {
  return {
    trade: 't', itemId, positionId, shift: -2, confidence: 0.8, reason: 'bearish', midCents: 50, fairAfterCents: 30,
    lossCents: 16, exitCostCents: 1, verdict, verdictReason: 'loss beats threshold', lagJson: null,
  };
}

describe('exit tables', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exits-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const posRow = (id: number) =>
    db.prepare(`SELECT settled_at, result, pnl_cents FROM paper_positions WHERE id = ?`).get(id) as {
      settled_at: string | null; result: string | null; pnl_cents: number | null;
    };

  it('creates both tables on an existing ledger (idempotent re-open)', () => {
    db.close();
    db = openLedger(path.join(dir, 'test.db'));
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain('paper_exit_reviews');
    expect(names).toContain('paper_exits');
  });

  it('lists only open positions with a side, and reports remaining contracts', () => {
    const open = recordPaperPosition(db, pos('i1'));
    recordPaperPosition(db, pos('capture', { marketTicker: null, side: null, contracts: 0, entryPriceCents: null }));
    const settled = recordPaperPosition(db, pos('i3'));
    db.prepare(`UPDATE paper_positions SET settled_at = '2026-10-12T00:00:00.000Z', result = 'no', pnl_cents = -160 WHERE id = ?`).run(settled);
    const rows = listOpenPaperPositions(db);
    expect(rows.map((r) => r.id)).toEqual([open]);
    expect(rows[0]).toMatchObject({ marketTicker: 'MKT-A', side: 'yes', contracts: 4, entryPriceCents: 40, remaining: 4 });
  });

  it('recordExitReview is unique per (item, position) and queryable', () => {
    const p = recordPaperPosition(db, pos('i1'));
    expect(hasExitReview(db, 'news-1', p)).toBe(false);
    const id = recordExitReview(db, review('news-1', p));
    expect(id).toBeGreaterThan(0);
    expect(hasExitReview(db, 'news-1', p)).toBe(true);
    expect(() => recordExitReview(db, review('news-1', p))).toThrow();
    expect(positionHasSellReview(db, p)).toBe(true);
    expect(hasSellTrigger(db, 'MKT-A')).toBe(true);
    expect(hasSellTrigger(db, 'MKT-OTHER')).toBe(false);
  });

  it('a hold or error review is not a sell trigger', () => {
    const p = recordPaperPosition(db, pos('i1'));
    recordExitReview(db, review('news-1', p, 'hold'));
    recordExitReview(db, review('news-2', p, 'error'));
    expect(positionHasSellReview(db, p)).toBe(false);
    expect(hasSellTrigger(db, 'MKT-A')).toBe(false);
  });

  it('updateReviewLag overwrites the lag json', () => {
    const p = recordPaperPosition(db, pos('i1'));
    const id = recordExitReview(db, review('news-1', p));
    updateReviewLag(db, id, '{"fillAt":"x"}');
    expect((db.prepare(`SELECT lag_json FROM paper_exit_reviews WHERE id = ?`).get(id) as { lag_json: string }).lag_json).toBe('{"fillAt":"x"}');
  });

  it('a partial fill books pnl, keeps the position open and shrinks remaining', () => {
    const p = recordPaperPosition(db, pos('i1')); // 4 yes @ 40
    const r = recordExitReview(db, review('news-1', p));
    const res = recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 55, filledAt: '2026-10-12T01:00:00.000Z' });
    expect(res).toMatchObject({ pnlCents: 15, remaining: 3, closed: false });
    expect(posRow(p).settled_at).toBeNull();
    expect(listOpenPaperPositions(db)[0].remaining).toBe(3);
    expect(remainingContracts(db, p)).toBe(3);
    expect(remainingContracts(db, 99999)).toBe(0);
  });

  it('the final fill closes the position: settled_at set, result null, pnl = sum of fills', () => {
    const p = recordPaperPosition(db, pos('i1')); // 4 yes @ 40
    const r = recordExitReview(db, review('news-1', p));
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 55, filledAt: '2026-10-12T01:00:00.000Z' });
    const res = recordExitFill(db, { positionId: p, reviewId: r, contracts: 3, priceCents: 30, filledAt: '2026-10-12T01:00:20.000Z' });
    expect(res).toMatchObject({ pnlCents: -30, remaining: 0, closed: true });
    expect(posRow(p)).toEqual({ settled_at: '2026-10-12T01:00:20.000Z', result: null, pnl_cents: 15 - 30 });
    expect(listOpenPaperPositions(db)).toEqual([]);
  });

  it('a NO position books pnl in NO cents (exit - entry)', () => {
    const p = recordPaperPosition(db, pos('i1', { side: 'no', contracts: 2, entryPriceCents: 29 }));
    const r = recordExitReview(db, review('news-1', p));
    const res = recordExitFill(db, { positionId: p, reviewId: r, contracts: 2, priceCents: 20 });
    expect(res.pnlCents).toBe(-18);
  });

  it('refuses to oversell, to sell a settled position, or to sell a capture row, and writes nothing', () => {
    const p = recordPaperPosition(db, pos('i1')); // 4
    const r = recordExitReview(db, review('news-1', p));
    expect(() => recordExitFill(db, { positionId: p, reviewId: r, contracts: 5, priceCents: 30 })).toThrow(/only 4 remaining/);
    expect(() => recordExitFill(db, { positionId: p, reviewId: r, contracts: 0, priceCents: 30 })).toThrow(/positive/);
    const cap = recordPaperPosition(db, pos('cap', { marketTicker: null, side: null, contracts: 0, entryPriceCents: null }));
    expect(() => recordExitFill(db, { positionId: cap, reviewId: r, contracts: 1, priceCents: 30 })).toThrow();
    db.prepare(`UPDATE paper_positions SET settled_at = '2026-10-12T00:00:00.000Z', result = 'no', pnl_cents = -160 WHERE id = ?`).run(p);
    expect(() => recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 30 })).toThrow(/already settled/);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_exits`).get() as { n: number }).n).toBe(0);
  });

  it('recordExitMarker is idempotent for the same latest status', () => {
    const p = recordPaperPosition(db, pos('i1'));
    const r = recordExitReview(db, review('news-1', p));
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(true);
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(false);
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_exits`).get() as { n: number }).n).toBe(1);
    // after a partial fill the next unsellable is a new state change
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 30 });
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(true);
  });

  it('pendingExits = open positions with a sell review and no held_to_settlement marker', () => {
    const a = recordPaperPosition(db, pos('a'));
    const b = recordPaperPosition(db, pos('b', { marketTicker: 'MKT-B' }));
    const c = recordPaperPosition(db, pos('c', { marketTicker: 'MKT-C' }));
    const ra = recordExitReview(db, review('n1', a, 'sell'));
    recordExitReview(db, review('n1', b, 'hold'));
    const rc = recordExitReview(db, review('n1', c, 'sell'));
    expect(pendingExits(db).map((x) => [x.position.id, x.reviewId])).toEqual([[a, ra], [c, rc]]);
    recordExitMarker(db, c, rc, 'held_to_settlement');
    expect(pendingExits(db).map((x) => x.position.id)).toEqual([a]);
    recordExitFill(db, { positionId: a, reviewId: ra, contracts: 4, priceCents: 30 });
    expect(pendingExits(db)).toEqual([]);
  });
});
