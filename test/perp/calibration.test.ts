import { describe, it, expect } from 'vitest';
import { brierScore, bucketTable, outcomesFor } from '../../src/perp/eval/calibration.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const T = Date.UTC(2026, 9, 14, 15, 0, 0);
const DAY = 86_400_000;
const a = (over: Partial<ImpactAssessment>): ImpactAssessment => ({
  itemId: 'i', receivedAtMs: T, publishedAtMs: T, direction: 'up', bucket: 'major', horizon: 'days', credibility: 0.8,
  novelty: 'new', alreadyPriced: 'no', confidence: 0.8, rationale: 'r', ...over,
});
const marks = [{ tsMs: T, mark: 100 }, { tsMs: T + DAY, mark: 101 }, { tsMs: T + 5 * DAY, mark: 99 }];

describe('outcomesFor', () => {
  it('signs realized moves by item direction and leaves horizons without data null', () => {
    const out = outcomesFor([a({ itemId: 'up' }), a({ itemId: 'down', direction: 'down', confidence: 0.6, bucket: 'minor' })], marks);
    expect(out[0].itemId).toBe('up');
    expect(out[0].realized1d).toBeCloseTo(0.01, 8);
    expect(out[0].realized5d).toBeCloseTo(-0.01, 8);
    expect(out[1].itemId).toBe('down');
    expect(out[1].realized1d).toBeCloseTo(-0.01, 8);
    expect(out[1].realized5d).toBeCloseTo(0.01, 8);
    const noFuture = outcomesFor([a({ itemId: 'late', receivedAtMs: T + 5 * DAY, publishedAtMs: T + 5 * DAY })], marks);
    expect(noFuture[0].realized1d).toBeNull();
    expect(noFuture[0].realized5d).toBeNull();
  });
  it('skips neutral items and items with no baseline mark', () => {
    expect(outcomesFor([a({ direction: 'neutral' })], marks)).toEqual([]);
    expect(outcomesFor([a({ receivedAtMs: T - 3 * DAY })], marks)).toEqual([]);
  });
});

describe('brierScore', () => {
  it('averages (confidence - outcome)^2 over outcomes with data', () => {
    const out = outcomesFor([a({ itemId: 'up', confidence: 0.8 }), a({ itemId: 'down', direction: 'down', confidence: 0.6 })], marks);
    // up: realized1d +1% -> y=1, (0.8-1)^2 = 0.04 ; down: realized1d -1% -> y=0, (0.6-0)^2 = 0.36
    const r = brierScore(out, '1d');
    expect(r.n).toBe(2);
    expect(r.brier).toBeCloseTo(0.2, 8);
  });
  it('reports null, not NaN, with no data', () => {
    expect(brierScore([], '1d')).toEqual({ n: 0, brier: null });
  });
});

describe('bucketTable', () => {
  it('summarizes realized moves and hit rate per bucket in a fixed order', () => {
    const out = outcomesFor([a({ itemId: '1', bucket: 'major' }), a({ itemId: '2', bucket: 'minor', direction: 'down' }), a({ itemId: '3', bucket: 'major' })], marks);
    const t = bucketTable(out);
    expect(t.map((r) => r.bucket)).toEqual(['minor', 'major']);
    const major = t.find((r) => r.bucket === 'major')!;
    expect(major.n).toBe(2);
    expect(major.meanRealized1d).toBeCloseTo(0.01, 8);
    expect(major.hitRate1d).toBe(1);
    expect(t.find((r) => r.bucket === 'minor')!.hitRate1d).toBe(0);
  });
});
