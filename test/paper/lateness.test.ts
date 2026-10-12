// test/paper/lateness.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { recordExitReview, recordExitFill, recordExitMarker } from '../../src/paper/exits.js';
import {
  computeLateness, sweepLateness, LATENESS_SETTLE_DELAY_MS, LATENESS_GIVE_UP_MS, type LatenessInput,
} from '../../src/paper/lateness.js';
import type { Candle } from '../../src/decide/kalshiHistory.js';

const T0 = Date.parse('2026-10-12T01:00:00Z');
const sec = (ms: number) => Math.floor(ms / 1000);
// one-minute candles: held YES marks at the yes bid
const candle = (offsetMs: number, bid: number, ask: number): Candle => ({ endTs: sec(T0 + offsetMs), yesBidCents: bid, yesAskCents: ask });

const input = (over: Partial<LatenessInput> = {}): LatenessInput => ({
  side: 'yes', entryPriceCents: 50, contracts: 4, fillPriceCents: 38, filledAt: new Date(T0 + 150_000).toISOString(),
  lag: {
    sourcePublishTs: new Date(T0 + 5_000).toISOString(), firstSeenTs: new Date(T0 + 20_000).toISOString(),
    emittedTs: new Date(T0 + 21_000).toISOString(), reviewStartedAt: new Date(T0 + 100_000).toISOString(),
    modelReturnedAt: new Date(T0 + 130_000).toISOString(), firstSellAttemptAt: new Date(T0 + 131_000).toISOString(),
  },
  ...over,
});

describe('computeLateness', () => {
  it('on time: the mark had not moved when we started, nothing lost beyond the fill gap', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 50, 52), candle(120_000, 49, 51)];
    const r = computeLateness(input({ fillPriceCents: 49 }), candles, T0 + 200_000);
    expect(r).toMatchObject({ source: 'candles', markAtPublication: 50, markAtReviewStart: 50, late: false, fillPriceCents: 49 });
    expect(r.centsLostToLateness).toBe(4); // (50 - 49) * 4
  });

  it('late: the held side had already fallen by more than 2% of entry before the review started', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 40, 42), candle(120_000, 38, 40)];
    const r = computeLateness(input(), candles, T0 + 200_000);
    expect(r.markAtPublication).toBe(50);
    expect(r.markAtReviewStart).toBe(40);
    expect(r.late).toBe(true); // 10c > 2% of 50c = 1c
    expect(r.centsLostToLateness).toBe(48); // (50 - 38) * 4
  });

  it('a fall within 2% of entry is not late (the threshold is strict)', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 49, 51)];
    expect(computeLateness(input({ fillPriceCents: 49 }), candles, T0 + 200_000).late).toBe(false); // 1c is not > 1c
  });

  it('a NO position uses 100 - yes ask as its mark', () => {
    const candles = [candle(0, 50, 52), candle(60_000, 60, 62)]; // NO mark 48 then 38
    const r = computeLateness(input({ side: 'no', entryPriceCents: 48, fillPriceCents: 37 }), candles, T0 + 200_000);
    expect(r).toMatchObject({ markAtPublication: 48, markAtReviewStart: 38, late: true });
  });

  it('a fill above the publication mark loses nothing to lateness (clamped at 0)', () => {
    const candles = [candle(0, 40, 42), candle(60_000, 45, 47)];
    expect(computeLateness(input({ fillPriceCents: 45 }), candles, T0 + 200_000).centsLostToLateness).toBe(0);
  });

  it('no candle history: source none, late and loss unknown, the lag chain still recorded', () => {
    const r = computeLateness(input(), [], T0 + 200_000);
    expect(r).toMatchObject({ source: 'none', markAtPublication: null, markAtReviewStart: null, late: null, centsLostToLateness: null });
    expect(r.lagMs).toEqual({
      publishToFirstSeen: 15_000, firstSeenToEmitted: 1_000, emittedToReviewStart: 79_000, reviewStartToModelReturned: 30_000,
      modelReturnedToSellAttempt: 1_000, sellAttemptToFill: 19_000, publishToFill: 145_000,
    });
  });

  it('missing timestamps give null stages, and the publication anchor falls back to event time then first seen', () => {
    const r = computeLateness(input({ lag: { eventTime: new Date(T0).toISOString(), reviewStartedAt: new Date(T0 + 100_000).toISOString() } }), [candle(0, 50, 52)], T0 + 200_000);
    expect(r.publishedAt).toBe(new Date(T0).toISOString());
    expect(r.lagMs.publishToFirstSeen).toBeNull();
    expect(r.lagMs.publishToFill).toBe(150_000);
    expect(computeLateness(input({ lag: { firstSeenTs: new Date(T0 + 20_000).toISOString() } }), [], T0).publishedAt).toBe(new Date(T0 + 20_000).toISOString());
  });
});

describe('sweepLateness', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lateness-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const lagJson = JSON.stringify({
    sourcePublishTs: new Date(T0 + 5_000).toISOString(), reviewStartedAt: new Date(T0 + 100_000).toISOString(),
    firstSellAttemptAt: new Date(T0 + 131_000).toISOString(),
  });
  const filledExit = (itemId: string, filledAtMs: number, contracts = 4, price = 38) => {
    const p = recordPaperPosition(db, {
      trade: 'kxwti', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: `T-${itemId}`, side: 'yes', contracts,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
    const r = recordExitReview(db, { trade: 'kxwti', itemId: `n-${itemId}`, positionId: p, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson });
    const fill = recordExitFill(db, { positionId: p, reviewId: r, contracts, priceCents: price, filledAt: new Date(filledAtMs).toISOString() });
    return { p, r, exitId: fill.exitId };
  };
  const row = (id: number) => db.prepare(`SELECT late, late_json FROM paper_exits WHERE id = ?`).get(id) as { late: number | null; late_json: string | null };
  const candles = [candle(0, 50, 52), candle(60_000, 40, 42), candle(120_000, 38, 40)];

  it('measures a settled fill once, writes late + late_json, and is idempotent', async () => {
    const { exitId } = filledExit('a', T0 + 150_000);
    const fetchCandles = vi.fn(async () => candles);
    const now = () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS + 1000;
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles, now })).toBe(1);
    expect(row(exitId).late).toBe(1);
    expect(JSON.parse(row(exitId).late_json!)).toMatchObject({ source: 'candles', markAtPublication: 50, markAtReviewStart: 40, late: true, centsLostToLateness: 48 });
    expect(fetchCandles).toHaveBeenCalledWith('KXWTI', 'T-a', expect.any(Number), expect.any(Number));
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles, now })).toBe(0);
    expect(fetchCandles).toHaveBeenCalledTimes(1);
  });

  it('does not measure a fill younger than the settle delay', async () => {
    const { exitId } = filledExit('a', T0 + 150_000);
    const fetchCandles = vi.fn(async () => candles);
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles, now: () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS - 1000 })).toBe(0);
    expect(fetchCandles).not.toHaveBeenCalled();
    expect(row(exitId).late_json).toBeNull();
  });

  it('with no candles it retries while the fill is young and gives up (source none) once it is old', async () => {
    const { exitId } = filledExit('a', T0 + 150_000);
    const empty = vi.fn(async () => [] as Candle[]);
    const young = () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS + 1000;
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles: empty, now: young })).toBe(0);
    expect(row(exitId).late_json).toBeNull();
    const old = () => T0 + 150_000 + LATENESS_GIVE_UP_MS + 1000;
    expect(await sweepLateness(db, 'KXWTI', { fetchCandles: empty, now: old })).toBe(1);
    const stored = JSON.parse(row(exitId).late_json!);
    expect(stored.source).toBe('none');
    expect(stored.lagMs.publishToFill).toBe(145_000);
    expect(row(exitId).late).toBeNull();
  });

  it('skips marker rows (unsellable / held_to_settlement) and isolates a failing row', async () => {
    const a = filledExit('a', T0 + 150_000);
    const b = filledExit('b', T0 + 150_000);
    const p = recordPaperPosition(db, {
      trade: 'kxwti', itemId: 'm', structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-m', side: 'yes', contracts: 2,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
    const r = recordExitReview(db, { trade: 'kxwti', itemId: 'n-m', positionId: p, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson });
    recordExitMarker(db, p, r, 'unsellable');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchCandles = vi.fn(async (_s: string, market: string) => {
      if (market === 'T-a') throw new Error('boom');
      return candles;
    });
    const written = await sweepLateness(db, 'KXWTI', { fetchCandles: fetchCandles as any, now: () => T0 + 150_000 + LATENESS_SETTLE_DELAY_MS + 1000 });
    expect(written).toBe(1);
    expect(row(a.exitId).late_json).toBeNull(); // failed row retried next sweep
    expect(row(b.exitId).late_json).not.toBeNull();
    expect(err).toHaveBeenCalled();
    expect(fetchCandles).toHaveBeenCalledTimes(2); // the marker row was never fetched
  });

  it('survives a malformed lag_json', async () => {
    const { exitId, r } = filledExit('a', T0 + 150_000);
    db.prepare(`UPDATE paper_exit_reviews SET lag_json = '{not json' WHERE id = ?`).run(r);
    const written = await sweepLateness(db, 'KXWTI', { fetchCandles: async () => [], now: () => T0 + 150_000 + LATENESS_GIVE_UP_MS + 1000 });
    expect(written).toBe(1);
    expect(JSON.parse(row(exitId).late_json!).source).toBe('none');
  });
});
