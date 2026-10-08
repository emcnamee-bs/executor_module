import { describe, it, expect } from 'vitest';
import { evaluateSizing, contractsWithinCaps, type SizingInput } from '../../src/decide/sizing.js';
import type { BandMarket } from '../../src/decide/kalshi.js';

function gt(strike: number, bid: number, ask: number): BandMarket {
  return {
    ticker: `G-${strike.toFixed(2)}`, floorStrike: strike, capStrike: null, strikeType: 'greater', status: 'active',
    yesBidCents: bid, yesAskCents: ask, yesAskSizeContracts: 100, yesBidSizeContracts: 100,
  };
}
// The hand-worked ladder from sizingThreshold.test.ts: best trade is G-4.38 YES at 31c, edge 27c, kelly 27/69.
const bands = [gt(4.3, 79, 81), gt(4.34, 57, 59), gt(4.38, 29, 31), gt(4.42, 11, 13)];
const base: SizingInput = { bands, rung: 'reported', direction: 'up', magnitudePts: 0.04, currentTotalExposureCents: 0, curveKind: 'threshold' };

describe('sizing caps', () => {
  it('with the default (live) caps a reported-rung edge sizes to zero contracts, unchanged from before', () => {
    expect(evaluateSizing(base).wouldTrade).toBe(false);
    expect(evaluateSizing(base).reason).toMatch(/sized to zero contracts/);
  });

  it('with paper caps the same edge sizes to floor(floor(1000/31) x 27/69 x 0.25) = 3 contracts', () => {
    const r = evaluateSizing({ ...base, caps: { perTradeCents: 1000, totalExposureCents: 5000 } });
    expect(r).toMatchObject({ wouldTrade: true, marketTicker: 'G-4.38', side: 'yes', contracts: 3, entryPriceCents: 31, notionalCents: 93, edgeCents: 27 });
  });

  it('the per-trade cap is an absolute ceiling for any kelly/stake handed to it', () => {
    const n = contractsWithinCaps({ askCents: 31, kelly: 5, stake: 5, depthContracts: 10_000, remainingExposureCents: 100_000, perTradeCents: 1000 });
    expect(n * 31).toBeLessThanOrEqual(1000);
  });

  it('contractsWithinCaps without perTradeCents still uses the live 125c cap', () => {
    const n = contractsWithinCaps({ askCents: 31, kelly: 5, stake: 5, depthContracts: 10_000, remainingExposureCents: 100_000 });
    expect(n * 31).toBeLessThanOrEqual(125);
  });

  it('the paper total-exposure cap is enforced: existing paper exposure at the cap declines', () => {
    const r = evaluateSizing({ ...base, currentTotalExposureCents: 5000, caps: { perTradeCents: 1000, totalExposureCents: 5000 } });
    expect(r.wouldTrade).toBe(false);
    expect(r.reason).toMatch(/total exposure cap reached \(5000c of 5000c\)/);
  });

  it('remaining paper exposure limits contracts (500c left at 31c = 16 contracts max, kelly allows 3)', () => {
    const r = evaluateSizing({ ...base, currentTotalExposureCents: 4500, caps: { perTradeCents: 1000, totalExposureCents: 5000 } });
    expect(r.contracts).toBe(3);
  });
});
