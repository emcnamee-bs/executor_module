import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { joinBars, ratioSeries, simulatePriceRules, type DailyBar } from '../../src/perp/backtest/priceRules.js';

const bars = (closes: number[], vix = 16): DailyBar[] =>
  closes.map((close, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, close, vix }));
const run = (closes: number[], side: 'long' | 'short' = 'long', maxHoldDays = 5) =>
  simulatePriceRules(bars(closes), { cfg: DEFAULT_CONFIG, side, entryEveryDays: 100, maxHoldDays });

describe('simulatePriceRules', () => {
  it('a steady rise never stops a long out; return = leveraged index move minus fees at 4x', () => {
    const { trades, summary } = run([100, 101, 102, 103, 104, 105]);
    expect(trades).toHaveLength(1);
    expect(trades[0].exitReason).toBe('timeout');
    expect(trades[0].leverage).toBe(4);
    expect(trades[0].indexReturn).toBeCloseTo(0.05, 8);
    expect(trades[0].marginReturn).toBeCloseTo(0.05 * 4 - 2 * 0.000072 * 4, 8);
    expect(summary.stopOutRate).toBe(0);
  });
  it('a close more than the stop below the watermark stops a long out at that close', () => {
    // VIX 16 -> stop 3.88%; peak 103 then 98: (103-98)/103 = 4.85% through the stop
    const { trades } = run([100, 102, 103, 98, 97, 96]);
    expect(trades[0].exitReason).toBe('stop');
    expect(trades[0].exitDate).toBe('2026-01-04');
    expect(trades[0].indexReturn).toBeCloseTo(-0.02, 8);
    expect(trades[0].marginReturn).toBeCloseTo(-0.02 * 4 - 2 * 0.000072 * 4, 8);
  });
  it('a short is stopped out by a rise through the low-water mark', () => {
    const { trades } = run([100, 98, 97, 101, 102, 103], 'short');
    expect(trades[0].exitReason).toBe('stop');
    expect(trades[0].indexReturn).toBeCloseTo(0.01, 8); // index +1% from entry
    expect(trades[0].marginReturn).toBeCloseTo(-0.01 * 4 - 2 * 0.000072 * 4, 8);
  });
  it('a gap past the liquidation distance liquidates and floors the loss at -100% of margin', () => {
    const { trades } = run([100, 99, 70, 70, 70, 70]); // -30% gap, liquidation distance ~20%
    expect(trades[0].exitReason).toBe('liquidated');
    expect(trades[0].marginReturn).toBe(-1);
  });
  it('flags trades whose path touched the 3% soft drawdown and weeks with a >=5% drop', () => {
    // 98 holds (stop level ~96.1), then 94 stops it out at -6% of the index: both flags must be set.
    const { summary, trades } = run([100, 98, 94, 93, 92, 91]);
    expect(trades[0].touchedSoft).toBe(true);
    expect(summary.touchedSoftRate).toBe(1);
    expect(summary.weeklyDrop5Rate).toBe(1);
  });
  it('enters every N days and skips entries without a full holding window or a usable VIX', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = simulatePriceRules(bars(closes), { cfg: DEFAULT_CONFIG, side: 'long', entryEveryDays: 5, maxHoldDays: 5 });
    expect(out.trades.length).toBe(5);
    const noVix = simulatePriceRules(bars(closes, 0), { cfg: DEFAULT_CONFIG, side: 'long', entryEveryDays: 5, maxHoldDays: 5 });
    expect(noVix.trades).toHaveLength(0);
  });
  it('reports zeros, not NaN, for an empty run', () => {
    const out = simulatePriceRules([], { cfg: DEFAULT_CONFIG, side: 'long', entryEveryDays: 5, maxHoldDays: 5 });
    expect(out.summary).toEqual({ n: 0, stopOutRate: 0, avgMarginReturn: 0, worstMarginReturn: 0, touchedSoftRate: 0, weeklyDrop5Rate: 0 });
  });
});

describe('joinBars / ratioSeries', () => {
  it('joins on date and drops dates missing from either series', () => {
    const sp = [{ date: 'a', value: 100 }, { date: 'b', value: 101 }, { date: 'c', value: 102 }];
    const vix = [{ date: 'b', value: 15 }, { date: 'c', value: 16 }, { date: 'd', value: 17 }];
    expect(joinBars(sp, vix)).toEqual([{ date: 'b', close: 101, vix: 15 }, { date: 'c', close: 102, vix: 16 }]);
  });
  it('ratioSeries divides matching dates', () => {
    expect(ratioSeries([{ date: 'x', value: 13.7 }, { date: 'y', value: 5 }], [{ date: 'x', value: 6850 }])).toEqual([{ date: 'x', ratio: 13.7 / 6850 }]);
  });
});
