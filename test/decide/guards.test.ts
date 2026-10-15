// test/decide/guards.test.ts
import { describe, it, expect } from 'vitest';
import {
  ladderIqr,
  shiftProblem,
  tailEdgeProblem,
  stackingHeadroomContracts,
  paperGuardsFromEnv,
  PAPER_GUARDS,
} from '../../src/decide/guards.js';
import { evaluateSizing, evaluateMultiSizing, buildThresholdCurve, type SizingInput } from '../../src/decide/sizing.js';
import type { BandMarket } from '../../src/decide/kalshi.js';

function gt(strike: number, bid: number, ask: number, askSize = 500, bidSize = 500): BandMarket {
  return {
    ticker: `G-${strike.toFixed(2)}`, floorStrike: strike, capStrike: null, strikeType: 'greater', status: 'active',
    yesAskCents: ask, yesBidCents: bid, yesAskSizeContracts: askSize, yesBidSizeContracts: bidSize,
  };
}

/** The real KXAAAGASW-26OCT19 ladder at 2026-10-14 07:30Z, when the bot bought 20 NO at 11c on the 4.26 rung. */
function aaaLadder(): BandMarket[] {
  const rows: Array<[number, number, number, number, number]> = [
    [4.44, 1, 2, 3047, 1258], [4.42, 2, 3, 2036, 1328], [4.4, 1, 3, 1067, 3451], [4.38, 3, 4, 1025, 853], [4.36, 7, 9, 313, 1032],
    [4.34, 10, 12, 103, 551], [4.32, 24, 25, 105, 60], [4.3, 45, 48, 321, 433], [4.28, 79, 80, 3, 309], [4.26, 89, 90, 199, 102],
    [4.24, 98, 99, 1073, 2574], [4.22, 98, 99, 1361, 2702], [4.2, 99, 100, 0, 2038], [4.18, 99, 100, 0, 2533], [4.16, 99, 100, 0, 2522],
  ];
  return rows.map(([s, b, a, as, bs]) => gt(s, b, a, as, bs));
}

function sizingInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    bands: aaaLadder(), rung: 'confirmed', direction: 'down', magnitudePts: 0.1, currentTotalExposureCents: 0,
    curveKind: 'threshold', caps: { perTradeCents: 1000, totalExposureCents: 5000 }, ...overrides,
  };
}

describe('ladderIqr', () => {
  it('measures the interquartile width of the settlement quantity from a survival curve', () => {
    const curve = buildThresholdCurve(aaaLadder());
    const iqr = ladderIqr(curve, 'threshold');
    expect(iqr).not.toBeNull();
    // P(>x)=0.75 near 4.28, P(>x)=0.25 near 4.32: a few cents, nowhere near the 0.1 the model asked for.
    expect(iqr!).toBeGreaterThan(0.02);
    expect(iqr!).toBeLessThan(0.08);
  });

  it('is null for a curve it cannot measure', () => {
    expect(ladderIqr([], 'threshold')).toBeNull();
    expect(ladderIqr([{ centerPts: 1, probability: 0.5 }], 'threshold')).toBeNull();
    expect(ladderIqr([{ centerPts: 1, probability: 0.5 }, { centerPts: 2, probability: 0.5 }], 'threshold')).toBeNull();
  });

  it('works on a band curve of probability mass', () => {
    const iqr = ladderIqr(
      [
        { centerPts: 1, probability: 0.1 }, { centerPts: 2, probability: 0.4 }, { centerPts: 3, probability: 0.4 }, { centerPts: 4, probability: 0.1 },
      ],
      'band'
    );
    expect(iqr).toBeGreaterThan(0.5);
    expect(iqr).toBeLessThan(2.5);
  });
});

describe('shiftProblem / tailEdgeProblem / stackingHeadroomContracts', () => {
  const curve = buildThresholdCurve(aaaLadder());
  it('declines a shift far wider than the market and accepts a modest one', () => {
    expect(shiftProblem(curve, 'threshold', -0.1, PAPER_GUARDS)).toMatch(/interquartile/);
    expect(shiftProblem(curve, 'threshold', 0.1, PAPER_GUARDS)).toMatch(/interquartile/);
    expect(shiftProblem(curve, 'threshold', -0.02, PAPER_GUARDS)).toBeNull();
  });
  it('never blocks when the ladder has no measurable spread', () => {
    expect(shiftProblem([], 'threshold', 5, PAPER_GUARDS)).toBeNull();
  });
  it('declines only cheap contracts claiming a huge edge', () => {
    expect(tailEdgeProblem(11, 81, PAPER_GUARDS)).toMatch(/tail bet declined/);
    expect(tailEdgeProblem(15, 75, PAPER_GUARDS)).toMatch(/tail bet declined/);
    expect(tailEdgeProblem(16, 90, PAPER_GUARDS)).toBeNull(); // not a cheap tail
    expect(tailEdgeProblem(11, 74, PAPER_GUARDS)).toBeNull(); // edge not implausible enough
    expect(tailEdgeProblem(40, 20, PAPER_GUARDS)).toBeNull();
  });
  it('computes how many more contracts fit under the per-market cap', () => {
    expect(stackingHeadroomContracts(0, 30, PAPER_GUARDS)).toBe(10); // 300 / 30
    expect(stackingHeadroomContracts(240, 30, PAPER_GUARDS)).toBe(2);
    expect(stackingHeadroomContracts(300, 30, PAPER_GUARDS)).toBe(0);
    expect(stackingHeadroomContracts(900, 30, PAPER_GUARDS)).toBe(0);
    expect(stackingHeadroomContracts(0, 0, PAPER_GUARDS)).toBe(0);
  });
});

describe('paperGuardsFromEnv', () => {
  it('defaults, overrides per field, ignores junk, and switches off', () => {
    expect(paperGuardsFromEnv({})).toEqual(PAPER_GUARDS);
    expect(paperGuardsFromEnv({ PAPER_GUARD_MAX_SHIFT_IQR: '3', PAPER_GUARD_MAX_MARKET_COST_CENTS: '500' })).toEqual({
      ...PAPER_GUARDS, maxShiftIqrMultiple: 3, maxMarketCostCents: 500,
    });
    expect(paperGuardsFromEnv({ PAPER_GUARD_TAIL_MAX_ASK_CENTS: 'abc', PAPER_GUARD_TAIL_MIN_EDGE_CENTS: '-4' })).toEqual(PAPER_GUARDS);
    expect(paperGuardsFromEnv({ PAPER_GUARDS: 'off' })).toBeNull();
  });
});

describe('evaluateSizing with paper guards: the 2026-10-14 AAA gas entry', () => {
  it('without guards the bot buys NO on the rung the market has at 89% YES (the bug)', () => {
    const r = evaluateSizing(sizingInput());
    expect(r.wouldTrade).toBe(true);
    expect(r.side).toBe('no');
    expect(r.marketTicker).toBe('G-4.26');
    expect(r.entryPriceCents).toBe(11);
    expect(r.edgeCents!).toBeGreaterThan(75);
  });

  it('with guards the same call is declined (shift 0.1 is several times the market width)', () => {
    const r = evaluateSizing(sizingInput({ guards: PAPER_GUARDS }));
    expect(r.wouldTrade).toBe(false);
    expect(r.reason).toMatch(/interquartile/);
  });

  it('with guards a modest shift still trades, and the tail rule is what stops a cheap huge-edge rung', () => {
    const modest = evaluateSizing(sizingInput({ guards: PAPER_GUARDS, magnitudePts: 0.03, direction: 'down' }));
    expect(modest.wouldTrade).toBe(true);
    // Loosen the shift rule only: the 11c / 81c tail is still refused by the tail rule.
    const tailOnly = evaluateSizing(sizingInput({ guards: { ...PAPER_GUARDS, maxShiftIqrMultiple: 100 } }));
    expect(tailOnly.marketTicker).not.toBe('G-4.26');
    if (!tailOnly.wouldTrade) expect(tailOnly.reason).toMatch(/tail bet declined|per-market cap|price/);
    else expect(tailOnly.entryPriceCents! > PAPER_GUARDS.tailMaxAskCents || tailOnly.edgeCents! < PAPER_GUARDS.tailMinEdgeCents).toBe(true);
  });

  it('caps stacking: contracts shrink to the headroom left on the market, and a full market is skipped', () => {
    const base = sizingInput({ guards: PAPER_GUARDS, magnitudePts: 0.03 });
    const fresh = evaluateSizing(base);
    expect(fresh.wouldTrade).toBe(true);
    const ticker = fresh.marketTicker!;
    const price = fresh.entryPriceCents!;
    const room = Math.floor(PAPER_GUARDS.maxMarketCostCents / price);
    expect(fresh.contracts).toBeLessThanOrEqual(room);

    const nearlyFull = evaluateSizing({ ...base, openCostByMarket: new Map([[ticker, PAPER_GUARDS.maxMarketCostCents - price]]) });
    if (nearlyFull.wouldTrade && nearlyFull.marketTicker === ticker) expect(nearlyFull.contracts).toBe(1);

    const full = evaluateSizing({ ...base, openCostByMarket: new Map([[ticker, PAPER_GUARDS.maxMarketCostCents]]) });
    expect(full.marketTicker === ticker && full.wouldTrade).toBe(false);
  });

  it('is byte-for-byte unchanged when guards are omitted (the live path)', () => {
    const a = evaluateSizing(sizingInput());
    const b = evaluateSizing(sizingInput({ openCostByMarket: new Map([['G-4.26', 99999]]) }));
    expect(b).toEqual(a);
  });
});

describe('evaluateMultiSizing with paper guards', () => {
  const markets: BandMarket[] = [
    { ticker: 'A', floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active', yesAskCents: 12, yesBidCents: 10, yesAskSizeContracts: 400, yesBidSizeContracts: 400 },
    { ticker: 'B', floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active', yesAskCents: 42, yesBidCents: 40, yesAskSizeContracts: 400, yesBidSizeContracts: 400 },
  ];
  const base = {
    markets, maxLegs: 2 as const, rung: 'confirmed' as const, currentTotalExposureCents: 0,
    caps: { perTradeCents: 1000, totalExposureCents: 5000 },
  };

  it('declines a cheap tail leg with a huge claimed edge and keeps the sane one', () => {
    const moves = [{ market: 'A', shift: 88, confidence: 1 }, { market: 'B', shift: 20, confidence: 1 }];
    const open = evaluateMultiSizing({ ...base, moves });
    expect(open.legs.map((l) => l.marketTicker)).toContain('A');
    const guarded = evaluateMultiSizing({ ...base, moves, guards: PAPER_GUARDS });
    expect(guarded.legs.map((l) => l.marketTicker)).toEqual(['B']);
    expect(guarded.reasons.join(' ')).toMatch(/tail bet declined/);
  });

  it('clamps a leg to the per-market headroom and skips a full market', () => {
    const moves = [{ market: 'B', shift: 20, confidence: 1 }];
    const free = evaluateMultiSizing({ ...base, moves, guards: PAPER_GUARDS });
    expect(free.legs[0].contracts).toBeLessThanOrEqual(Math.floor(PAPER_GUARDS.maxMarketCostCents / 42));
    const limited = evaluateMultiSizing({ ...base, moves, guards: PAPER_GUARDS, openCostByMarket: new Map([['B', 300 - 42]]) });
    expect(limited.legs[0].contracts).toBe(1);
    const full = evaluateMultiSizing({ ...base, moves, guards: PAPER_GUARDS, openCostByMarket: new Map([['B', 300]]) });
    expect(full.legs).toHaveLength(0);
    expect(full.reasons.join(' ')).toMatch(/per-market cap/);
  });
});
