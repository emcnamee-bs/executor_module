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
    // closed form: 39 returns of +-a (a = ln 1.01), 19 positive and 20 negative => sum = -a, mean = -a/39,
    // sum of squared deviations = 39a^2 - a^2/39, sample variance divides by 38.
    const a = Math.log(1.01);
    const expected = Math.sqrt((39 * a * a - (a * a) / 39) / 38) * Math.sqrt(120);
    expect(s).toBeCloseTo(expected, 10);
  });
  it('buckets to one point per hour using the LAST mark in each hour, ignoring earlier finer samples', () => {
    const base = Math.floor(NOW / H) * H;
    const lastMark = (j: number) => 13.7 * Math.exp(0.004 * Math.sin(j * 1.3));
    const series: Array<{ tsMs: number; mark: number }> = [];
    for (let j = 0; j < 40; j++) {
      const hourStart = base - (40 - j) * H;
      // noisy earlier-in-hour marks that must be ignored, then the hour's final mark
      series.push({ tsMs: hourStart + 5 * 60_000, mark: 13.7 * (j % 2 === 0 ? 1.05 : 0.95) });
      series.push({ tsMs: hourStart + 20 * 60_000, mark: 13.7 * (j % 3 === 0 ? 0.9 : 1.1) });
      series.push({ tsMs: hourStart + 50 * 60_000, mark: lastMark(j) });
    }
    const rets: number[] = [];
    for (let j = 1; j < 40; j++) rets.push(Math.log(lastMark(j) / lastMark(j - 1)));
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
    expect(realizedWeeklySigma(series)).toBeCloseTo(sd * Math.sqrt(120), 10);
  });
  it('is null for sparse history: 25 daily samples are not hourly returns', () => {
    const daily = Array.from({ length: 25 }, (_, i) => ({ tsMs: NOW - (25 - i) * D, mark: 13.7 + (i % 2) * 0.1 }));
    expect(realizedWeeklySigma(daily)).toBeNull();
  });
  it('is null when gaps leave fewer than 24 adjacent hourly returns, even with many samples', () => {
    // every other hour: 30 points, but no two are in adjacent hour buckets => 0 returns
    const alternate = Array.from({ length: 30 }, (_, i) => ({ tsMs: NOW - (60 - 2 * i) * H, mark: 13.7 + (i % 2) * 0.1 }));
    expect(realizedWeeklySigma(alternate)).toBeNull();
  });
  it('is non-null for 40 contiguous hourly samples', () => {
    const contiguous = Array.from({ length: 40 }, (_, i) => ({ tsMs: NOW - (40 - i) * H, mark: 13.7 + (i % 2) * 0.1 }));
    expect(realizedWeeklySigma(contiguous)).not.toBeNull();
  });
  it('forms no return across a gap: equals the sigma of the adjacent pairs only', () => {
    const base = Math.floor(NOW / H) * H;
    const mark = (j: number) => 13.7 * Math.exp(0.004 * Math.sin(j * 1.3));
    // hours 0..35 with hours 15..20 missing: segments 0..14 and 21..35 => 14 + 14 = 28 adjacent returns
    const present = Array.from({ length: 36 }, (_, j) => j).filter((j) => j < 15 || j > 20);
    const series = present.map((j) => ({ tsMs: base - (36 - j) * H + 30 * 60_000, mark: mark(j) }));
    const rets: number[] = [];
    for (let j = 1; j < 36; j++) {
      if (present.includes(j) && present.includes(j - 1)) rets.push(Math.log(mark(j) / mark(j - 1)));
    }
    expect(rets).toHaveLength(28);
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
    expect(realizedWeeklySigma(series)).toBeCloseTo(sd * Math.sqrt(120), 10);
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
  it('vixOf is null when the macro data is stale (> 4 days), of infinite age, or of unknown age (W4)', () => {
    const vix = { vix: { value: 16, change1d: 0, asOf: '2026-10-10' } };
    const at = (macroFetchedAtMs: number | null) =>
      vixOf(buildSnapshot({ nowMs: NOW, perp, perpFetchedAtMs: NOW, macro: vix, macroFetchedAtMs, events: [], kalshiEvents: [], history: [] }));
    expect(at(NOW - 3 * D)).toBe(16);
    expect(at(NOW - 4 * D)).toBe(16);
    expect(at(NOW - 5 * D)).toBeNull();
    expect(at(NaN)).toBeNull(); // age Infinity
    expect(at(null)).toBeNull();
  });
  const base = { perp, macro: {}, events: [], kalshiEvents: [], history: [] };
  it('maps a NaN perpFetchedAtMs, nowMs or macroFetchedAtMs to Infinity age (reads as stale, never fresh)', () => {
    expect(buildSnapshot({ ...base, nowMs: NOW, perpFetchedAtMs: NaN, macroFetchedAtMs: NOW }).freshness.perpAgeMs).toBe(Infinity);
    const nanNow = buildSnapshot({ ...base, nowMs: NaN, perpFetchedAtMs: NOW, macroFetchedAtMs: NOW }).freshness;
    expect(nanNow.perpAgeMs).toBe(Infinity);
    expect(nanNow.macroAgeMs).toBe(Infinity);
    expect(buildSnapshot({ ...base, nowMs: NOW, perpFetchedAtMs: NOW, macroFetchedAtMs: NaN }).freshness.macroAgeMs).toBe(Infinity);
  });
  it('keeps null macro age for never-loaded macro and clamps future-dated fetch times to 0', () => {
    expect(buildSnapshot({ ...base, nowMs: NOW, perpFetchedAtMs: NOW, macroFetchedAtMs: null }).freshness.macroAgeMs).toBeNull();
    const skew = buildSnapshot({ ...base, nowMs: NOW, perpFetchedAtMs: NOW + 5000, macroFetchedAtMs: NOW + 5000 }).freshness;
    expect(skew).toEqual({ perpAgeMs: 0, macroAgeMs: 0 });
  });
});
