// src/paper/exitMath.ts
//
// The exit decision as pure arithmetic (spec section 2). The model only supplies `shift` and
// `confidence`; whether to sell is decided here. Sell iff
//   lossPerContract * remaining > EXIT_LOSS_FRACTION * (contracts * entry)   AND   lossPerContract > exitCost
// where lossPerContract = confidence * max(0, heldMid - fairAfter) and exitCost = (heldMid - heldBid) + fee.
import type { BandMarket } from '../decide/kalshi.js';
import {
  buildCandidatesForBand,
  buildCandidatesForThreshold,
  buildProbabilityCurve,
  buildThresholdCurve,
  thresholdCurveProblem,
  typicalBandWidthPts,
} from '../decide/sizing.js';

export const EXIT_LOSS_FRACTION = 0.02;

export interface ExitMathInput {
  structure: 'band' | 'threshold' | 'binary';
  side: 'yes' | 'no';
  /** Original size, for the 2% cost basis. */
  contracts: number;
  /** Contracts still held. */
  remaining: number;
  entryPriceCents: number;
  /** The held market as quoted now. */
  market: BandMarket;
  /** The whole ladder of that event, for the fair-value curve. */
  bands: BandMarket[];
  /** Signed: curve markets use the profile's magnitude unit (positive = quantity higher); binary uses YES-probability points. */
  shift: number;
  /** 0..1: the item is real, material and not already in the price. */
  confidence: number;
  exitFeeCents?: number;
}

export interface ExitMathResult {
  sell: boolean;
  reason: string;
  /** Held-side values in that side's own cents; per-contract figures. `lossCents` is already confidence-weighted. */
  midCents: number | null;
  bidCents: number | null;
  fairAfterCents: number | null;
  lossCents: number | null;
  exitCostCents: number | null;
}

function yesMidCents(m: BandMarket): number | null {
  if (m.yesAskCents !== null && m.yesBidCents !== null) return (m.yesAskCents + m.yesBidCents) / 2;
  return m.yesAskCents ?? m.yesBidCents;
}

export function evaluateExit(input: ExitMathInput): ExitMathResult {
  const { market, side } = input;
  const hold = (reason: string, extra: Partial<ExitMathResult> = {}): ExitMathResult => ({
    sell: false, reason, midCents: null, bidCents: null, fairAfterCents: null, lossCents: null, exitCostCents: null, ...extra,
  });

  if (input.remaining <= 0) return hold('nothing left to sell');
  if (market.status !== 'active') return hold(`market ${market.ticker} is ${market.status}, not active`);

  const yesMid = yesMidCents(market);
  if (yesMid === null) return hold('market has no quote at all');
  const heldMid = side === 'yes' ? yesMid : 100 - yesMid;
  const heldBid = side === 'yes' ? market.yesBidCents : market.yesAskCents === null ? null : 100 - market.yesAskCents;
  const quoted = { midCents: heldMid, bidCents: heldBid };

  let fairAfter: number;
  if (input.structure === 'binary') {
    const yesFair = Math.min(99, Math.max(1, yesMid + input.shift));
    fairAfter = side === 'yes' ? yesFair : 100 - yesFair;
  } else {
    const isThreshold = input.structure === 'threshold';
    const widthPts = isThreshold ? 0 : typicalBandWidthPts(input.bands);
    const curve = isThreshold ? buildThresholdCurve(input.bands) : buildProbabilityCurve(input.bands, widthPts);
    if (curve.length === 0) return hold('no usable fair-value curve on this ladder', quoted);
    if (isThreshold) {
      const problem = thresholdCurveProblem(curve);
      if (problem !== null) return hold(problem, quoted);
    }
    const candidates = isThreshold
      ? buildCandidatesForThreshold(market, curve, input.shift)
      : buildCandidatesForBand(market, curve, widthPts, input.shift);
    const mine = candidates.find((c) => c.side === side);
    if (mine === undefined) return hold('this contract cannot be priced on the curve (not a plain threshold/band market, or no two-sided quote)', quoted);
    fairAfter = mine.fairPriceCents;
  }

  const lossPerContract = input.confidence * Math.max(0, heldMid - fairAfter);
  const exitCost = (heldBid === null ? 0 : Math.max(0, heldMid - heldBid)) + (input.exitFeeCents ?? 0);
  const totalLoss = lossPerContract * input.remaining;
  const triggerTotal = EXIT_LOSS_FRACTION * input.contracts * input.entryPriceCents;
  const numbers = { ...quoted, fairAfterCents: fairAfter, lossCents: lossPerContract, exitCostCents: exitCost };

  if (totalLoss <= triggerTotal) {
    return { sell: false, reason: `expected loss ${totalLoss.toFixed(2)}c is not above 2% of cost (${triggerTotal.toFixed(2)}c)`, ...numbers };
  }
  if (lossPerContract <= exitCost) {
    return { sell: false, reason: `expected loss ${lossPerContract.toFixed(2)}c per contract does not beat the exit cost ${exitCost.toFixed(2)}c`, ...numbers };
  }
  return {
    sell: true,
    reason: `expected loss ${lossPerContract.toFixed(2)}c per contract (${totalLoss.toFixed(2)}c total) beats 2% of cost (${triggerTotal.toFixed(2)}c) and the exit cost ${exitCost.toFixed(2)}c`,
    ...numbers,
  };
}
