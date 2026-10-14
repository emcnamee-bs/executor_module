// src/perp/risk/state.ts
import type { PerpConfig } from '../config.js';
import type { ExitRule, Side } from '../types.js';

export interface RiskState {
  halted: boolean;
  haltReason: string | null;
  /** Earliest time a new entry on that side is allowed. */
  cooldownUntilMs: Record<Side, number>;
  /** Multiplier on that side's entry threshold; raised after an exit, reset by the next entry. */
  thresholdMult: Record<Side, number>;
}

export const STOP_OUT_RULES: ReadonlySet<ExitRule> = new Set<ExitRule>(['trailing_stop', 'margin_guard', 'liquidated']);
const NEWS_RULES: ReadonlySet<ExitRule> = new Set<ExitRule>(['shock', 'slow_bleed', 'pressure']);
const HOUR_MS = 3_600_000;

export function initialRiskState(): RiskState {
  return {
    halted: false,
    haltReason: null,
    cooldownUntilMs: { long: 0, short: 0 },
    thresholdMult: { long: 1, short: 1 },
  };
}

/**
 * Spec 5.5. A price stop-out (rules 1-2) cools BOTH sides for the stop-out cooldown; a news-driven exit
 * (rules 3-5) cools only the same side, so the opposite direction may enter immediately if its own
 * threshold passes. The same side's next entry needs a higher bar. Weekend/operator exits change nothing.
 */
export function applyExit(
  risk: RiskState,
  exit: { rule: ExitRule; side: Side; atMs: number },
  cfg: PerpConfig
): RiskState {
  const next: RiskState = {
    ...risk,
    cooldownUntilMs: { ...risk.cooldownUntilMs },
    thresholdMult: { ...risk.thresholdMult },
  };
  if (STOP_OUT_RULES.has(exit.rule)) {
    const until = exit.atMs + cfg.stopOutCooldownHours * HOUR_MS;
    next.cooldownUntilMs.long = Math.max(next.cooldownUntilMs.long, until);
    next.cooldownUntilMs.short = Math.max(next.cooldownUntilMs.short, until);
    next.thresholdMult[exit.side] = cfg.reentryMult;
  } else if (NEWS_RULES.has(exit.rule)) {
    next.cooldownUntilMs[exit.side] = Math.max(next.cooldownUntilMs[exit.side], exit.atMs + cfg.cooldownHours * HOUR_MS);
    next.thresholdMult[exit.side] = cfg.reentryMult;
  }
  return next;
}

export function applyEntry(risk: RiskState, side: Side): RiskState {
  return { ...risk, thresholdMult: { ...risk.thresholdMult, [side]: 1 } };
}

export function haltRisk(risk: RiskState, reason: string): RiskState {
  return { ...risk, halted: true, haltReason: reason };
}

export function clearHalt(risk: RiskState): RiskState {
  return { ...risk, halted: false, haltReason: null };
}
