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

export interface StratifiedEstimate { rate: number | null; upper95: number | null; n: number; k: number; coverage: number }

/**
 * Volume-weighted estimate over the strata that have dropped volume.
 * - `rate`: miss rate over the AUDITED strata only (weights renormalised over them).
 * - `upper95`: weighted by the TOTAL dropped volume; a stratum with volume but no audits contributes weight x 1 (no information),
 *   an audited one weight x its Clopper-Pearson bound. So it is a conservative bound for all dropped items, not only the audited share.
 * - `coverage`: share of the total dropped volume that sits in audited strata (0..1).
 * Strata with no volume are ignored. If nothing with volume was audited, rate and upper95 are null.
 */
export function stratifiedEstimate(strata: StratumCount[]): StratifiedEstimate {
  const withVolume = strata.filter((s) => s.volume > 0);
  const audited = withVolume.filter((s) => s.n > 0);
  if (audited.length === 0) return { rate: null, upper95: null, n: 0, k: 0, coverage: 0 };
  const totalAll = withVolume.reduce((t, s) => t + s.volume, 0);
  const totalAudited = audited.reduce((t, s) => t + s.volume, 0);
  let rate = 0;
  for (const s of audited) rate += (s.volume / totalAudited) * (s.k / s.n);
  let upper = 0;
  for (const s of withVolume) upper += (s.volume / totalAll) * (s.n > 0 ? clopperPearsonUpper(s.k, s.n) : 1);
  return {
    rate,
    upper95: upper,
    n: audited.reduce((t, s) => t + s.n, 0),
    k: audited.reduce((t, s) => t + s.k, 0),
    coverage: totalAudited / totalAll,
  };
}
