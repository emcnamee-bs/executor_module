import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { PressureBook, itemWeight } from '../../src/perp/quant/pressure.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 86_400_000;
const cfg = DEFAULT_CONFIG;

function a(over: Partial<ImpactAssessment> = {}): ImpactAssessment {
  return {
    itemId: 'i1',
    receivedAtMs: T0,
    publishedAtMs: T0 - 60_000,
    direction: 'up',
    bucket: 'moderate',
    horizon: 'days',
    credibility: 0.8,
    novelty: 'new',
    alreadyPriced: 'no',
    confidence: 0.75,
    rationale: 'r',
    ...over,
  };
}

describe('itemWeight', () => {
  it('= sign * bucketMove * credibility * confidence * noveltyWeight * pricedWeight', () => {
    expect(itemWeight(a(), cfg)).toBeCloseTo(0.015 * 0.8 * 0.75, 10);
    expect(itemWeight(a({ direction: 'down' }), cfg)).toBeCloseTo(-0.009, 10);
    expect(itemWeight(a({ direction: 'neutral' }), cfg)).toBe(0);
    expect(itemWeight(a({ alreadyPriced: 'yes' }), cfg)).toBeCloseTo(0.009 * 0.3, 10);
    expect(itemWeight(a({ novelty: 'known' }), cfg)).toBeCloseTo(0.009 * 0.25, 10);
  });
  it('is 0 (never NaN) when confidence or credibility is not finite', () => {
    expect(itemWeight(a({ confidence: NaN }), cfg)).toBe(0);
    expect(itemWeight(a({ credibility: Infinity }), cfg)).toBe(0);
  });
});

describe('PressureBook', () => {
  it('returns the full weight at arrival and decays by e^-1 after tau (2 days)', () => {
    const book = new PressureBook(cfg);
    book.add(a());
    expect(book.at(T0)).toBeCloseTo(0.009, 10);
    expect(book.at(T0 + 2 * DAY)).toBeCloseTo(0.009 * Math.exp(-1), 8);
  });
  it('sums signed contributions', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'up' }));
    book.add(a({ itemId: 'down', direction: 'down', bucket: 'minor' }));
    expect(book.at(T0)).toBeCloseTo(0.009 - 0.005 * 0.8 * 0.75, 10);
  });
  it('ignores a duplicate/replayed item id (review focus 2)', () => {
    const book = new PressureBook(cfg);
    expect(book.add(a())).toBe(true);
    expect(book.add(a({ bucket: 'shock' }))).toBe(false);
    expect(book.at(T0)).toBeCloseTo(0.009, 10);
    expect(book.size).toBe(1);
  });
  it('ignores items received after the evaluation time (review focus 3)', () => {
    const book = new PressureBook(cfg);
    book.add(a({ receivedAtMs: T0 + 3_600_000 }));
    expect(book.at(T0)).toBe(0);
    expect(book.at(T0 + 3_600_000)).toBeCloseTo(0.009, 10);
  });
  it('decays an intraday item 4x faster than a days item', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'intra', horizon: 'intraday' }));
    expect(book.at(T0 + DAY / 2)).toBeCloseTo(0.009 * Math.exp(-1), 8); // tau = 0.5 day
    const book2 = new PressureBook(cfg);
    book2.add(a({ itemId: 'days', horizon: 'days' }));
    expect(book2.at(T0 + DAY / 2)).toBeCloseTo(0.009 * Math.exp(-0.25), 8);
  });
  it('never produces NaN from a malformed item', () => {
    const book = new PressureBook(cfg);
    book.add(a({ confidence: NaN }));
    expect(book.at(T0)).toBe(0);
  });
  it('top() ranks contributors by magnitude and prune() drops old items', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'small', bucket: 'minor', receivedAtMs: T0 - 10 * DAY }));
    book.add(a({ itemId: 'big', bucket: 'major' }));
    const top = book.top(T0, 2);
    expect(top[0].itemId).toBe('big');
    expect(book.prune(T0 - DAY)).toBe(1);
    expect(book.size).toBe(1);
  });
});

describe('PressureBook non-finite hardening', () => {
  it('rejects an item with a non-finite receivedAtMs and leaves the book clean', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'ok' }));
    expect(book.add(a({ itemId: 'bad', receivedAtMs: NaN }))).toBe(false);
    expect(book.add(a({ itemId: 'inf', receivedAtMs: -Infinity }))).toBe(false);
    expect(book.size).toBe(1);
    expect(book.at(T0)).toBeCloseTo(0.009, 10);
    expect(book.top(T0, 5).map((r) => r.itemId)).toEqual(['ok']);
  });
  it('returns 0 / [] when the evaluation time is not finite', () => {
    const book = new PressureBook(cfg);
    book.add(a());
    expect(book.at(NaN)).toBe(0);
    expect(book.at(Infinity)).toBe(0);
    expect(book.top(NaN, 3)).toEqual([]);
  });
  it('treats an unknown bucket/novelty/alreadyPriced as weight 0, never NaN', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'b1', bucket: 'bogus' as never }));
    book.add(a({ itemId: 'b2', novelty: 'bogus' as never }));
    book.add(a({ itemId: 'b3', alreadyPriced: 'bogus' as never }));
    book.add(a({ itemId: 'good' }));
    expect(book.at(T0)).toBeCloseTo(0.009, 10);
    expect(book.top(T0, 10).every((r) => Number.isFinite(r.contribution))).toBe(true);
  });
  it('rejects an item whose decay constant is unknown or not positive', () => {
    const book = new PressureBook(cfg);
    expect(book.add(a({ itemId: 'h', horizon: 'bogus' as never }))).toBe(false);
    const zero = new PressureBook({ ...cfg, horizonTauFactor: { ...cfg.horizonTauFactor, days: 0 } });
    expect(zero.add(a())).toBe(false);
    expect(zero.size).toBe(0);
    expect(zero.at(T0)).toBe(0);
    expect(book.size).toBe(0);
  });
});
