// test/decide/sizingThreshold.test.ts
import { describe, it, expect } from 'vitest';
import {
  evaluateSizing,
  buildThresholdCurve,
  thresholdCurveProblem,
  buildCandidatesForThreshold,
  evaluateBinarySizing,
  type SizingInput,
} from '../../src/decide/sizing.js';
import type { BandMarket } from '../../src/decide/kalshi.js';

function market(overrides: Partial<BandMarket>): BandMarket {
  return {
    ticker: 'M',
    floorStrike: null,
    capStrike: null,
    strikeType: 'greater',
    status: 'active',
    yesAskCents: 40,
    yesBidCents: 38,
    yesAskSizeContracts: 100,
    yesBidSizeContracts: 100,
    ...overrides,
  };
}

/** A "greater than strike" market priced bid/ask. */
function gt(strike: number, bid: number, ask: number, overrides: Partial<BandMarket> = {}): BandMarket {
  return market({
    ticker: `G-${strike.toFixed(2)}`,
    floorStrike: strike,
    capStrike: null,
    strikeType: 'greater',
    yesBidCents: bid,
    yesAskCents: ask,
    ...overrides,
  });
}

function gasLadder(): BandMarket[] {
  return [gt(4.3, 79, 81), gt(4.34, 57, 59), gt(4.38, 29, 31), gt(4.42, 11, 13)];
}

function input(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    bands: gasLadder(),
    rung: 'confirmed',
    direction: 'up',
    magnitudePts: 0.04,
    currentTotalExposureCents: 0,
    curveKind: 'threshold',
    ...overrides,
  };
}

describe('buildThresholdCurve', () => {
  it('places each greater market at its strike with its yes mid-probability, sorted ascending', () => {
    const curve = buildThresholdCurve([gt(4.38, 29, 31), gt(4.3, 79, 81), gt(4.34, 57, 59)]);
    expect(curve).toEqual([
      { centerPts: 4.3, probability: 0.8 },
      { centerPts: 4.34, probability: 0.58 },
      { centerPts: 4.38, probability: 0.3 },
    ]);
  });

  it('treats greater_or_equal like greater', () => {
    const curve = buildThresholdCurve([gt(9, 44, 46, { strikeType: 'greater_or_equal' }), gt(12, 19, 21, { strikeType: 'greater_or_equal' })]);
    expect(curve).toEqual([
      { centerPts: 9, probability: 0.45 },
      { centerPts: 12, probability: 0.2 },
    ]);
  });

  it('converts a "less than cap" market to survival: 1 - yes probability at its cap', () => {
    const less = market({ ticker: 'L', strikeType: 'less', floorStrike: null, capStrike: 4.26, yesBidCents: 9, yesAskCents: 11 });
    const curve = buildThresholdCurve([less, gt(4.3, 79, 81)]);
    expect(curve[0].centerPts).toBe(4.26);
    expect(curve[0].probability).toBeCloseTo(0.9, 10);
    expect(curve[1]).toEqual({ centerPts: 4.3, probability: 0.8 });
  });

  it('skips between, custom and null strike types and markets without a two-sided price', () => {
    const curve = buildThresholdCurve([
      market({ ticker: 'B', strikeType: 'between', floorStrike: 1, capStrike: 2 }),
      market({ ticker: 'C', strikeType: 'custom' }),
      market({ ticker: 'N', strikeType: null }),
      gt(4.3, 79, 81, { yesBidCents: null }),
      gt(4.34, 57, 59),
    ]);
    expect(curve).toEqual([{ centerPts: 4.34, probability: 0.58 }]);
  });

  it('keeps one point per strike so interpolation never divides by zero', () => {
    const curve = buildThresholdCurve([gt(4.3, 79, 81), gt(4.3, 70, 72), gt(4.34, 57, 59)]);
    expect(curve.map((p) => p.centerPts)).toEqual([4.3, 4.34]);
  });
});

describe('thresholdCurveProblem', () => {
  it('accepts a falling survival curve and small bid/ask noise', () => {
    expect(thresholdCurveProblem(buildThresholdCurve(gasLadder()))).toBeNull();
    expect(
      thresholdCurveProblem([
        { centerPts: 1, probability: 0.5 },
        { centerPts: 2, probability: 0.55 },
      ])
    ).toBeNull();
  });

  it('rejects a curve with fewer than two points', () => {
    expect(thresholdCurveProblem([{ centerPts: 1, probability: 0.5 }])).toMatch(/at least two priced strikes/);
  });

  it('rejects a curve that rises by more than 0.10 with strike (not a survival function)', () => {
    expect(
      thresholdCurveProblem([
        { centerPts: 1, probability: 0.3 },
        { centerPts: 2, probability: 0.6 },
      ])
    ).toMatch(/not monotone/);
  });
});

describe('buildCandidatesForThreshold', () => {
  const ladder = gasLadder();
  const curve = buildThresholdCurve(ladder);

  it('direction up: the 4.38 market has a +27c YES edge and negative NO edge (hand-worked)', () => {
    const [yes, no] = buildCandidatesForThreshold(ladder[2], curve, 0.04);
    expect(yes).toMatchObject({ ticker: 'G-4.38', side: 'yes', askCents: 31, fairPriceCents: 58, edgeCents: 27 });
    expect(no).toMatchObject({ side: 'no', askCents: 71, fairPriceCents: 42, edgeCents: -29 });
  });

  it('direction down (signed -0.04): the 4.34 market has a +27c NO edge at 43c', () => {
    const [yes, no] = buildCandidatesForThreshold(ladder[1], curve, -0.04);
    expect(yes).toMatchObject({ side: 'yes', askCents: 59, fairPriceCents: 30, edgeCents: -29 });
    expect(no).toMatchObject({ ticker: 'G-4.34', side: 'no', askCents: 43, fairPriceCents: 70, edgeCents: 27 });
  });

  it('flat-holds the survival probability for a target beyond the curve', () => {
    const [yes] = buildCandidatesForThreshold(ladder[0], curve, 0.04); // target 4.26 < first point 4.30
    expect(yes).toMatchObject({ fairPriceCents: 80, edgeCents: -1 });
  });

  it('never offers an open-ended "less" market or a between band as a threshold candidate', () => {
    expect(buildCandidatesForThreshold(market({ strikeType: 'less', capStrike: 4.26 }), curve, 0.04)).toEqual([]);
    expect(buildCandidatesForThreshold(market({ strikeType: 'between', floorStrike: 1, capStrike: 2 }), curve, 0.04)).toEqual([]);
  });
});

describe('evaluateSizing with curveKind threshold', () => {
  it('picks the +27c YES edge on G-4.38 and sizes one contract (hand-worked)', () => {
    const result = evaluateSizing(input());
    expect(result).toMatchObject({
      wouldTrade: true,
      marketTicker: 'G-4.38',
      side: 'yes',
      contracts: 1,
      entryPriceCents: 31,
      notionalCents: 31,
      edgeCents: 27,
    });
  });

  it('sizes to zero at the reported rung (stake 0.25), the documented per-trade-cap effect', () => {
    const result = evaluateSizing(input({ rung: 'reported' }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/sized to zero contracts/);
  });

  it('never trades a rumor', () => {
    expect(evaluateSizing(input({ rung: 'rumor' })).wouldTrade).toBe(false);
  });

  it('declines a ladder with only one priced strike', () => {
    const result = evaluateSizing(input({ bands: [gt(4.3, 79, 81)] }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/at least two priced strikes/);
  });

  it('declines a non-monotone ladder', () => {
    const result = evaluateSizing(input({ bands: [gt(4.3, 29, 31), gt(4.34, 79, 81)] }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/not monotone/);
  });

  it('declines a magnitude larger than the ladder span', () => {
    const result = evaluateSizing(input({ magnitudePts: 0.5 }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/exceeds usable curve span/);
  });

  it('does not require the implied probabilities to sum to 1 (a survival curve sums to ~2.0 here)', () => {
    const sum = buildThresholdCurve(gasLadder()).reduce((t, p) => t + p.probability, 0);
    expect(sum).toBeGreaterThan(1.15); // would fail the band path's sanity window
    expect(evaluateSizing(input()).wouldTrade).toBe(true);
  });

  it('respects the exposure cap', () => {
    const result = evaluateSizing(input({ currentTotalExposureCents: 500 }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/exposure cap reached/);
  });

  it('applies the existing microstructure gates: a wide spread on the best market falls through to the next', () => {
    const bands = [gt(4.3, 79, 81), gt(4.34, 57, 59), gt(4.38, 20, 31), gt(4.42, 11, 13)]; // 11c spread on 4.38
    const result = evaluateSizing(input({ bands }));
    expect(result.marketTicker).not.toBe('G-4.38');
  });
});

describe('default curveKind is band and unchanged', () => {
  it('omitting curveKind equals passing "band" on a band ladder', () => {
    const bands: BandMarket[] = [
      market({ ticker: 'K-lt', strikeType: 'less', floorStrike: null, capStrike: 40.0, yesBidCents: 29, yesAskCents: 31 }),
      market({ ticker: 'K-40.0', strikeType: 'between', floorStrike: 40.0, capStrike: 40.2, yesBidCents: 34, yesAskCents: 36 }),
      market({ ticker: 'K-40.2', strikeType: 'between', floorStrike: 40.2, capStrike: 40.4, yesBidCents: 19, yesAskCents: 21 }),
      market({ ticker: 'K-40.4', strikeType: 'between', floorStrike: 40.4, capStrike: 40.6, yesBidCents: 9, yesAskCents: 11 }),
      market({ ticker: 'K-gt', strikeType: 'greater', floorStrike: 40.6, capStrike: null, yesBidCents: 4, yesAskCents: 6 }),
    ];
    const base: SizingInput = { bands, rung: 'confirmed', direction: 'up', magnitudePts: 0.2, currentTotalExposureCents: 0 };
    expect(evaluateSizing(base)).toEqual(evaluateSizing({ ...base, curveKind: 'band' }));
  });
});

describe('evaluateBinarySizing', () => {
  const m = market({ ticker: 'KXUSAIRANAGREEMENT-27-26NOV', strikeType: null, yesBidCents: 38, yesAskCents: 40, yesAskSizeContracts: 50, yesBidSizeContracts: 70 });

  it('direction up buys one YES contract at the yes ask', () => {
    expect(evaluateBinarySizing({ market: m, direction: 'up', rung: 'reported' })).toMatchObject({
      wouldTrade: true,
      marketTicker: 'KXUSAIRANAGREEMENT-27-26NOV',
      side: 'yes',
      contracts: 1,
      entryPriceCents: 40,
      notionalCents: 40,
      edgeCents: null,
    });
  });

  it('direction down buys one NO contract at 100 - yes bid', () => {
    expect(evaluateBinarySizing({ market: m, direction: 'down', rung: 'reported' })).toMatchObject({
      wouldTrade: true,
      side: 'no',
      contracts: 1,
      entryPriceCents: 62,
      notionalCents: 62,
    });
  });

  it('never trades a rumor', () => {
    const r = evaluateBinarySizing({ market: m, direction: 'up', rung: 'rumor' });
    expect(r.wouldTrade).toBe(false);
    expect(r.reason).toMatch(/rumor/);
  });

  it('declines a wide spread', () => {
    const r = evaluateBinarySizing({ market: market({ yesBidCents: 40, yesAskCents: 50 }), direction: 'up', rung: 'reported' });
    expect(r.wouldTrade).toBe(false);
    expect(r.reason).toMatch(/spread 10c exceeds 5c/);
  });

  it('declines a price outside the tradeable range on either side', () => {
    const cheap = evaluateBinarySizing({ market: market({ yesBidCents: 3, yesAskCents: 5 }), direction: 'up', rung: 'reported' });
    expect(cheap.reason).toMatch(/price 5c outside tradeable range \[10,90\]/);
    const noSideTooDear = evaluateBinarySizing({ market: market({ yesBidCents: 3, yesAskCents: 5 }), direction: 'down', rung: 'reported' });
    expect(noSideTooDear.reason).toMatch(/price 97c outside tradeable range/);
  });

  it('declines when the side has no depth', () => {
    const r = evaluateBinarySizing({ market: market({ yesAskSizeContracts: 0 }), direction: 'up', rung: 'reported' });
    expect(r.wouldTrade).toBe(false);
    expect(r.reason).toMatch(/depth 0 below minimum 1/);
  });

  it('declines a one-sided or missing quote and an inactive market', () => {
    expect(evaluateBinarySizing({ market: market({ yesBidCents: null }), direction: 'down', rung: 'reported' }).reason).toMatch(/two-sided/);
    expect(evaluateBinarySizing({ market: market({ yesAskCents: null }), direction: 'up', rung: 'reported' }).reason).toMatch(/two-sided/);
    const closed = evaluateBinarySizing({ market: market({ status: 'closed' }), direction: 'up', rung: 'reported' });
    expect(closed.wouldTrade).toBe(false);
    expect(closed.reason).toMatch(/not active/);
  });
});
