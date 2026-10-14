import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { computeGovernor, computeGovernors } from '../../src/perp/risk/governor.js';

const cfg = DEFAULT_CONFIG;
const g = (vix: number | null, side: 'long' | 'short' = 'long', realized: number | null = null, c = cfg) =>
  computeGovernor({ cfg: c, side, vix, realizedWeeklySigma: realized });

describe('computeGovernor', () => {
  it('keeps 4x and a ~3.9% stop at VIX 16', () => {
    const out = g(16);
    expect(out.sigmaSource).toBe('vix');
    expect(out.leverageEff).toBe(4);
    expect(out.stopFrac).toBeCloseTo(0.038829, 5);
    expect(out.sigmaDay).toBeCloseTo(0.022188 / Math.sqrt(5), 5);
  });
  it('reduces leverage instead of widening the stop when volatility is high (VIX 25)', () => {
    const out = g(25);
    expect(out.leverageEff).toBeCloseTo(0.2 / (1.75 * 0.034669), 3); // ~3.2965
    expect(out.stopFrac).toBe(0.05);
  });
  it('refuses a 13.7x target at VIX 16 (weekly horizon)', () => {
    const out = g(16, 'long', null, { ...cfg, leverageTarget: 13.7 });
    expect(out.leverageEff).toBeCloseTo(0.2 / 0.038829, 3); // ~5.15
    expect(out.leverageEff).toBeLessThan(6);
  });
  it('is bounded by liquidation distance when the loss budget is generous', () => {
    const out = g(16, 'long', null, { ...cfg, leverageTarget: 13.7, lossBudget: 0.4 });
    expect(out.leverageEff).toBeCloseTo(1 / (2 * 0.038829 + 0.0502), 3); // ~7.82
  });
  it('uses the higher short maintenance margin for shorts', () => {
    const long = g(16, 'long', null, { ...cfg, leverageTarget: 13.7, lossBudget: 0.4 });
    const short = g(16, 'short', null, { ...cfg, leverageTarget: 13.7, lossBudget: 0.4 });
    expect(short.leverageEff).toBeLessThan(long.leverageEff);
  });
  it('falls back to realized sigma, then to a default, when VIX is missing/zero/NaN (review focus 1)', () => {
    expect(g(null, 'long', 0.03).sigmaSource).toBe('realized');
    expect(g(null, 'long', 0.03).sigmaWeek).toBe(0.03);
    for (const bad of [null, 0, NaN, -5]) {
      const out = g(bad as number | null);
      expect(out.sigmaSource).toBe('default');
      expect(out.sigmaWeek).toBe(0.025);
      expect(Number.isFinite(out.leverageEff)).toBe(true);
      expect(Number.isFinite(out.stopFrac)).toBe(true);
    }
    expect(g(null, 'long', NaN).sigmaSource).toBe('default');
  });
  it('computeGovernors returns both sides', () => {
    const both = computeGovernors(cfg, 16, null);
    expect(both.long.leverageEff).toBe(4);
    expect(both.short.leverageEff).toBe(4);
  });
});
