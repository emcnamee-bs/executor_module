import { describe, it, expect } from 'vitest';
import { buildSnapshot, computeReturns, realizedWeeklySigma, vixOf } from '../../src/perp/snapshot/builder.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;
const D = 24 * H;
const perp = { bid: 13.75, ask: 13.76, mark: 13.8, marketOpen: true, nextCloseTsMs: null, fundingEstimate: 0 };

describe('computeReturns', () => {
  it('uses the history point nearest to one and five days ago', () => {
    const history = [
      { tsMs: NOW - 5 * D, mark: 14.0 },
      { tsMs: NOW - D, mark: 13.5 },
      { tsMs: NOW - H, mark: 13.78 },
    ];
    const r = computeReturns(NOW, 13.8, history);
    expect(r.d1).toBeCloseTo(13.8 / 13.5 - 1, 8);
    expect(r.d5).toBeCloseTo(13.8 / 14.0 - 1, 8);
  });
  it('is null when history does not reach back far enough or the nearest point is too far from the window', () => {
    expect(computeReturns(NOW, 13.8, [{ tsMs: NOW - 2 * H, mark: 13.7 }])).toEqual({ d1: null, d5: null });
    expect(computeReturns(NOW, 13.8, [{ tsMs: NOW - D - 10 * H, mark: 13.5 }]).d1).toBeNull();
    expect(computeReturns(NOW, 13.8, [])).toEqual({ d1: null, d5: null });
  });
});

describe('realizedWeeklySigma', () => {
  it('is null with too little history', () => {
    expect(realizedWeeklySigma([])).toBeNull();
    expect(realizedWeeklySigma(Array.from({ length: 10 }, (_, i) => ({ tsMs: NOW - (10 - i) * H, mark: 13.7 })))).toBeNull();
  });
  it('is 0-ish for a flat series and scales sqrt(120) x the hourly stdev otherwise', () => {
    const flat = Array.from({ length: 40 }, (_, i) => ({ tsMs: NOW - (40 - i) * H, mark: 13.7 }));
    expect(realizedWeeklySigma(flat)).toBe(0);
    // alternating +1% / -1% hourly log moves: stdev ~ 0.01
    let m = 13.7;
    const wiggly = Array.from({ length: 40 }, (_, i) => {
      m *= i % 2 === 0 ? 1.01 : 1 / 1.01;
      return { tsMs: NOW - (40 - i) * H, mark: m };
    });
    const s = realizedWeeklySigma(wiggly)!;
    expect(s).toBeGreaterThan(0.01 * Math.sqrt(120) * 0.9);
    expect(s).toBeLessThan(0.01 * Math.sqrt(120) * 1.1);
  });
  it('buckets to one point per hour, ignoring finer samples', () => {
    const dense = Array.from({ length: 40 * 60 }, (_, i) => ({ tsMs: NOW - (40 * 60 - i) * 60_000, mark: 13.7 + (i % 2) * 0.001 }));
    expect(realizedWeeklySigma(dense)).not.toBeNull();
  });
});

describe('buildSnapshot', () => {
  it('assembles freshness, returns, sigma, macro and events', () => {
    const s = buildSnapshot({
      nowMs: NOW, perp, perpFetchedAtMs: NOW - 2000,
      macro: { vix: { value: 16, change1d: 0.1, asOf: '2026-10-13' } }, macroFetchedAtMs: NOW - 10 * 60_000,
      events: [{ tsMs: NOW + H, name: 'CPI', impact: 'high' }],
      kalshiEvents: [{ ticker: 'X', yesProb: 0.5 }],
      history: [{ tsMs: NOW - D, mark: 13.5 }],
    });
    expect(s.tsMs).toBe(NOW);
    expect(s.freshness).toEqual({ perpAgeMs: 2000, macroAgeMs: 600_000 });
    expect(s.returns.d1).toBeCloseTo(13.8 / 13.5 - 1, 8);
    expect(s.realizedWeeklySigma).toBeNull();
    expect(vixOf(s)).toBe(16);
    expect(s.events).toHaveLength(1);
  });
  it('vixOf is null when VIX is missing and macro age is null when macro never loaded', () => {
    const s = buildSnapshot({ nowMs: NOW, perp, perpFetchedAtMs: NOW, macro: {}, macroFetchedAtMs: null, events: [], kalshiEvents: [], history: [] });
    expect(vixOf(s)).toBeNull();
    expect(s.freshness.macroAgeMs).toBeNull();
  });
});
