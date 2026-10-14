// src/perp/quant/formulas.ts
import type { PerpConfig } from '../config.js';

export const WEEKS_PER_YEAR = 52;
/** Used only when neither VIX nor a realized estimate is available (the policy refuses entries then). */
export const DEFAULT_SIGMA_WEEK = 0.025;

/** Index weekly sigma as a fraction, from the VIX level; null when the VIX is unusable. */
export function sigmaWeekFromVix(vix: number): number | null {
  if (!Number.isFinite(vix) || vix <= 0) return null;
  return vix / 100 / Math.sqrt(WEEKS_PER_YEAR);
}

/** min(hi, max(lo, x)): when hi < lo the upper bound wins, which is what the loss-budget cap needs. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Trailing-stop distance as a fraction of price for REALIZED leverage `leverage` (spec 5.2):
 * clamp(k * sigmaWeek, floor, min(cap, B / L)).
 */
export function stopFraction(sigmaWeek: number, leverage: number, cfg: PerpConfig): number {
  const upper = Math.min(cfg.stopCap, cfg.lossBudget / leverage);
  return clamp(cfg.sigmaK * sigmaWeek, cfg.stopFloor, upper);
}

/** Adverse index move (fraction) that reaches liquidation at leverage L with maintenance margin mm: 1/L - mm. */
export function liquidationDistance(leverage: number, mm: number): number {
  return 1 / leverage - mm;
}

/** Largest leverage whose liquidation distance is still at least twice `stop`: solves 2*stop <= 1/L - mm. */
export function liqBoundLeverage(stop: number, mm: number): number {
  return 1 / (2 * stop + mm);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** P(the path touches -barrier within the horizon) for zero-drift Brownian motion with horizon sigma `sigma`. */
export function barrierTouchProbability(barrier: number, sigma: number): number {
  if (barrier <= 0) return 1;
  if (sigma <= 0) return 0;
  return 2 * (1 - normalCdf(barrier / sigma));
}
