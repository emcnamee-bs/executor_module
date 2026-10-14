// src/perp/risk/governor.ts
import type { PerpConfig } from '../config.js';
import { DEFAULT_SIGMA_WEEK, clamp, liqBoundLeverage, sigmaWeekFromVix, stopFraction } from '../quant/formulas.js';
import type { Side } from '../types.js';

export interface GovernorOutput {
  sigmaWeek: number;
  /** Daily sigma implied by the weekly one: sigmaWeek / sqrt(5). */
  sigmaDay: number;
  sigmaSource: 'vix' | 'realized' | 'default';
  /** Largest realized leverage the volatility and liquidation limits allow, capped by the target. */
  leverageEff: number;
  /** Trailing-stop distance (fraction of price) at `leverageEff`. */
  stopFrac: number;
}

export function computeGovernor(i: {
  cfg: PerpConfig;
  side: Side;
  vix: number | null;
  realizedWeeklySigma: number | null;
}): GovernorOutput {
  const { cfg } = i;
  let sigmaWeek: number;
  let sigmaSource: GovernorOutput['sigmaSource'];
  const fromVix = i.vix === null ? null : sigmaWeekFromVix(i.vix);
  if (fromVix !== null) {
    sigmaWeek = fromVix;
    sigmaSource = 'vix';
  } else if (i.realizedWeeklySigma !== null && Number.isFinite(i.realizedWeeklySigma) && i.realizedWeeklySigma > 0) {
    sigmaWeek = i.realizedWeeklySigma;
    sigmaSource = 'realized';
  } else {
    sigmaWeek = DEFAULT_SIGMA_WEEK;
    sigmaSource = 'default';
  }

  const kSigma = cfg.sigmaK * sigmaWeek;
  const stopVol = clamp(kSigma, cfg.stopFloor, cfg.stopCap);
  const levVol = cfg.lossBudget / kSigma;
  const levLiq = liqBoundLeverage(stopVol, cfg.maintenanceMargin[i.side]);
  const leverageEff = Math.min(cfg.leverageTarget, levVol, levLiq);

  return {
    sigmaWeek,
    sigmaDay: sigmaWeek / Math.sqrt(5),
    sigmaSource,
    leverageEff,
    stopFrac: stopFraction(sigmaWeek, leverageEff, cfg),
  };
}

export function computeGovernors(
  cfg: PerpConfig,
  vix: number | null,
  realizedWeeklySigma: number | null
): Record<Side, GovernorOutput> {
  return {
    long: computeGovernor({ cfg, side: 'long', vix, realizedWeeklySigma }),
    short: computeGovernor({ cfg, side: 'short', vix, realizedWeeklySigma }),
  };
}
