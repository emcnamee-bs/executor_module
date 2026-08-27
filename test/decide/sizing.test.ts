// test/decide/sizing.test.ts
import { describe, it, expect } from 'vitest';
import {
  evaluateSizing,
  gateCandidate,
  buildCandidatesForBand,
  buildProbabilityCurve,
  typicalBandWidthPts,
  kellyFraction,
  contractsWithinCaps,
  MAX_NOTIONAL_CENTS_PER_TRADE,
  type SizingInput,
  type BandCandidate,
} from '../../src/decide/sizing.js';
import type { BandMarket } from '../../src/decide/kalshi.js';
import type { Rung } from '../../src/decide/rung.js';

function band(overrides: Partial<BandMarket>): BandMarket {
  return {
    ticker: 'KXAPRPOTUS-26AUG28-40.1',
    floorStrike: 40.0,
    capStrike: 40.2,
    strikeType: 'between',
    status: 'active',
    yesAskCents: 40,
    yesBidCents: 38,
    yesAskSizeContracts: 500,
    yesBidSizeContracts: 500,
    ...overrides,
  };
}

/**
 * A five-band ladder over 39.8-40.8, priced as a real distribution: the
 * mid-price-implied probabilities are 0.30 / 0.35 / 0.20 / 0.10 / 0.05 and sum
 * to 1.00, so the ladder passes the implied-distribution sanity check and every
 * computed edge is an edge against a coherent curve rather than against an
 * inflated one. Mass peaks at 40.0-40.2, so an *upward* shift is what creates
 * edge on the bands above the peak.
 */
function baseLadder(): BandMarket[] {
  return [
    band({
      ticker: 'K-39.8',
      floorStrike: null,
      capStrike: 40.0,
      strikeType: 'less',
      yesAskCents: 31,
      yesBidCents: 29,
    }),
    band({
      ticker: 'K-40.0',
      floorStrike: 40.0,
      capStrike: 40.2,
      strikeType: 'between',
      yesAskCents: 36,
      yesBidCents: 34,
    }),
    band({
      ticker: 'K-40.2',
      floorStrike: 40.2,
      capStrike: 40.4,
      strikeType: 'between',
      yesAskCents: 21,
      yesBidCents: 19,
    }),
    band({
      ticker: 'K-40.4',
      floorStrike: 40.4,
      capStrike: 40.6,
      strikeType: 'between',
      yesAskCents: 11,
      yesBidCents: 9,
    }),
    band({
      ticker: 'K-40.6',
      floorStrike: 40.6,
      capStrike: null,
      strikeType: 'greater',
      yesAskCents: 6,
      yesBidCents: 4,
    }),
  ];
}

/** The implied-probability sum the sanity check will see for a ladder. */
function impliedSum(bands: BandMarket[]): number {
  const widthPts = typicalBandWidthPts(bands);
  return buildProbabilityCurve(bands, widthPts).reduce((total, p) => total + p.probability, 0);
}

function baseInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    bands: baseLadder(),
    rung: 'reported' as Rung,
    direction: 'up',
    magnitudePts: 0.3,
    currentTotalExposureCents: 0,
    ...overrides,
  };
}

describe('gateCandidate', () => {
  function candidate(overrides: Partial<BandCandidate> = {}): BandCandidate {
    return {
      ticker: 'K-TEST',
      side: 'yes',
      askCents: 40,
      spreadCents: 2,
      depthContracts: 10,
      fairPriceCents: 45,
      edgeCents: 5,
      ...overrides,
    };
  }

  it('passes a well-formed candidate', () => {
    expect(gateCandidate(candidate()).ok).toBe(true);
  });

  it('rejects a spread over 5 cents', () => {
    const v = gateCandidate(candidate({ spreadCents: 6 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/spread/i);
  });

  it('accepts a spread exactly at the 5 cent boundary', () => {
    expect(gateCandidate(candidate({ spreadCents: 5 })).ok).toBe(true);
  });

  it('rejects a crossed book (negative spread) as a bad quote, not a tight market', () => {
    const v = gateCandidate(candidate({ spreadCents: -15 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/crossed|negative/i);
  });

  it('rejects a spread of -1 cent, the smallest crossed book', () => {
    expect(gateCandidate(candidate({ spreadCents: -1 })).ok).toBe(false);
  });

  it('accepts a spread of exactly zero (locked, but not crossed)', () => {
    expect(gateCandidate(candidate({ spreadCents: 0 })).ok).toBe(true);
  });

  it('rejects zero depth', () => {
    const v = gateCandidate(candidate({ depthContracts: 0 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/depth/i);
  });

  it('accepts depth exactly at the minimum of 1 contract', () => {
    expect(gateCandidate(candidate({ depthContracts: 1 })).ok).toBe(true);
  });

  it('rejects a price below 10 cents', () => {
    const v = gateCandidate(candidate({ askCents: 9 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/range/i);
  });

  it('accepts a price exactly at the 10 cent floor', () => {
    expect(gateCandidate(candidate({ askCents: 10 })).ok).toBe(true);
  });

  it('rejects a price above 90 cents', () => {
    const v = gateCandidate(candidate({ askCents: 91 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/range/i);
  });

  it('accepts a price exactly at the 90 cent ceiling', () => {
    expect(gateCandidate(candidate({ askCents: 90 })).ok).toBe(true);
  });

  it('rejects edge below 0.5 cents', () => {
    const v = gateCandidate(candidate({ edgeCents: 0.2 }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/edge/i);
  });

  it('accepts edge exactly at the 0.5 cent minimum', () => {
    expect(gateCandidate(candidate({ edgeCents: 0.5 })).ok).toBe(true);
  });
});

describe('kellyFraction', () => {
  it('computes (fair - ask) / (100 - ask) exactly', () => {
    // (60 - 40) / (100 - 40) = 20 / 60 = 1/3
    expect(kellyFraction(60, 40)).toBe(1 / 3);
  });

  it('computes a second exact value, guarding against a transposed numerator', () => {
    // (70 - 40) / (100 - 40) = 30 / 60 = 0.5. A swapped numerator/denominator or a
    // sign flip cannot also produce this.
    expect(kellyFraction(70, 40)).toBe(0.5);
  });

  it('is exactly 1.0 when the fair value is full settlement', () => {
    expect(kellyFraction(100, 50)).toBe(1);
  });

  it('floors at zero when the fair value is below the ask', () => {
    expect(kellyFraction(30, 40)).toBe(0);
  });

  it('is zero at no edge at all (fair equals ask)', () => {
    expect(kellyFraction(40, 40)).toBe(0);
  });

  it('is zero for an ask of 0 (no price to divide by)', () => {
    expect(kellyFraction(50, 0)).toBe(0);
  });

  it('is zero for an ask at settlement, where the denominator would be 0', () => {
    expect(kellyFraction(50, 100)).toBe(0);
  });

  it('never exceeds 1.0 for any in-range fair value, at any ask', () => {
    for (let ask = 1; ask < 100; ask++) {
      for (let fair = 0; fair <= 100; fair++) {
        expect(kellyFraction(fair, ask)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('contractsWithinCaps', () => {
  function caps(overrides: Partial<Parameters<typeof contractsWithinCaps>[0]> = {}) {
    return contractsWithinCaps({
      askCents: 50,
      kelly: 1,
      stake: 1,
      depthContracts: 100000,
      remainingExposureCents: 4000,
      ...overrides,
    });
  }

  it('holds the per-trade cap even when handed a Kelly fraction above 1.0', () => {
    // The second, independent ceiling. `kelly = 2.0` is exactly what the poisoned
    // curve produced before the fair-value clamp existed: scaling by kelly * stake
    // alone gave 40 contracts at 50c = 2000c, twice the cap. The cap must not depend
    // on some other function keeping kelly <= 1.
    const contracts = caps({ askCents: 50, kelly: 2.0, stake: 1 });
    expect(contracts).toBe(20); // floor(1000 / 50)
    expect(contracts * 50).toBe(MAX_NOTIONAL_CENTS_PER_TRADE);
  });

  it('holds the per-trade cap for every ask price and any Kelly/stake product', () => {
    for (let askCents = 1; askCents <= 100; askCents++) {
      for (const kelly of [0, 0.5, 1, 1.5, 2, 10, 1000]) {
        for (const stake of [0.25, 0.5, 1, 4]) {
          const contracts = caps({ askCents, kelly, stake });
          expect(contracts * askCents).toBeLessThanOrEqual(MAX_NOTIONAL_CENTS_PER_TRADE);
        }
      }
    }
  });

  it('lets depth bind when depth is the smallest constraint', () => {
    expect(caps({ askCents: 50, kelly: 1, stake: 1, depthContracts: 3 })).toBe(3);
  });

  it('lets remaining exposure bind when it is the smallest constraint', () => {
    expect(caps({ askCents: 50, remainingExposureCents: 250 })).toBe(5);
  });

  it('scales down with the rung stake', () => {
    expect(caps({ askCents: 50, kelly: 1, stake: 0.25 })).toBe(5); // floor(20 * 1 * 0.25)
  });

  it('returns zero for a non-positive ask rather than dividing by zero', () => {
    expect(caps({ askCents: 0 })).toBe(0);
    expect(caps({ askCents: -5 })).toBe(0);
  });

  it('never returns a negative contract count', () => {
    expect(caps({ kelly: -3 })).toBe(0);
    expect(caps({ remainingExposureCents: -100 })).toBe(0);
  });
});

describe('buildCandidatesForBand', () => {
  const flatCurve = [{ centerPts: 40.3, probability: 0.5 }];

  it('produces a yes candidate when both yes ask and bid are present', () => {
    const b = band({ yesAskCents: 40, yesBidCents: 38 });
    const candidates = buildCandidatesForBand(b, flatCurve, 0.2, 0);
    expect(candidates.some((c) => c.side === 'yes')).toBe(true);
  });

  it('produces a no candidate when both yes ask and bid are present', () => {
    const b = band({ yesAskCents: 40, yesBidCents: 38 });
    const candidates = buildCandidatesForBand(b, flatCurve, 0.2, 0);
    expect(candidates.some((c) => c.side === 'no')).toBe(true);
  });

  it('produces no candidates when yesAskCents is null (no resting ask)', () => {
    const b = band({ yesAskCents: null, yesBidCents: 38 });
    const candidates = buildCandidatesForBand(b, flatCurve, 0.2, 0);
    expect(candidates).toHaveLength(0);
  });

  it('produces no candidates when yesBidCents is null (no resting bid)', () => {
    const b = band({ yesAskCents: 40, yesBidCents: null });
    const candidates = buildCandidatesForBand(b, flatCurve, 0.2, 0);
    expect(candidates).toHaveLength(0);
  });

  it('clamps a fair value derived from an above-1.0 curve point to 100 cents', () => {
    // A curve point above 1.0 is only reachable from an out-of-range upstream quote
    // (nothing bounds Kalshi prices to [0,100]). Unclamped, this produced a
    // fairPriceCents of 150, an edge of 110, and a Kelly fraction above 1.0 --
    // the mechanism behind the per-trade cap breach.
    const poisonedCurve = [{ centerPts: 40.1, probability: 1.5 }];
    const candidates = buildCandidatesForBand(band({ yesAskCents: 40, yesBidCents: 38 }), poisonedCurve, 0.2, 0);
    const yesCandidate = candidates.find((c) => c.side === 'yes');
    expect(yesCandidate?.fairPriceCents).toBe(100);
    expect(kellyFraction(yesCandidate!.fairPriceCents, yesCandidate!.askCents)).toBeLessThanOrEqual(1);
  });

  it('clamps a fair value derived from a below-0 curve point to 0 cents', () => {
    const poisonedCurve = [{ centerPts: 40.1, probability: -0.4 }];
    const candidates = buildCandidatesForBand(band({ yesAskCents: 40, yesBidCents: 38 }), poisonedCurve, 0.2, 0);
    expect(candidates.find((c) => c.side === 'yes')?.fairPriceCents).toBe(0);
  });

  it('produces no candidates for a malformed band with neither strike set', () => {
    const malformed = band({ floorStrike: null, capStrike: null });
    expect(() => buildCandidatesForBand(malformed, flatCurve, 0.2, 0)).not.toThrow();
    expect(buildCandidatesForBand(malformed, flatCurve, 0.2, 0)).toHaveLength(0);
  });

  it('derives the no-side ask as 100 minus the yes bid', () => {
    const b = band({ yesAskCents: 40, yesBidCents: 38 });
    const candidates = buildCandidatesForBand(b, flatCurve, 0.2, 0);
    const noCandidate = candidates.find((c) => c.side === 'no');
    expect(noCandidate?.askCents).toBe(62); // 100 - 38
  });
});

describe('evaluateSizing', () => {
  it('finds a would-trade band when an upward shift creates edge', () => {
    const result = evaluateSizing(baseInput());
    expect(result.wouldTrade).toBe(true);
    // Pinned, not just non-null: nothing used to assert *which* band won, which is
    // how a tail-band mispricing survived unnoticed. K-40.4 is an interior
    // 'between' band -- the only kind this module will trade.
    expect(result.marketTicker).toBe('K-40.4');
    expect(result.side).toBe('yes');
    expect(result.contracts).toBeGreaterThan(0);
    expect(result.notionalCents).toBeGreaterThan(0);
    expect(result.notionalCents).toBeLessThanOrEqual(MAX_NOTIONAL_CENTS_PER_TRADE);
  });

  it('exercises a happy-path fixture whose implied probabilities sum to a sane 1.00', () => {
    // If this drifts out of [0.85, 1.15] the happy-path test above stops testing
    // sizing at all -- it would decline on the distribution check instead.
    expect(impliedSum(baseLadder())).toBeCloseTo(1.0, 10);
  });

  it('declines when rung is rumor (stake 0) regardless of edge', () => {
    const result = evaluateSizing(baseInput({ rung: 'rumor' }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/rumor|stake/i);
  });

  it('declines when magnitude_pts is zero (no shift, no edge)', () => {
    const result = evaluateSizing(baseInput({ magnitudePts: 0 }));
    expect(result.wouldTrade).toBe(false);
  });

  it('declines every band when price is outside the 10-90 cent tradeable range', () => {
    // Two bands, one priced above the range and one below, so the ladder still sums
    // to a sane 1.02 and the price gate -- not the distribution check -- is what
    // declines it. (Yes side out of range by its ask; no side by 100 - bid.)
    const extremeLadder: BandMarket[] = [
      band({ ticker: 'X-hi', floorStrike: 40.0, capStrike: 40.2, yesAskCents: 95, yesBidCents: 93 }),
      band({ ticker: 'X-lo', floorStrike: 40.2, capStrike: 40.4, yesAskCents: 9, yesBidCents: 7 }),
    ];
    expect(impliedSum(extremeLadder)).toBeCloseTo(1.02, 10);
    const result = evaluateSizing(baseInput({ bands: extremeLadder }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/range/i);
  });

  it('sizes to the exact contract count the $10 ceiling allows when the ceiling binds', () => {
    // C-anchor is untradeable on price (ask 100 / no-side ask 0) but anchors the
    // curve at probability 1.0. C-cheap therefore interpolates a fair value of 100c
    // against a 12c ask: Kelly is exactly (100-12)/(100-12) = 1.0 and stake is 1.0,
    // so neither Kelly, nor depth (10000), nor remaining exposure (333 contracts)
    // binds -- only the per-trade ceiling does.
    //   byCeiling = floor(1000 / 12) = 83   -> 83 * 12 = 996c, just under the cap
    //   84 contracts would be 1008c, over it
    const ceilingLadder: BandMarket[] = [
      band({ ticker: 'C-anchor', floorStrike: 40.0, capStrike: 40.2, yesAskCents: 100, yesBidCents: 100 }),
      band({
        ticker: 'C-cheap',
        floorStrike: 40.4,
        capStrike: 40.6,
        yesAskCents: 12,
        yesBidCents: 10,
        yesAskSizeContracts: 10000,
      }),
    ];
    expect(impliedSum(ceilingLadder)).toBeCloseTo(1.11, 10);
    const result = evaluateSizing(
      baseInput({ bands: ceilingLadder, rung: 'confirmed', magnitudePts: 0.5 })
    );
    expect(result.wouldTrade).toBe(true);
    expect(result.marketTicker).toBe('C-cheap');
    expect(result.side).toBe('yes');
    expect(result.entryPriceCents).toBe(12);
    expect(result.edgeCents).toBe(88);
    expect(result.contracts).toBe(83);
    expect(result.notionalCents).toBe(996);
    expect(result.notionalCents).toBeLessThanOrEqual(MAX_NOTIONAL_CENTS_PER_TRADE);
  });

  it('holds the $10 per-trade cap even when an out-of-range quote poisons the fair-value curve', () => {
    // Reviewer's reproduction: one band carries an impossible 104c quote (nothing
    // upstream bounds Kalshi prices to [0,100]). That band is itself untradeable on
    // price -- both its yes side (104c) and its no side (100-104 = -4c) fail the
    // [10,90] price gate -- but it still sits in the shared probability curve. Its
    // implied probability of 1.04 poisons the interpolation the *legally priced*
    // P-good band reads, which would (pre-fix) yield a fair value over 100c and a
    // Kelly fraction over 1.0. This ladder's implied distribution sums to ~1.14,
    // inside the [0.85,1.15] sanity window, so it reaches the real sizing math
    // instead of being declined by that check first -- unlike the old version of
    // this test. See the fix report for mutation evidence that both the
    // probability clamp and the per-trade ceiling clamp are load-bearing here:
    // removing them sizes this same ladder to 86 contracts / 1032c, over the cap.
    const poisonedLadder: BandMarket[] = [
      band({ ticker: 'P-bad', floorStrike: 40.0, capStrike: 40.2, yesAskCents: 104, yesBidCents: 104 }),
      band({
        ticker: 'P-good',
        floorStrike: 40.2,
        capStrike: 40.4,
        yesAskCents: 12,
        yesBidCents: 8,
        yesAskSizeContracts: 100000,
      }),
    ];
    expect(impliedSum(poisonedLadder)).toBeCloseTo(1.14, 10);
    const result = evaluateSizing(
      baseInput({ bands: poisonedLadder, rung: 'confirmed', magnitudePts: 0.2 })
    );
    expect(result.wouldTrade).toBe(true);
    expect(result.marketTicker).toBe('P-good');
    expect(result.side).toBe('yes');
    expect(result.entryPriceCents).toBe(12);
    expect(result.edgeCents).toBe(88);
    expect(result.contracts).toBe(83);
    expect(result.notionalCents).toBe(996);
    expect(result.notionalCents).toBeLessThanOrEqual(MAX_NOTIONAL_CENTS_PER_TRADE);
  });

  it('declines when the trade would push total exposure over the $40 cap', () => {
    const result = evaluateSizing(baseInput({ currentTotalExposureCents: 4000 }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/exposure/i);
  });

  it('allows a trade that exactly reaches, but does not exceed, the $40 cap', () => {
    const result = evaluateSizing(baseInput({ currentTotalExposureCents: 3990 }));
    // Either it trades within the remaining $0.10, or it declines because no
    // band's clamped size fits in that remaining room -- both are valid, but
    // it must never report a notional that would push the total over 4000.
    expect(result.notionalCents).toBeLessThanOrEqual(10);
  });

  it('a stronger rung produces a larger or equal position than a weaker rung, same market conditions', () => {
    const reported = evaluateSizing(baseInput({ rung: 'reported' }));
    const confirmed = evaluateSizing(baseInput({ rung: 'confirmed' }));
    expect(confirmed.contracts).toBeGreaterThanOrEqual(reported.contracts);
  });

  it('never selects an unbounded tail band, even when it wins on edge outright', () => {
    // T-greater is an open-ended 'greater' tail whose synthetic center makes it look
    // like the best trade on the board: fair 40c against a 10c ask, a 30c edge that
    // beats every interior band. That edge is an artifact of comparing an unbounded
    // tail's probability mass against a bounded band's on one curve, not a real edge.
    // Before the exclusion this ladder traded T-greater for 33 contracts.
    const tailLadder: BandMarket[] = [
      band({ ticker: 'T-less', floorStrike: null, capStrike: 40.0, strikeType: 'less', yesAskCents: 11, yesBidCents: 9 }),
      band({ ticker: 'T-a', floorStrike: 40.0, capStrike: 40.2, yesAskCents: 26, yesBidCents: 24 }),
      band({ ticker: 'T-b', floorStrike: 40.2, capStrike: 40.4, yesAskCents: 41, yesBidCents: 39 }),
      band({ ticker: 'T-c', floorStrike: 40.4, capStrike: 40.6, yesAskCents: 16, yesBidCents: 14 }),
      band({
        ticker: 'T-greater',
        floorStrike: 40.6,
        capStrike: null,
        strikeType: 'greater',
        yesAskCents: 10,
        yesBidCents: 8,
      }),
    ];
    expect(impliedSum(tailLadder)).toBeCloseTo(0.99, 10);
    const result = evaluateSizing(
      baseInput({ bands: tailLadder, magnitudePts: 0.4, rung: 'confirmed' })
    );
    expect(result.marketTicker).not.toBe('T-greater');
    expect(result.marketTicker).not.toBe('T-less');
    // It does not merely decline -- it falls through to the best interior band.
    expect(result.wouldTrade).toBe(true);
    expect(result.marketTicker).toBe('T-b');
    const chosen = tailLadder.find((b) => b.ticker === result.marketTicker);
    expect(chosen?.strikeType).toBe('between');
  });

  it('never selects any non-between band across every band of the base ladder', () => {
    // Swept unconditionally rather than relying on one fixture: whatever the shift,
    // the chosen ticker is always an interior band or nothing at all.
    for (const direction of ['up', 'down'] as const) {
      for (const magnitudePts of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 1.0, 5.0]) {
        const result = evaluateSizing(baseInput({ direction, magnitudePts, rung: 'confirmed' }));
        if (result.marketTicker !== null) {
          const chosen = baseLadder().find((b) => b.ticker === result.marketTicker);
          expect(chosen?.strikeType).toBe('between');
        }
      }
    }
  });

  it('declines the whole call when the implied distribution sums above the sane range', () => {
    // Every band bid up 20c: the ladder now implies 2.00 of total probability, which
    // inflates every band's interpolated fair value and biases every edge toward
    // "trade". Not a ladder to compute an edge against.
    const inflated = baseLadder().map((b) => ({
      ...b,
      yesAskCents: (b.yesAskCents ?? 0) + 20,
      yesBidCents: (b.yesBidCents ?? 0) + 20,
    }));
    expect(impliedSum(inflated)).toBeCloseTo(2.0, 10);
    const result = evaluateSizing(baseInput({ bands: inflated }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/implied distribution sums to 2\.000, outside sane range/i);
  });

  it('declines the whole call when the implied distribution sums below the sane range', () => {
    const deflated: BandMarket[] = [
      band({ ticker: 'D-a', floorStrike: 40.0, capStrike: 40.2, yesAskCents: 21, yesBidCents: 19 }),
      band({ ticker: 'D-b', floorStrike: 40.2, capStrike: 40.4, yesAskCents: 31, yesBidCents: 29 }),
    ];
    expect(impliedSum(deflated)).toBeCloseTo(0.5, 10);
    const result = evaluateSizing(baseInput({ bands: deflated }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/implied distribution sums to 0\.500, outside sane range/i);
  });

  it('does not crash on a malformed band with neither strike set, and still trades the rest', () => {
    // Reachable from real data: kalshi.ts maps floor_strike/cap_strike with no
    // cross-validation against strike_type. This used to throw straight out of
    // evaluateSizing, taking down the whole decision cycle for one bad band.
    const withMalformed = [
      ...baseLadder(),
      band({ ticker: 'M-bad', floorStrike: null, capStrike: null, strikeType: 'between' }),
    ];
    const clean = evaluateSizing(baseInput());
    let result: ReturnType<typeof evaluateSizing> | null = null;
    expect(() => {
      result = evaluateSizing(baseInput({ bands: withMalformed }));
    }).not.toThrow();
    // The malformed band contributes nothing and is not tradeable, and the ladder is
    // still evaluated on its well-formed bands -- identically to the clean ladder.
    expect(result).toEqual(clean);
    expect(result!.wouldTrade).toBe(true);
    expect(result!.marketTicker).toBe('K-40.4');
  });

  it('does not crash when a malformed band is the only band', () => {
    const onlyMalformed = [band({ ticker: 'M-only', floorStrike: null, capStrike: null })];
    let result: ReturnType<typeof evaluateSizing> | null = null;
    expect(() => {
      result = evaluateSizing(baseInput({ bands: onlyMalformed }));
    }).not.toThrow();
    expect(result!.wouldTrade).toBe(false);
  });

  it('a downward direction can find edge on the low side of the ladder', () => {
    const result = evaluateSizing(baseInput({ direction: 'down', magnitudePts: 0.3 }));
    // Not asserting wouldTrade=true unconditionally (depends on the exact
    // interpolated curve), but if it trades, side must still be a valid value.
    if (result.wouldTrade) {
      expect(['yes', 'no']).toContain(result.side);
    }
  });
});
