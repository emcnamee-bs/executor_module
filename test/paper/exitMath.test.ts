// test/paper/exitMath.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateExit, EXIT_LOSS_FRACTION, type ExitMathInput } from '../../src/paper/exitMath.js';
import type { BandMarket } from '../../src/decide/kalshi.js';
import { thr, thresholdBands } from './exitFixtures.js';

function input(over: Partial<ExitMathInput> = {}, halfSpread = 1): ExitMathInput {
  const bands = thresholdBands(halfSpread);
  return {
    structure: 'threshold', side: 'yes', contracts: 4, remaining: 4, entryPriceCents: 50,
    market: bands[2], bands, shift: -2, confidence: 1, ...over,
  };
}

describe('evaluateExit (threshold ladder, held YES on strike 94 at mid 50)', () => {
  it('uses the 2% constant from the spec', () => {
    expect(EXIT_LOSS_FRACTION).toBe(0.02);
  });

  it('sells when a confident adverse shift costs more than 2% and more than the spread', () => {
    const r = evaluateExit(input());
    expect(r).toMatchObject({ sell: true, midCents: 50, bidCents: 49, fairAfterCents: 30, lossCents: 20, exitCostCents: 1 });
  });

  it('holds on a zero shift, a favorable shift and zero confidence', () => {
    expect(evaluateExit(input({ shift: 0 })).sell).toBe(false);
    const fav = evaluateExit(input({ shift: 2 }));
    expect(fav.sell).toBe(false);
    expect(fav.lossCents).toBe(0);
    expect(evaluateExit(input({ confidence: 0 })).sell).toBe(false);
  });

  it('the spread guard: a loss above 2% but below the cost of leaving does not sell', () => {
    const wide = input({ confidence: 0.1 }, 3); // half-spread 3
    const r = evaluateExit(wide);
    expect(r.lossCents).toBeCloseTo(2);
    expect(r.exitCostCents).toBe(3);
    expect(r.sell).toBe(false);
    expect(r.reason).toMatch(/exit cost/);
    expect(evaluateExit(input({ confidence: 0.2 }, 3)).sell).toBe(true); // loss 4 > cost 3
  });

  it('the 2% rule: with no spread, a loss under 2% of cost holds and over 2% sells', () => {
    expect(evaluateExit(input({ confidence: 0.04 }, 0)).sell).toBe(false); // 0.8c per contract < 1c
    expect(evaluateExit(input({ confidence: 0.06 }, 0)).sell).toBe(true); // 1.2c per contract > 1c
  });

  it('weighs only the contracts still held against the 2% of the original cost basis', () => {
    expect(evaluateExit(input({ remaining: 1, confidence: 0.06 }, 0)).sell).toBe(false); // 1.2c total < 4c
    expect(evaluateExit(input({ remaining: 1, confidence: 1 }, 0)).sell).toBe(true); // 20c total > 4c
    expect(evaluateExit(input({ remaining: 0 })).sell).toBe(false);
  });

  it('adds the configured exit fee to the cost of leaving', () => {
    expect(evaluateExit(input({ exitFeeCents: 20 })).sell).toBe(false); // loss 20 vs cost 1 + 20
    expect(evaluateExit(input({ exitFeeCents: 5 })).sell).toBe(true);
  });

  it('a NO position is hurt by an upward shift and sells at the NO bid', () => {
    const r = evaluateExit(input({ side: 'no', entryPriceCents: 52, contracts: 2, remaining: 2, shift: 2 }));
    expect(r).toMatchObject({ sell: true, midCents: 50, bidCents: 49, fairAfterCents: 30, lossCents: 20 });
  });

  it('holds when the market is not active', () => {
    const bands = thresholdBands(1);
    bands[2] = thr(94, 50, 1, { status: 'closed' });
    const r = evaluateExit(input({ bands, market: bands[2] }));
    expect(r.sell).toBe(false);
    expect(r.reason).toMatch(/not active/);
  });

  it('holds with a reason when the ladder cannot form a fair-value curve', () => {
    const one = [thr(94, 50, 1)];
    expect(evaluateExit(input({ bands: one, market: one[0] })).reason).toMatch(/at least two/);
    const rising = [thr(90, 20, 1), thr(92, 80, 1)];
    expect(evaluateExit(input({ bands: rising, market: rising[0] })).reason).toMatch(/not monotone/);
  });

  it('holds when the held contract itself has no two-sided quote', () => {
    const bands = thresholdBands(1);
    bands[2] = thr(94, 50, 1, { yesBidCents: null });
    const r = evaluateExit(input({ bands, market: bands[2] }));
    expect(r.sell).toBe(false);
    expect(r.reason).toMatch(/cannot be priced/);
  });
});

describe('evaluateExit (binary market: shift is YES-probability points)', () => {
  const bin = (over: Partial<BandMarket> = {}): BandMarket => ({
    ticker: 'B', floorStrike: null, capStrike: null, strikeType: null, status: 'active',
    yesAskCents: 61, yesBidCents: 59, yesAskSizeContracts: 100, yesBidSizeContracts: 100, ...over,
  });
  const base = (over: Partial<ExitMathInput> = {}): ExitMathInput => {
    const market = bin();
    return { structure: 'binary', side: 'yes', contracts: 2, remaining: 2, entryPriceCents: 60, market, bands: [market], shift: -20, confidence: 1, ...over };
  };

  it('YES loses when the probability falls', () => {
    expect(evaluateExit(base())).toMatchObject({ sell: true, midCents: 60, bidCents: 59, fairAfterCents: 40, lossCents: 20, exitCostCents: 1 });
  });

  it('NO loses when the probability rises', () => {
    expect(evaluateExit(base({ side: 'no', entryPriceCents: 40, shift: 20 }))).toMatchObject({
      sell: true, midCents: 40, bidCents: 39, fairAfterCents: 20, lossCents: 20,
    });
  });

  it('clamps the shifted probability to 1..99', () => {
    const m = bin({ yesAskCents: 6, yesBidCents: 4 });
    expect(evaluateExit(base({ market: m, bands: [m], shift: -20, entryPriceCents: 5 })).fairAfterCents).toBe(1);
  });

  it('a one-sided quote still prices (mid = the quoted side) and an absent bid means exit cost 0', () => {
    const m = bin({ yesBidCents: null, yesAskCents: 30 });
    const r = evaluateExit(base({ market: m, bands: [m], entryPriceCents: 30, shift: -20 }));
    expect(r).toMatchObject({ sell: true, midCents: 30, bidCents: null, fairAfterCents: 10, exitCostCents: 0 });
  });

  it('a market with no quote at all holds', () => {
    const m = bin({ yesBidCents: null, yesAskCents: null });
    expect(evaluateExit(base({ market: m, bands: [m] })).reason).toMatch(/no quote/);
  });
});

describe('evaluateExit: multi positions are priced like binary ones', () => {
  const market: BandMarket = { ticker: 'F-CUT', label: 'Cut 25bps', floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active', yesBidCents: 49, yesAskCents: 51, yesAskSizeContracts: 100, yesBidSizeContracts: 100 };
  const base = { side: 'yes' as const, contracts: 10, remaining: 10, entryPriceCents: 50, market, bands: [market], confidence: 1 };

  it('sells a YES position when the news removes enough YES probability', () => {
    const r = evaluateExit({ ...base, structure: 'multi', shift: -20 });
    expect(r.sell).toBe(true);
    expect(r.fairAfterCents).toBe(30);
    expect(r.midCents).toBe(50);
    expect(evaluateExit({ ...base, structure: 'binary', shift: -20 })).toEqual(r);
  });

  it('prices a NO position the other way round', () => {
    const r = evaluateExit({ ...base, side: 'no', structure: 'multi', shift: 20 });
    expect(r.sell).toBe(true);
    expect(r.fairAfterCents).toBe(30);
  });

  it('holds when the shift is small', () => {
    expect(evaluateExit({ ...base, structure: 'multi', shift: -0.5 }).sell).toBe(false);
  });
});

describe('evaluateExit (band ladder)', () => {
  const between = (lo: number, hi: number, mid: number): BandMarket => ({
    ticker: `B-${lo}`, floorStrike: lo, capStrike: hi, strikeType: 'between', status: 'active',
    yesAskCents: mid + 1, yesBidCents: mid - 1, yesAskSizeContracts: 100, yesBidSizeContracts: 100,
  });

  it('shifts the band curve for a held middle band', () => {
    const bands = [between(0, 1, 20), between(1, 2, 50), between(2, 3, 30)];
    const r = evaluateExit({
      structure: 'band', side: 'yes', contracts: 4, remaining: 4, entryPriceCents: 50, market: bands[1], bands, shift: -1, confidence: 1,
    });
    expect(r).toMatchObject({ sell: true, midCents: 50, fairAfterCents: 30, lossCents: 20 });
  });
});

describe('evaluateExit (non-finite model output never sells)', () => {
  const binMarket: BandMarket = {
    ticker: 'B', floorStrike: null, capStrike: null, strikeType: null, status: 'active',
    yesAskCents: 61, yesBidCents: 59, yesAskSizeContracts: 100, yesBidSizeContracts: 100,
  };
  const binary = (over: Partial<ExitMathInput> = {}): ExitMathInput => ({
    structure: 'binary', side: 'yes', contracts: 2, remaining: 2, entryPriceCents: 60,
    market: binMarket, bands: [binMarket], shift: -20, confidence: 1, ...over,
  });
  const cases: Array<[string, Partial<ExitMathInput>]> = [
    ['NaN shift', { shift: Number.NaN }],
    ['Infinity shift', { shift: Number.POSITIVE_INFINITY }],
    ['-Infinity shift', { shift: Number.NEGATIVE_INFINITY }],
    ['NaN confidence', { confidence: Number.NaN }],
  ];

  it.each(cases)('threshold ladder: %s holds with a reason', (_name, over) => {
    const r = evaluateExit(input(over));
    expect(r.sell).toBe(false);
    expect(r.reason).toMatch(/non-finite/);
  });

  it.each(cases)('binary market: %s holds with a reason', (_name, over) => {
    const r = evaluateExit(binary(over));
    expect(r.sell).toBe(false);
    expect(r.reason).toMatch(/non-finite/);
  });
});
