// test/paper/exitTimerIsolation.test.ts
//
// One position's failure inside a pending-exit pass must not abort the positions after it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { recordExitReview, listOpenPaperPositions } from '../../src/paper/exits.js';
import { runPendingExits } from '../../src/paper/exitTimer.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import { thresholdBands } from './exitFixtures.js';

describe('pending exits: per-position isolation', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exittimer-iso-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const triggered = (itemId: string, marketTicker: string) => {
    const id = recordPaperPosition(db, {
      trade: 'kxwti', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker, side: 'yes', contracts: 4,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
    recordExitReview(db, { trade: 'kxwti', itemId: `n-${itemId}`, positionId: id, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null });
    return id;
  };
  const ladder = async (event: string): Promise<ActiveLadder> => ({ eventTicker: event, strikeDate: null, bands: thresholdBands(1) });

  it('a throw while handling one position is logged and the next position is still filled', async () => {
    const first = triggered('p1', 'T-94');
    const second = triggered('p2', 'T-92');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const seen: number[] = [];
    const onFill = (info: { positionId: number }) => {
      seen.push(info.positionId);
      if (info.positionId === first) throw new Error('boom');
    };

    const fills = await runPendingExits({ db, fetchLadderForEvent: ladder, onFill });

    expect(seen).toEqual([first, second]); // the second position was still reached after the first threw
    expect(fills).toBe(2); // both fills happened (the count is taken before onFill runs)
    expect(listOpenPaperPositions(db).map((p) => p.id)).toEqual([]); // both fills were recorded
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain(`[exit-timer] position ${first} (T-94) failed:`);
  });
});
