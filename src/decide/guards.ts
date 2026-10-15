// src/decide/guards.ts
//
// Paper-entry plausibility guards (2026-10-14 audit of the 39 paper positions). Sizing trusts the model's
// shift completely: a "down 0.10" call on a gas ladder whose strikes sit 0.02 apart re-prices the whole curve
// by five rungs, so a rung the market had at 89% YES became an "81c edge" NO. These guards are pure and apply
// to PAPER sizing only: callers pass them explicitly (like `caps`), so the live path is unchanged when omitted.
import type { CurvePoint } from './sizing.js';

export interface PaperGuards {
  /** Most an entry may add to one market: the open cost (contracts x entry price, cents) already held there plus the new buy. */
  maxMarketCostCents: number;
  /** A buy at or below this ask (cents) is a cheap tail bet... */
  tailMaxAskCents: number;
  /** ...and is declined when its claimed edge (cents) is at least this large: a 10c contract is not worth 85c. */
  tailMinEdgeCents: number;
  /** The shift may not exceed this multiple of the market's own interquartile width of the settlement quantity. */
  maxShiftIqrMultiple: number;
}

export const PAPER_GUARDS: PaperGuards = {
  maxMarketCostCents: 300,
  tailMaxAskCents: 15,
  tailMinEdgeCents: 75,
  maxShiftIqrMultiple: 2,
};

/**
 * The guards for this process: PAPER_GUARDS, overridable per field by environment variable
 * (PAPER_GUARD_MAX_MARKET_COST_CENTS, PAPER_GUARD_TAIL_MAX_ASK_CENTS, PAPER_GUARD_TAIL_MIN_EDGE_CENTS,
 * PAPER_GUARD_MAX_SHIFT_IQR) and switched off entirely by PAPER_GUARDS=off (returns null: sizing then behaves
 * exactly as before). That is the rollback: a unit drop-in and a restart, no redeploy.
 */
export function paperGuardsFromEnv(vars: NodeJS.ProcessEnv = process.env): PaperGuards | null {
  if (vars.PAPER_GUARDS === 'off') return null;
  const num = (key: string, fallback: number): number => {
    const raw = vars[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    maxMarketCostCents: num('PAPER_GUARD_MAX_MARKET_COST_CENTS', PAPER_GUARDS.maxMarketCostCents),
    tailMaxAskCents: num('PAPER_GUARD_TAIL_MAX_ASK_CENTS', PAPER_GUARDS.tailMaxAskCents),
    tailMinEdgeCents: num('PAPER_GUARD_TAIL_MIN_EDGE_CENTS', PAPER_GUARDS.tailMinEdgeCents),
    maxShiftIqrMultiple: num('PAPER_GUARD_MAX_SHIFT_IQR', PAPER_GUARDS.maxShiftIqrMultiple),
  };
}

/** Strike (or band centre) at which the curve's cumulative mass first reaches `q` of the way through the distribution. */
function interpolateAt(xs: number[], ys: number[], target: number): number {
  // ys are non-decreasing cumulative probabilities aligned with xs; first x where ys >= target, interpolated.
  if (target <= ys[0]) return xs[0];
  for (let i = 1; i < xs.length; i++) {
    if (ys[i] >= target) {
      const span = ys[i] - ys[i - 1];
      return span <= 0 ? xs[i] : xs[i - 1] + ((target - ys[i - 1]) / span) * (xs[i] - xs[i - 1]);
    }
  }
  return xs[xs.length - 1];
}

/**
 * Interquartile width of the settlement quantity implied by a priced ladder, in the ladder's own unit.
 * `threshold` curves carry P(value > strike) (falling); `band` curves carry probability mass per band centre.
 * null when the curve is too thin to say (fewer than two points, or no spread at all).
 */
export function ladderIqr(curve: CurvePoint[], kind: 'band' | 'threshold'): number | null {
  if (curve.length < 2) return null;
  const xs = curve.map((p) => p.centerPts);
  let cdf: number[];
  if (kind === 'threshold') {
    // Running minimum guards against a noisy rise between neighbours; then P(value <= strike) = 1 - survival.
    let low = Infinity;
    cdf = curve.map((p) => {
      low = Math.min(low, p.probability);
      return 1 - low;
    });
  } else {
    const total = curve.reduce((s, p) => s + Math.max(0, p.probability), 0);
    if (!(total > 0)) return null;
    let run = 0;
    cdf = curve.map((p) => (run += Math.max(0, p.probability) / total));
  }
  // A ladder that never reaches a quartile (every strike on one side of the median) says nothing about the width.
  if (cdf[0] > 0.25 || cdf[cdf.length - 1] < 0.75) return null;
  const iqr = interpolateAt(xs, cdf, 0.75) - interpolateAt(xs, cdf, 0.25);
  return iqr > 0 && Number.isFinite(iqr) ? iqr : null;
}

/** null when the shift is believable against the ladder; otherwise why it is not. A ladder with no measurable spread never blocks. */
export function shiftProblem(
  curve: CurvePoint[],
  kind: 'band' | 'threshold',
  signedShift: number,
  guards: PaperGuards
): string | null {
  const iqr = ladderIqr(curve, kind);
  if (iqr === null) return null;
  const limit = guards.maxShiftIqrMultiple * iqr;
  if (Math.abs(signedShift) <= limit) return null;
  return (
    `shift ${Math.abs(signedShift).toPrecision(3)} is ${(Math.abs(signedShift) / iqr).toFixed(1)}x the market's own interquartile width ` +
    `${iqr.toPrecision(3)} (limit ${guards.maxShiftIqrMultiple}x): one news item does not move the median that far`
  );
}

/** null when fine; otherwise why a cheap contract with a huge claimed edge is declined. */
export function tailEdgeProblem(askCents: number, edgeCents: number, guards: PaperGuards): string | null {
  if (askCents <= guards.tailMaxAskCents && edgeCents >= guards.tailMinEdgeCents) {
    return `tail bet declined: ${askCents}c contract claiming a ${edgeCents.toFixed(0)}c edge (cheap tails above ${guards.tailMinEdgeCents}c edge are the model overreaching)`;
  }
  return null;
}

/** Contracts a market can still take: how many more at `askCents` fit under the per-market cost cap. 0 when none. */
export function stackingHeadroomContracts(openCostCents: number, askCents: number, guards: PaperGuards): number {
  if (!(askCents > 0)) return 0;
  return Math.max(0, Math.floor((guards.maxMarketCostCents - openCostCents) / askCents));
}
