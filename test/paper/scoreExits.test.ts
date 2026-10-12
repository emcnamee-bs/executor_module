// test/paper/scoreExits.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { settlePaperRows } from '../../src/paper/score.js';
import { recordExitReview, recordExitFill } from '../../src/paper/exits.js';

describe('settlePaperRows with exits', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'score-exits-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const newPosition = (itemId: string, side: 'yes' | 'no' = 'yes') =>
    recordPaperPosition(db, {
      trade: 't', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: `M-${itemId}`, side,
      contracts: 4, entryPriceCents: 40, direction: 'up', magnitude: 0.1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
  const sellReview = (itemId: string, positionId: number) =>
    recordExitReview(db, {
      trade: 't', itemId: `news-${itemId}`, positionId, shift: -1, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30,
      lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null,
    });
  const row = (id: number) =>
    db.prepare(`SELECT settled_at, result, pnl_cents FROM paper_positions WHERE id = ?`).get(id) as {
      settled_at: string | null; result: string | null; pnl_cents: number | null;
    };
  const finalized = (result: 'yes' | 'no') => async () => ({ status: 'finalized', result });

  it('settles only the remaining contracts and adds the exit pnl (no double count)', async () => {
    const p = newPosition('a'); // 4 yes @ 40
    const r = sellReview('a', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 55 }); // +15
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 50 }); // +10, 2 remain
    const n = await settlePaperRows(db, finalized('no')); // remaining 2 lose 40 each = -80
    expect(n).toBe(1);
    expect(row(p)).toMatchObject({ result: 'no', pnl_cents: 15 + 10 - 80 });
  });

  it('a winning remainder still adds to the exit pnl', async () => {
    const p = newPosition('b'); // 4 yes @ 40
    const r = sellReview('b', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 3, priceCents: 20 }); // -60, 1 remains
    await settlePaperRows(db, finalized('yes')); // +60 on the last contract
    expect(row(p).pnl_cents).toBe(-60 + 60);
  });

  it('a NO position settles its remainder on the NO side', async () => {
    const p = newPosition('c', 'no'); // 4 no @ 40
    const r = sellReview('c', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 2, priceCents: 30 }); // -20
    await settlePaperRows(db, finalized('no')); // 2 remaining win 60 each = +120
    expect(row(p).pnl_cents).toBe(-20 + 120);
  });

  it('a fully exited position is never touched (already closed, result stays null)', async () => {
    const p = newPosition('d');
    const r = sellReview('d', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 4, priceCents: 30, filledAt: '2026-10-12T01:00:00.000Z' }); // -40
    let fetched = 0;
    const n = await settlePaperRows(db, async () => { fetched += 1; return { status: 'finalized', result: 'no' }; });
    expect(n).toBe(0);
    expect(fetched).toBe(0);
    expect(row(p)).toEqual({ settled_at: '2026-10-12T01:00:00.000Z', result: null, pnl_cents: -40 });
  });

  it('a position with no exits settles exactly as before', async () => {
    const p = newPosition('e');
    await settlePaperRows(db, finalized('no'));
    expect(row(p).pnl_cents).toBe(-160);
  });
});
