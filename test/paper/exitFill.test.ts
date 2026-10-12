// test/paper/exitFill.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { listOpenPaperPositions, recordExitReview, remainingContracts } from '../../src/paper/exits.js';
import { attemptExitFill } from '../../src/paper/exitFill.js';
import { thr } from './exitFixtures.js';

describe('attemptExitFill', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exitfill-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (side: 'yes' | 'no', contracts = 4, entry = 50) => {
    const id = recordPaperPosition(db, {
      trade: 't', itemId: `p-${side}-${contracts}`, structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-94', side,
      contracts, entryPriceCents: entry, direction: 'down', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
    const review = recordExitReview(db, {
      trade: 't', itemId: 'news-1', positionId: id, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30,
      lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null,
    });
    return { position: listOpenPaperPositions(db).find((p) => p.id === id)!, reviewId: review };
  };
  const exits = () => db.prepare(`SELECT status, contracts, price_cents, pnl_cents FROM paper_exits ORDER BY id`).all();

  it('YES sells everything at the yes bid when the bid is deep enough', () => {
    const { position, reviewId } = open('yes');
    const a = attemptExitFill(db, { position, reviewId, market: thr(94, 50, 1), filledAt: '2026-10-12T01:00:00.000Z' });
    expect(a).toMatchObject({ outcome: 'filled', contracts: 4, priceCents: 49, remaining: 0, filledAt: '2026-10-12T01:00:00.000Z' });
    expect(a.exitId).toBeGreaterThan(0);
    expect(exits()).toEqual([{ status: 'filled', contracts: 4, price_cents: 49, pnl_cents: -4 }]);
  });

  it('NO sells at 100 - yes ask, capped at the yes ask size; the rest stays pending', () => {
    const { position, reviewId } = open('no', 4, 52);
    const market = thr(94, 50, 1, { yesAskSizeContracts: 2 });
    const a = attemptExitFill(db, { position, reviewId, market });
    expect(a).toMatchObject({ outcome: 'partial', contracts: 2, priceCents: 49, remaining: 2 });
    expect(remainingContracts(db, position.id)).toBe(2);
    expect(exits()).toEqual([{ status: 'partial', contracts: 2, price_cents: 49, pnl_cents: -6 }]);
    // a later pass with depth finishes the sale
    const b = attemptExitFill(db, { position: { ...position, remaining: 2 }, reviewId, market: thr(94, 52, 1) }); // yes ask 53 -> NO bid 47
    expect(b).toMatchObject({ outcome: 'filled', contracts: 2, priceCents: 47, remaining: 0 });
  });

  it('no bid (or an empty bid) is unsellable, writes one marker, and sells nothing', () => {
    const { position, reviewId } = open('yes');
    const m = thr(94, 50, 1, { yesBidCents: null });
    const a1 = attemptExitFill(db, { position, reviewId, market: m });
    const a2 = attemptExitFill(db, { position, reviewId, market: m });
    expect(a1).toMatchObject({ outcome: 'unsellable', contracts: 0, priceCents: null, remaining: 4, exitId: null });
    expect(a2.outcome).toBe('unsellable');
    expect(exits()).toEqual([{ status: 'unsellable', contracts: 0, price_cents: null, pnl_cents: 0 }]);
    const empty = attemptExitFill(db, { position, reviewId, market: thr(94, 50, 1, { yesBidSizeContracts: 0 }) });
    expect(empty.outcome).toBe('unsellable');
    // NO side with no yes ask has no NO bid
    const no = open('no', 3, 40);
    expect(attemptExitFill(db, { position: no.position, reviewId: no.reviewId, market: thr(94, 50, 1, { yesAskCents: null }) }).outcome).toBe('unsellable');
  });

  it('a missing or non-active market is held to settlement (one marker)', () => {
    const { position, reviewId } = open('yes');
    expect(attemptExitFill(db, { position, reviewId, market: null }).outcome).toBe('held_to_settlement');
    expect(attemptExitFill(db, { position, reviewId, market: thr(94, 50, 1, { status: 'closed' }) }).outcome).toBe('held_to_settlement');
    expect(exits()).toEqual([{ status: 'held_to_settlement', contracts: 0, price_cents: null, pnl_cents: 0 }]);
  });

  it('a position with nothing left reports filled and writes nothing', () => {
    const { position, reviewId } = open('yes', 1);
    attemptExitFill(db, { position, reviewId, market: thr(94, 50, 1) });
    const again = attemptExitFill(db, { position, reviewId, market: thr(94, 50, 1) });
    expect(again).toMatchObject({ outcome: 'filled', contracts: 0, remaining: 0, exitId: null });
    expect(exits()).toHaveLength(1);
  });
});
