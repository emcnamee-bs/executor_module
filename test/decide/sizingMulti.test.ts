// test/decide/sizingMulti.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateMultiSizing, MAX_NOTIONAL_CENTS_PER_TRADE } from '../../src/decide/sizing.js';
import { MAX_TOTAL_EXPOSURE_CENTS } from '../../src/decide/ledger.js';
import type { BandMarket } from '../../src/decide/kalshi.js';
import { PAPER_CAPS } from '../../src/paper/paper.js';

const mk = (ticker: string, bid: number | null, ask: number | null, over: Partial<BandMarket> = {}): BandMarket => ({
  ticker, label: ticker, floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active',
  yesBidCents: bid, yesAskCents: ask, yesAskSizeContracts: 200, yesBidSizeContracts: 200, ...over,
});
const base = { rung: 'confirmed' as const, currentTotalExposureCents: 0, caps: PAPER_CAPS, maxLegs: 1 as const };
const mv = (market: string, shift: number, confidence = 1) => ({ market, shift, confidence });

describe('evaluateMultiSizing', () => {
  it('buys YES on a positive shift at the ask, with fair = mid + shift', () => {
    // mid 40 (bid 39 / ask 41); shift +10 -> fair 50; YES ask 41 -> edge 9
    const r = evaluateMultiSizing({ ...base, markets: [mk('A', 39, 41)], moves: [mv('A', 10)] });
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ marketTicker: 'A', side: 'yes', entryPriceCents: 41, edgeCents: 9, fairYesCents: 50, shift: 10 });
    expect(r.legs[0].contracts).toBeGreaterThan(0);
    expect(r.legs[0].notionalCents).toBe(r.legs[0].contracts * 41);
  });

  it('buys NO on a negative shift at 100 - yes_bid', () => {
    // mid 40; shift -10 -> fair YES 30 -> NO fair 70; NO ask 100-39 = 61 -> edge 9
    const r = evaluateMultiSizing({ ...base, markets: [mk('A', 39, 41)], moves: [mv('A', -10)] });
    expect(r.legs[0]).toMatchObject({ side: 'no', entryPriceCents: 61, edgeCents: 9, fairYesCents: 30 });
  });

  it('declines a price outside 10-90c, a spread over 5c, and an edge under half a cent, saying why', () => {
    expect(evaluateMultiSizing({ ...base, markets: [mk('A', 94, 96)], moves: [mv('A', 3)] }).reasons[0]).toMatch(/A: price 96c outside tradeable range/);
    expect(evaluateMultiSizing({ ...base, markets: [mk('A', 30, 40)], moves: [mv('A', 20)] }).reasons[0]).toMatch(/A: spread 10c exceeds 5c/);
    expect(evaluateMultiSizing({ ...base, markets: [mk('A', 39, 41)], moves: [mv('A', 1)] }).reasons[0]).toMatch(/A: edge .* below minimum/);
  });

  it('declines an unknown, closed or one-sided market', () => {
    const markets = [mk('B', null, 50), mk('C', 40, 42, { status: 'closed' })];
    const r = evaluateMultiSizing({ ...base, markets, moves: [mv('NOPE', 5), mv('B', 5), mv('C', 5)] });
    expect(r.legs).toHaveLength(0);
    expect(r.reasons).toHaveLength(3);
  });

  it('ignores a zero shift', () => {
    expect(evaluateMultiSizing({ ...base, markets: [mk('A', 39, 41)], moves: [mv('A', 0)] })).toEqual({ legs: [], reasons: [] });
  });

  it('takes only the best-edge move when maxLegs is 1, and two distinct markets when it is 2', () => {
    const markets = [mk('A', 39, 41), mk('B', 59, 61), mk('C', 19, 21)];
    const moves = [mv('A', 8), mv('B', -12), mv('C', 5)];
    const one = evaluateMultiSizing({ ...base, markets, moves });
    expect(one.legs.map((l) => l.marketTicker)).toEqual(['B']);
    const two = evaluateMultiSizing({ ...base, markets, moves, maxLegs: 2 });
    expect(two.legs.map((l) => l.marketTicker)).toEqual(['B', 'A']);
  });

  it('sizes the second leg against what the first one left of the exposure cap', () => {
    const markets = [mk('A', 39, 41), mk('B', 39, 41)];
    // Leg 1 (A, 7 contracts, 287c) leaves 113c; leg 2 (B) wants 5 contracts (205c) unconstrained but is cut to 2 (82c).
    const caps = { perTradeCents: 1000, totalExposureCents: 400 };
    const moves = [mv('A', 20), mv('B', 15)];
    const r = evaluateMultiSizing({ ...base, caps, maxLegs: 2, markets, moves });
    expect(r.legs.map((l) => l.marketTicker)).toEqual(['A', 'B']);
    expect(r.legs[0].notionalCents).toBeLessThanOrEqual(400);
    expect(r.legs[1].notionalCents).toBeLessThanOrEqual(400 - r.legs[0].notionalCents);
    const alone = evaluateMultiSizing({ ...base, caps, maxLegs: 1, markets, moves: [mv('B', 15)] });
    expect(r.legs[1].contracts).toBeLessThan(alone.legs[0].contracts);
  });

  it('clamps a confidence above 1 so it sizes exactly like 1', () => {
    const markets = [mk('A', 39, 41)];
    const one = evaluateMultiSizing({ ...base, markets, moves: [mv('A', 10, 1)] }).legs[0];
    const over = evaluateMultiSizing({ ...base, markets, moves: [mv('A', 10, 1.5)] }).legs[0];
    expect(over.contracts).toBe(one.contracts);
    expect(over.confidence).toBe(1);
  });

  it('yields no leg for a NaN or negative confidence', () => {
    const markets = [mk('A', 39, 41)];
    expect(evaluateMultiSizing({ ...base, markets, moves: [mv('A', 10, NaN)] }).legs).toHaveLength(0);
    expect(evaluateMultiSizing({ ...base, markets, moves: [mv('A', 10, -1)] }).legs).toHaveLength(0);
  });

  it('skips a non-finite shift with a reason', () => {
    const markets = [mk('A', 39, 41)];
    for (const shift of [NaN, Infinity, -Infinity]) {
      const r = evaluateMultiSizing({ ...base, markets, moves: [mv('A', shift)] });
      expect(r.legs).toHaveLength(0);
      expect(r.reasons).toEqual(['A: shift is not a finite number']);
    }
  });

  it('never puts two legs on the same market', () => {
    const r = evaluateMultiSizing({ ...base, maxLegs: 2, markets: [mk('A', 39, 41)], moves: [mv('A', 10), mv('A', 8)] });
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ marketTicker: 'A', shift: 10 });
    expect(r.reasons.join(' ')).toMatch(/A: already has a leg from this item/);
  });

  it('keeps every leg within the live per-trade cap when caps is omitted', () => {
    const markets = [mk('A', 19, 21), mk('B', 19, 21)];
    const r = evaluateMultiSizing({ ...base, caps: undefined, maxLegs: 2, markets, moves: [mv('A', 30), mv('B', 30)] });
    expect(r.legs.length).toBeGreaterThan(0);
    for (const l of r.legs) expect(l.notionalCents).toBeLessThanOrEqual(MAX_NOTIONAL_CENTS_PER_TRADE);
    expect(r.legs.reduce((t, l) => t + l.notionalCents, 0)).toBeLessThanOrEqual(MAX_TOTAL_EXPOSURE_CENTS);
  });

  it('counts exposure already on the event', () => {
    const r = evaluateMultiSizing({ ...base, currentTotalExposureCents: PAPER_CAPS.totalExposureCents, markets: [mk('A', 39, 41)], moves: [mv('A', 10)] });
    expect(r.legs).toHaveLength(0);
    expect(r.reasons.join(' ')).toMatch(/total exposure cap reached/);
  });

  it('scales the size by confidence', () => {
    const markets = [mk('A', 39, 41)];
    const full = evaluateMultiSizing({ ...base, markets, moves: [mv('A', 10, 1)] }).legs[0].contracts;
    const half = evaluateMultiSizing({ ...base, markets, moves: [mv('A', 10, 0.5)] }).legs[0].contracts;
    expect(half).toBeLessThan(full);
    expect(evaluateMultiSizing({ ...base, markets, moves: [mv('A', 10, 0)] }).legs).toHaveLength(0);
  });

  it('never trades on a rumor', () => {
    const r = evaluateMultiSizing({ ...base, rung: 'rumor', markets: [mk('A', 39, 41)], moves: [mv('A', 10)] });
    expect(r.legs).toHaveLength(0);
    expect(r.reasons[0]).toMatch(/never trades/);
  });

  it('never exceeds the per-trade cap or the depth shown', () => {
    const r = evaluateMultiSizing({ ...base, markets: [mk('A', 39, 41, { yesAskSizeContracts: 3 })], moves: [mv('A', 30)] });
    expect(r.legs[0].contracts).toBeLessThanOrEqual(3);
    const big = evaluateMultiSizing({ ...base, markets: [mk('A', 39, 41)], moves: [mv('A', 30)] });
    expect(big.legs[0].notionalCents).toBeLessThanOrEqual(PAPER_CAPS.perTradeCents);
  });
});
