// test/backtest/exitReplay.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  extractArticleText, parseLadderJson, bandsAt, trajectoryAt, replayPosition, summarizeReplay,
  type CandleMap, type ReplayItem, type ReplayPosition, type ReviewFn,
} from '../../src/backtest/exitReplay.js';
import type { Candle } from '../../src/decide/kalshiHistory.js';
import type { BandMarket } from '../../src/decide/kalshi.js';
import { thresholdBands } from '../paper/exitFixtures.js';

describe('extractArticleText', () => {
  it('takes the text between <article> tags from a messages-shaped request', () => {
    const req = JSON.stringify({ system: 's', messages: [{ role: 'user', content: 'Evidentiary rung: reported\n\n<article>\nTitle: X\nExcerpt: Y\n</article>' }] });
    expect(extractArticleText(req)).toBe('Title: X\nExcerpt: Y');
  });
  it('uses the whole user string of a gate-shaped request when there are no tags', () => {
    expect(extractArticleText(JSON.stringify({ system: 's', user: 'Title: Gate item', options: {} }))).toBe('Title: Gate item');
  });
  it('returns null for malformed json or a request with no text', () => {
    expect(extractArticleText('{nope')).toBeNull();
    expect(extractArticleText(JSON.stringify({ system: 's' }))).toBeNull();
    expect(extractArticleText(JSON.stringify({ messages: [{ role: 'user', content: '   ' }] }))).toBeNull();
  });
});

describe('parseLadderJson', () => {
  it('returns the bands, or null for missing / malformed / empty ladders', () => {
    const bands = thresholdBands(1);
    expect(parseLadderJson(JSON.stringify({ eventTicker: 'EV', bands }))).toHaveLength(5);
    expect(parseLadderJson('[]')).toBeNull();
    expect(parseLadderJson('{bad')).toBeNull();
    expect(parseLadderJson(JSON.stringify({ eventTicker: 'EV', bands: [] }))).toBeNull();
    expect(parseLadderJson(JSON.stringify({ eventTicker: 'EV' }))).toBeNull();
  });
});

// candles: each ticker quotes its fixture mid +/- 1c from t=2000 on
function candlesFor(adjust: (ticker: string, ts: number, bid: number, ask: number) => [number, number] = (_t, _ts, b, a) => [b, a]): CandleMap {
  const map: CandleMap = new Map();
  for (const b of thresholdBands(1)) {
    const cs: Candle[] = [];
    for (const ts of [2000, 2060, 2120, 2180, 2240]) {
      const [bid, ask] = adjust(b.ticker, ts, b.yesBidCents!, b.yesAskCents!);
      cs.push({ endTs: ts, yesBidCents: bid, yesAskCents: ask });
    }
    map.set(b.ticker, cs);
  }
  return map;
}

describe('bandsAt / trajectoryAt', () => {
  it('quotes each band from the last candle at or before the time; none yet means null quotes', () => {
    const ladder = thresholdBands(1);
    const map = candlesFor((t, ts, b, a) => (t === 'T-94' && ts >= 2120 ? [b - 10, a - 10] : [b, a]));
    const early = bandsAt(ladder, map, 1999);
    expect(early.every((b) => b.yesBidCents === null && b.yesAskCents === null)).toBe(true);
    const mid = bandsAt(ladder, map, 2100);
    expect(mid.find((b) => b.ticker === 'T-94')).toMatchObject({ yesBidCents: 49, yesAskCents: 51, status: 'active', yesBidSizeContracts: 1000, yesAskSizeContracts: 1000, floorStrike: 94, strikeType: 'greater' });
    expect(bandsAt(ladder, map, 2130).find((b) => b.ticker === 'T-94')).toMatchObject({ yesBidCents: 39, yesAskCents: 41 });
  });

  it('trajectoryAt reads the held-side mark 5, 15 and 60 minutes earlier', () => {
    const cs: Candle[] = [
      { endTs: 1000, yesBidCents: 60, yesAskCents: 62 }, { endTs: 1000 + 45 * 60, yesBidCents: 50, yesAskCents: 52 },
      { endTs: 1000 + 55 * 60, yesBidCents: 45, yesAskCents: 47 },
    ];
    const t = trajectoryAt(cs, 'yes', 1000 + 60 * 60);
    expect(t).toEqual([
      { minutesAgo: 5, markCents: 45 }, { minutesAgo: 15, markCents: 50 }, { minutesAgo: 60, markCents: 60 },
    ]);
  });
});

describe('replayPosition', () => {
  const position = (over: Partial<ReplayPosition> = {}): ReplayPosition => ({
    id: 1, side: 'yes', structure: 'threshold', marketTicker: 'T-94', contracts: 4, entryPriceCents: 50, createdAtSec: 1000,
    endSec: 100_000, actualPnlCents: -200, ladder: thresholdBands(1), ...over,
  });
  const item = (id: string, at: number): ReplayItem => ({ itemId: id, seenAtSec: at, text: `text of ${id}` });
  const adverse = { shift: -2, confidence: 1, reason: 'bearish' };
  const quiet = { shift: 0, confidence: 0.1, reason: 'noise' };

  it('stops at the first sell, prices it at the quote at that item time, and compares with what happened', async () => {
    const review: ReviewFn = vi.fn(async ({ item: it }) => (it.itemId === 'i3' ? adverse : quiet));
    const items = [item('i0', 500), item('i1', 1500), item('i2', 2100), item('i3', 2200), item('i4', 2300)];
    const r = await replayPosition(position(), items, candlesFor(), review);
    expect(r.rows.map((x) => [x.itemId, x.verdict])).toEqual([['i1', 'skip'], ['i2', 'hold'], ['i3', 'sell']]);
    expect(r.rows[0].reason).toMatch(/no quote/);
    expect(r.reviewed).toBe(2); // the model was called for i2 and i3 only (i0 predates the position, i1 had no quote, i4 comes after the sell)
    expect(review).toHaveBeenCalledTimes(2);
    expect(r.sold).toEqual({ atSec: 2200, itemId: 'i3', priceCents: 49, hypPnlCents: 4 * (49 - 50) });
    expect(r.actualPnlCents).toBe(-200);
    expect(r.deltaCents).toBe(-4 - -200);
  });

  it('uses the quote at the item time, never a later one', async () => {
    const map = candlesFor((t, ts, b, a) => (t === 'T-94' && ts >= 2180 ? [b - 30, a - 30] : [b, a])); // crash AFTER the item
    const r = await replayPosition(position(), [item('i1', 2150)], map, async () => adverse);
    expect(r.sold!.priceCents).toBe(49);
  });

  it('never sells: hypothetical equals actual and the delta is zero', async () => {
    const r = await replayPosition(position(), [item('i1', 2100), item('i2', 2200)], candlesFor(), async () => quiet);
    expect(r.sold).toBeNull();
    expect(r.deltaCents).toBe(0);
    expect(r.rows.map((x) => x.verdict)).toEqual(['hold', 'hold']);
  });

  it('an unknown actual outcome gives a null delta', async () => {
    const r = await replayPosition(position({ actualPnlCents: null }), [item('i1', 2100)], candlesFor(), async () => adverse);
    expect(r.sold).not.toBeNull();
    expect(r.deltaCents).toBeNull();
  });

  it('a sell trigger with no held-side bid at that time is a skip, and the replay continues to the next item', async () => {
    // a binary market: with no bid its mid is the quoted ask, so the trigger fires but nothing can be sold yet
    const binary: BandMarket = { ...thresholdBands(1)[2], strikeType: null, floorStrike: null };
    const map: CandleMap = new Map([
      ['T-94', [
        { endTs: 2060, yesBidCents: null, yesAskCents: 30 },
        { endTs: 2160, yesBidCents: 29, yesAskCents: 31 },
      ]],
    ]);
    const p = position({ structure: 'binary', ladder: [binary], entryPriceCents: 30, actualPnlCents: -120 });
    const r = await replayPosition(p, [item('i1', 2100), item('i2', 2200)], map, async () => adverse);
    expect(r.rows[0]).toMatchObject({ itemId: 'i1', verdict: 'skip' });
    expect(r.rows[0].reason).toMatch(/no bid/);
    expect(r.sold).toEqual({ atSec: 2200, itemId: 'i2', priceCents: 29, hypPnlCents: 4 * (29 - 30) });
  });

  it('a review that throws is a skip with the message, not a crash', async () => {
    const r = await replayPosition(position(), [item('i1', 2100), item('i2', 2200)], candlesFor(), async ({ item: it }) => {
      if (it.itemId === 'i1') throw new Error('API 529');
      return quiet;
    });
    expect(r.rows[0]).toMatchObject({ verdict: 'skip' });
    expect(r.rows[0].reason).toMatch(/529/);
    expect(r.rows[1].verdict).toBe('hold');
  });

  it('honours maxItems and the position window (items after endSec are ignored)', async () => {
    const review = vi.fn(async () => quiet);
    const items = [item('a', 2100), item('b', 2110), item('c', 2120), item('d', 200_000)];
    const r = await replayPosition(position(), items, candlesFor(), review, { maxItems: 2 });
    expect(r.rows).toHaveLength(2);
    expect(review).toHaveBeenCalledTimes(2);
    const r2 = await replayPosition(position({ endSec: 2105 }), items, candlesFor(), review);
    expect(r2.rows.map((x) => x.itemId)).toEqual(['a']);
  });

  it('applies the exit fee from the options', async () => {
    const r = await replayPosition(position(), [item('i1', 2100)], candlesFor(), async () => adverse, { exitFeeCents: 50 });
    expect(r.sold).toBeNull(); // 20c loss does not beat a 51c exit cost
    expect(r.rows[0].verdict).toBe('hold');
  });
});

describe('summarizeReplay', () => {
  it('totals reviews, sells, regret (selling was worse than holding) and P&L', () => {
    const base = { marketTicker: 'M', side: 'yes' as const, contracts: 1, entryPriceCents: 50, rows: [] };
    const s = summarizeReplay([
      { ...base, positionId: 1, reviewed: 3, sold: { atSec: 1, itemId: 'a', priceCents: 40, hypPnlCents: -10 }, actualPnlCents: -50, deltaCents: 40 },
      { ...base, positionId: 2, reviewed: 2, sold: { atSec: 1, itemId: 'b', priceCents: 40, hypPnlCents: -10 }, actualPnlCents: 50, deltaCents: -60 },
      { ...base, positionId: 3, reviewed: 1, sold: null, actualPnlCents: -20, deltaCents: 0 },
      { ...base, positionId: 4, reviewed: 1, sold: null, actualPnlCents: null, deltaCents: null },
    ]);
    expect(s).toEqual({ positions: 4, reviewed: 7, sells: 2, regretSells: 1, hypPnlCents: -10 + -10 + -20, actualPnlCents: -50 + 50 + -20, deltaCents: 40 + -60 + 0 });
  });
});
