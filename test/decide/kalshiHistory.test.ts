// test/decide/kalshiHistory.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  fetchCandles, heldSideMark, markAtOrBefore, fetchTrajectory, TRAJECTORY_MINUTES, type Candle,
} from '../../src/decide/kalshiHistory.js';

const candle = (endTs: number, bid: string, ask: string) => ({
  end_period_ts: endTs, yes_bid: { close_dollars: bid }, yes_ask: { close_dollars: ask },
});
const fakeFetch = (body: unknown, ok = true, status = 200) =>
  vi.fn(async (_url: string, _init?: unknown) => ({ ok, status, json: async () => body })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('fetchCandles', () => {
  it('requests 1-minute candles for the series/market window and maps closes to cents, sorted', async () => {
    const f = fakeFetch({ candlesticks: [candle(2000, '0.6200', '0.6400'), candle(1000, '0.6000', '0.6200')] });
    const candles = await fetchCandles('KXWTI', 'KXWTI-26OCT1314-T92.99', 900, 2100, f);
    const url = (f as any).mock.calls[0][0] as string;
    expect(url).toContain('/series/KXWTI/markets/KXWTI-26OCT1314-T92.99/candlesticks');
    expect(url).toContain('start_ts=900');
    expect(url).toContain('end_ts=2100');
    expect(url).toContain('period_interval=1');
    expect(candles).toEqual([
      { endTs: 1000, yesBidCents: 60, yesAskCents: 62 },
      { endTs: 2000, yesBidCents: 62, yesAskCents: 64 },
    ]);
  });

  it('is best effort: an HTTP error, a thrown fetch or a malformed body gives []', async () => {
    expect(await fetchCandles('S', 'M', 0, 1, fakeFetch({}, false, 429))).toEqual([]);
    expect(await fetchCandles('S', 'M', 0, 1, vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch)).toEqual([]);
    expect(await fetchCandles('S', 'M', 0, 1, fakeFetch({ nope: 1 }))).toEqual([]);
  });

  it('a 0.0000 close is "no quote" (null)', async () => {
    const f = fakeFetch({ candlesticks: [candle(1000, '0.0000', '0.0500')] });
    expect(await fetchCandles('S', 'M', 0, 1, f)).toEqual([{ endTs: 1000, yesBidCents: null, yesAskCents: 5 }]);
  });
});

describe('held-side marks', () => {
  const c: Candle = { endTs: 1000, yesBidCents: 60, yesAskCents: 62 };
  it('YES marks at the yes bid, NO at 100 - yes ask, null when that side has no quote', () => {
    expect(heldSideMark(c, 'yes')).toBe(60);
    expect(heldSideMark(c, 'no')).toBe(38);
    expect(heldSideMark({ endTs: 1, yesBidCents: null, yesAskCents: null }, 'yes')).toBeNull();
    expect(heldSideMark({ endTs: 1, yesBidCents: null, yesAskCents: null }, 'no')).toBeNull();
  });

  it('markAtOrBefore uses the last candle that ended at or before ts', () => {
    const cs: Candle[] = [
      { endTs: 1000, yesBidCents: 60, yesAskCents: 62 },
      { endTs: 1060, yesBidCents: 55, yesAskCents: 57 },
      { endTs: 1120, yesBidCents: 50, yesAskCents: 52 },
    ];
    expect(markAtOrBefore(cs, 1060, 'yes')).toBe(55);
    expect(markAtOrBefore(cs, 1100, 'yes')).toBe(55);
    expect(markAtOrBefore(cs, 999, 'yes')).toBeNull();
    expect(markAtOrBefore([], 1000, 'yes')).toBeNull();
  });
});

describe('fetchTrajectory', () => {
  it('returns the held-side mark 5, 15 and 60 minutes before now (null when unknown)', async () => {
    expect(TRAJECTORY_MINUTES).toEqual([5, 15, 60]);
    const now = 100_000;
    const f = fakeFetch({
      candlesticks: [
        candle(now - 60 * 60, '0.4000', '0.4200'),
        candle(now - 15 * 60, '0.3500', '0.3700'),
        candle(now - 5 * 60, '0.3000', '0.3200'),
      ],
    });
    const t = await fetchTrajectory('KXWTI', 'M', 'yes', now, f);
    expect(t).toEqual([
      { minutesAgo: 5, markCents: 30 },
      { minutesAgo: 15, markCents: 35 },
      { minutesAgo: 60, markCents: 40 },
    ]);
  });

  it('all null when the history is unavailable', async () => {
    const t = await fetchTrajectory('KXWTI', 'M', 'no', 100_000, fakeFetch({}, false, 500));
    expect(t.map((p) => p.markCents)).toEqual([null, null, null]);
  });
});
