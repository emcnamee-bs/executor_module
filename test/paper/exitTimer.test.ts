// test/paper/exitTimer.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { recordExitReview, listOpenPaperPositions } from '../../src/paper/exits.js';
import { runPendingExits, startExitTimer } from '../../src/paper/exitTimer.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import { thresholdBands, thr } from './exitFixtures.js';

describe('pending exits', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exittimer-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const triggered = (itemId: string, over: Record<string, unknown> = {}) => {
    const id = recordPaperPosition(db, {
      trade: 'kxwti', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-94', side: 'yes', contracts: 4,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]', ...over,
    });
    recordExitReview(db, { trade: 'kxwti', itemId: `n-${itemId}`, positionId: id, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null });
    return id;
  };
  const ladderOf = (bands = thresholdBands(1)) => async (event: string): Promise<ActiveLadder> => ({ eventTicker: event, strikeDate: null, bands });
  const exits = () => db.prepare(`SELECT status, contracts, price_cents FROM paper_exits ORDER BY id`).all();

  it('does nothing and fetches nothing when there is no pending exit', async () => {
    const f = vi.fn(ladderOf());
    expect(await runPendingExits({ db, fetchLadderForEvent: f })).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it('a pending exit with a bid is filled and reported', async () => {
    const id = triggered('p1');
    const fills: any[] = [];
    expect(await runPendingExits({ db, fetchLadderForEvent: ladderOf(), onFill: (i) => fills.push(i) })).toBe(1);
    expect(exits()).toEqual([{ status: 'filled', contracts: 4, price_cents: 49 }]);
    expect(listOpenPaperPositions(db).map((p) => p.id)).not.toContain(id);
    expect(fills).toHaveLength(1);
  });

  it('with no bid it stays pending (one marker) and fills once a bid appears', async () => {
    triggered('p1');
    const noBid = thresholdBands(1);
    noBid[2] = thr(94, 50, 1, { yesBidCents: null });
    expect(await runPendingExits({ db, fetchLadderForEvent: ladderOf(noBid) })).toBe(0);
    expect(await runPendingExits({ db, fetchLadderForEvent: ladderOf(noBid) })).toBe(0);
    expect(exits()).toEqual([{ status: 'unsellable', contracts: 0, price_cents: null }]);
    expect(await runPendingExits({ db, fetchLadderForEvent: ladderOf() })).toBe(1);
    expect(exits().map((e: any) => e.status)).toEqual(['unsellable', 'filled']);
  });

  it('a partial fill leaves the rest pending for the next pass', async () => {
    triggered('p1');
    const shallow = thresholdBands(1);
    shallow[2] = thr(94, 50, 1, { yesBidSizeContracts: 1 });
    await runPendingExits({ db, fetchLadderForEvent: ladderOf(shallow) });
    await runPendingExits({ db, fetchLadderForEvent: ladderOf(shallow) });
    expect(exits().map((e: any) => [e.status, e.contracts])).toEqual([['partial', 1], ['partial', 1]]);
    await runPendingExits({ db, fetchLadderForEvent: ladderOf() });
    expect(listOpenPaperPositions(db)).toEqual([]);
  });

  it('a market that is gone from its open ladder is held to settlement and not retried', async () => {
    triggered('p1');
    const f = vi.fn(ladderOf([]));
    await runPendingExits({ db, fetchLadderForEvent: f });
    await runPendingExits({ db, fetchLadderForEvent: f });
    expect(exits()).toEqual([{ status: 'held_to_settlement', contracts: 0, price_cents: null }]);
    expect(f).toHaveBeenCalledTimes(1); // the second pass has no pending exit at all
  });

  it('a failed ladder fetch skips that event this pass and retries next time (no marker)', async () => {
    triggered('p1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runPendingExits({ db, fetchLadderForEvent: async () => { throw new Error('Kalshi 500'); } })).toBe(0);
    expect(exits()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(await runPendingExits({ db, fetchLadderForEvent: ladderOf() })).toBe(1);
  });

  it('startExitTimer runs a pass each interval, never overlaps, and stops', async () => {
    vi.useFakeTimers();
    triggered('p1');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = vi.fn(async (event: string): Promise<ActiveLadder> => { await gate; return { eventTicker: event, strikeDate: null, bands: thresholdBands(1) }; });
    const t = startExitTimer({ db, fetchLadderForEvent: f }, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f).toHaveBeenCalledTimes(1); // pass 1 is still waiting, ticks 2 and 3 were skipped
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(exits()).toHaveLength(1);
    t.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
