// test/perp/labStats.test.ts
import { describe, it, expect } from 'vitest';
import { binomCdf, clopperPearsonUpper, stratifiedEstimate } from '../../src/perp/lab/stats.js';

describe('binomCdf', () => {
  it('matches known values', () => {
    expect(binomCdf(0, 10, 0.5)).toBeCloseTo(1 / 1024, 6);
    expect(binomCdf(10, 10, 0.3)).toBeCloseTo(1, 9);
    expect(binomCdf(1, 2, 0.5)).toBeCloseTo(0.75, 9);
  });
});

describe('clopperPearsonUpper', () => {
  it('k = 0 is about 3/n (the rule of three)', () => {
    expect(clopperPearsonUpper(0, 400)).toBeCloseTo(1 - Math.pow(0.05, 1 / 400), 5);
    expect(clopperPearsonUpper(0, 400)).toBeGreaterThan(0.0073);
    expect(clopperPearsonUpper(0, 400)).toBeLessThan(0.0076);
  });
  it('matches a known exact bound: 1 miss in 100', () => {
    expect(clopperPearsonUpper(1, 100)).toBeCloseTo(0.0466, 3);
  });
  it('edge cases: nothing audited or everything missed means no information', () => {
    expect(clopperPearsonUpper(0, 0)).toBe(1);
    expect(clopperPearsonUpper(5, 5)).toBe(1);
    expect(clopperPearsonUpper(7, 5)).toBe(1);
  });
  it('is monotone in k and shrinks with n', () => {
    expect(clopperPearsonUpper(2, 100)).toBeGreaterThan(clopperPearsonUpper(1, 100));
    expect(clopperPearsonUpper(0, 800)).toBeLessThan(clopperPearsonUpper(0, 400));
  });
});

describe('stratifiedEstimate', () => {
  it('weights each stratum by its volume and ignores strata with no audits or no volume', () => {
    const e = stratifiedEstimate([{ volume: 900, n: 100, k: 1 }, { volume: 100, n: 100, k: 0 }, { volume: 500, n: 0, k: 0 }, { volume: 0, n: 50, k: 5 }]);
    expect(e.n).toBe(200);
    expect(e.k).toBe(1);
    expect(e.rate).toBeCloseTo((900 * 0.01 + 100 * 0) / 1000, 9);
    expect(e.upper95!).toBeCloseTo(0.9 * clopperPearsonUpper(1, 100) + 0.1 * clopperPearsonUpper(0, 100), 9);
  });
  it('is null when nothing usable was audited', () => {
    expect(stratifiedEstimate([])).toEqual({ rate: null, upper95: null, n: 0, k: 0 });
    expect(stratifiedEstimate([{ volume: 10, n: 0, k: 0 }])).toEqual({ rate: null, upper95: null, n: 0, k: 0 });
  });
});
