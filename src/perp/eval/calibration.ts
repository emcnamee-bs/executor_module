// src/perp/eval/calibration.ts
import type { Bucket, ImpactAssessment } from '../types.js';

export interface Outcome {
  itemId: string;
  bucket: Bucket;
  direction: 'up' | 'down';
  confidence: number;
  realized1d: number | null;
  realized5d: number | null;
}

type Marks = Array<{ tsMs: number; mark: number }>;
const DAY = 86_400_000;
const BASELINE_MAX_GAP_MS = 10 * 60_000;
const HORIZON_MAX_GAP_MS = 3 * 3_600_000;
const BUCKET_ORDER: Bucket[] = ['minor', 'moderate', 'major', 'shock'];

function markAt(marks: Marks, tMs: number, maxGapMs: number): number | null {
  let best: { gap: number; mark: number } | null = null;
  for (const m of marks) {
    const gap = Math.abs(m.tsMs - tMs);
    if (gap <= maxGapMs && (best === null || gap < best.gap)) best = { gap, mark: m.mark };
  }
  return best === null ? null : best.mark;
}

/** What the perp did after each directional item, signed so that positive = the item's direction was right. */
export function outcomesFor(assessments: ImpactAssessment[], marks: Marks): Outcome[] {
  const out: Outcome[] = [];
  for (const a of assessments) {
    if (a.direction === 'neutral') continue;
    const base = markAt(marks, a.receivedAtMs, BASELINE_MAX_GAP_MS);
    if (base === null || base <= 0) continue;
    const sign = a.direction === 'up' ? 1 : -1;
    const realized = (days: number): number | null => {
      const m = markAt(marks, a.receivedAtMs + days * DAY, HORIZON_MAX_GAP_MS);
      return m === null ? null : sign * (m / base - 1);
    };
    out.push({
      itemId: a.itemId, bucket: a.bucket, direction: a.direction, confidence: a.confidence,
      realized1d: realized(1), realized5d: realized(5),
    });
  }
  return out;
}

export function brierScore(outcomes: Outcome[], horizon: '1d' | '5d'): { n: number; brier: number | null } {
  const rows = outcomes
    .map((o) => ({ p: o.confidence, r: horizon === '1d' ? o.realized1d : o.realized5d }))
    .filter((x): x is { p: number; r: number } => x.r !== null);
  if (rows.length === 0) return { n: 0, brier: null };
  const sum = rows.reduce((s, x) => s + (x.p - (x.r > 0 ? 1 : 0)) ** 2, 0);
  return { n: rows.length, brier: sum / rows.length };
}

export function bucketTable(
  outcomes: Outcome[]
): Array<{ bucket: Bucket; n: number; meanRealized1d: number | null; hitRate1d: number | null; meanRealized5d: number | null }> {
  const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
  return BUCKET_ORDER.filter((b) => outcomes.some((o) => o.bucket === b)).map((bucket) => {
    const rows = outcomes.filter((o) => o.bucket === bucket);
    const r1 = rows.map((o) => o.realized1d).filter((x): x is number => x !== null);
    const r5 = rows.map((o) => o.realized5d).filter((x): x is number => x !== null);
    return {
      bucket,
      n: rows.length,
      meanRealized1d: mean(r1),
      hitRate1d: r1.length === 0 ? null : r1.filter((x) => x > 0).length / r1.length,
      meanRealized5d: mean(r5),
    };
  });
}
