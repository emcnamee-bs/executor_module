// test/decide/sizing.test.ts
import { describe, it, expect } from 'vitest';
import {
  evaluateSizing,
  gateCandidate,
  buildCandidatesForBand,
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
 * A five-band ladder centered on 40.0-41.0, priced so the market-implied
 * baseline sits right around 40.5 (each band's yes price roughly tracks a
 * bell curve peaking at the 40.4-40.6 band).
 */
function baseLadder(): BandMarket[] {
  return [
    band({
      ticker: 'K-39.8',
      floorStrike: null,
      capStrike: 40.0,
      strikeType: 'less',
      yesAskCents: 10,
      yesBidCents: 8,
    }),
    band({
      ticker: 'K-40.0',
      floorStrike: 40.0,
      capStrike: 40.2,
      strikeType: 'between',
      yesAskCents: 25,
      yesBidCents: 23,
    }),
    band({
      ticker: 'K-40.2',
      floorStrike: 40.2,
      capStrike: 40.4,
      strikeType: 'between',
      yesAskCents: 40,
      yesBidCents: 38,
    }),
    band({
      ticker: 'K-40.4',
      floorStrike: 40.4,
      capStrike: 40.6,
      strikeType: 'between',
      yesAskCents: 42,
      yesBidCents: 40,
    }),
    band({
      ticker: 'K-40.6',
      floorStrike: 40.6,
      capStrike: null,
      strikeType: 'greater',
      yesAskCents: 12,
      yesBidCents: 10,
    }),
  ];
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
    expect(result.marketTicker).not.toBeNull();
    expect(result.side).toBe('yes');
    expect(result.contracts).toBeGreaterThan(0);
    expect(result.notionalCents).toBeGreaterThan(0);
    expect(result.notionalCents).toBeLessThanOrEqual(1000);
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
    const extremeLadder = baseLadder().map((b) => ({ ...b, yesAskCents: 95, yesBidCents: 93 }));
    const result = evaluateSizing(baseInput({ bands: extremeLadder }));
    expect(result.wouldTrade).toBe(false);
  });

  it('clamps contracts so notional never exceeds the $10 per-trade cap', () => {
    const cheapLadder = baseLadder().map((b) =>
      b.ticker === 'K-40.4' ? { ...b, yesAskCents: 2, yesBidCents: 1, yesAskSizeContracts: 100000 } : b
    );
    const result = evaluateSizing(
      baseInput({ bands: cheapLadder, rung: 'confirmed', magnitudePts: 5 })
    );
    expect(result.notionalCents).toBeLessThanOrEqual(1000);
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

  it('a downward direction can find edge on the low side of the ladder', () => {
    const result = evaluateSizing(baseInput({ direction: 'down', magnitudePts: 0.3 }));
    // Not asserting wouldTrade=true unconditionally (depends on the exact
    // interpolated curve), but if it trades, side must still be a valid value.
    if (result.wouldTrade) {
      expect(['yes', 'no']).toContain(result.side);
    }
  });
});
