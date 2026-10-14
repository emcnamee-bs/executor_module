import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import {
  barrierTouchProbability,
  clamp,
  liqBoundLeverage,
  liquidationDistance,
  normalCdf,
  sigmaWeekFromVix,
  stopFraction,
} from '../../src/perp/quant/formulas.js';

const cfg = DEFAULT_CONFIG;

describe('sigmaWeekFromVix', () => {
  it('is VIX/100/sqrt(52)', () => {
    expect(sigmaWeekFromVix(16)).toBeCloseTo(0.022188, 5);
    expect(sigmaWeekFromVix(20)).toBeCloseTo(0.027735, 5);
  });
  it('returns null for missing, zero, negative or non-finite VIX', () => {
    for (const bad of [0, -3, NaN, Infinity]) expect(sigmaWeekFromVix(bad)).toBeNull();
  });
});

describe('clamp', () => {
  it('clamps and lets hi win when the range is inverted', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0.02, 0.03, 0.0146)).toBe(0.0146);
  });
});

describe('stopFraction (spec 5.2)', () => {
  it('floats between 3% and the 5% cap with VIX at 4x', () => {
    expect(stopFraction(sigmaWeekFromVix(16)!, 4, cfg)).toBeCloseTo(0.038829, 5);
    expect(stopFraction(sigmaWeekFromVix(20)!, 4, cfg)).toBeCloseTo(0.048536, 5);
    expect(stopFraction(sigmaWeekFromVix(12)!, 4, cfg)).toBe(0.03); // floor
  });
  it('never exceeds the 5% cap even when volatility is high', () => {
    expect(stopFraction(sigmaWeekFromVix(25)!, 3.2965, cfg)).toBe(0.05);
    expect(stopFraction(sigmaWeekFromVix(40)!, 3, cfg)).toBe(0.05);
  });
  it('is limited by the margin-loss budget B/L at high leverage, below the floor', () => {
    expect(stopFraction(sigmaWeekFromVix(16)!, 13.7, cfg)).toBeCloseTo(0.2 / 13.7, 6);
  });
});

describe('liquidation helpers', () => {
  it('liquidationDistance = 1/L - MM', () => {
    expect(liquidationDistance(4, 0.0502)).toBeCloseTo(0.1998, 6);
    expect(liquidationDistance(13.74, 0.056)).toBeCloseTo(0.01678, 4);
  });
  it('liqBoundLeverage solves 2*stop <= 1/L - MM for L', () => {
    expect(liqBoundLeverage(0.0388, 0.0502)).toBeCloseTo(1 / (2 * 0.0388 + 0.0502), 6);
  });
});

describe('normal helpers', () => {
  it('normalCdf matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('barrierTouchProbability is 2*(1-Phi(b/sigma)), with edge cases', () => {
    expect(barrierTouchProbability(0.03, 0.022188)).toBeCloseTo(0.176, 2);
    expect(barrierTouchProbability(0, 0.02)).toBe(1);
    expect(barrierTouchProbability(0.03, 0)).toBe(0);
  });
});
