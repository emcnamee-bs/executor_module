// src/perp/lab/stats.ts
//
// The numbers the tile and the report show: an exact one-sided upper bound on a miss rate, and a volume-weighted stratified estimate.

/** P(X <= k) for X ~ Binomial(n, p), by the pmf recurrence (n is a few thousand at most). */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let pmf = Math.pow(1 - p, n);
  let cdf = pmf;
  for (let i = 0; i < k; i++) {
    pmf *= ((n - i) / (i + 1)) * (p / (1 - p));
    cdf += pmf;
  }
  return Math.min(1, cdf);
}

/** Clopper-Pearson one-sided upper confidence bound for a proportion k/n (default 95%). No information (n <= 0 or k >= n) is 1. */
export function clopperPearsonUpper(k: number, n: number, confidence = 0.95): number {
  if (!(n > 0) || k >= n) return 1;
  const alpha = 1 - confidence;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface StratumCount { volume: number; n: number; k: number }

/** Volume-weighted miss rate over strata that have both volume and audits; the bound is the weighted sum of the per-stratum bounds (conservative). */
export function stratifiedEstimate(strata: StratumCount[]): { rate: number | null; upper95: number | null; n: number; k: number } {
  const usable = strata.filter((s) => s.n > 0 && s.volume > 0);
  if (usable.length === 0) return { rate: null, upper95: null, n: 0, k: 0 };
  const total = usable.reduce((t, s) => t + s.volume, 0);
  let rate = 0;
  let upper = 0;
  for (const s of usable) {
    const w = s.volume / total;
    rate += w * (s.k / s.n);
    upper += w * clopperPearsonUpper(s.k, s.n);
  }
  return { rate, upper95: upper, n: usable.reduce((t, s) => t + s.n, 0), k: usable.reduce((t, s) => t + s.k, 0) };
}
