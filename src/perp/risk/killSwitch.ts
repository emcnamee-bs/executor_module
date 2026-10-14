// src/perp/risk/killSwitch.ts
import type { PerpConfig } from '../config.js';
import type { ExitRule, Side } from '../types.js';
import { STOP_OUT_RULES } from './state.js';

export interface ExitRecord {
  atMs: number;
  rule: ExitRule;
  side: Side;
  pnlUsd: number;
}

const DAY_MS = 86_400_000;

/** Spec 5.7: two stop-outs in 30 days, or equity down 30% from its peak, or three exits within 24 hours. */
export function evaluateKillSwitch(i: {
  exits: ExitRecord[];
  equityPeak: number;
  equityNow: number;
  nowMs: number;
  cfg: PerpConfig;
}): { halt: boolean; reason: string | null } {
  const { cfg, nowMs } = i;
  const stopOuts = i.exits.filter((e) => STOP_OUT_RULES.has(e.rule) && nowMs - e.atMs <= 30 * DAY_MS).length;
  if (stopOuts >= cfg.killStopOuts30d) {
    return { halt: true, reason: `${stopOuts} stop-outs in 30 days (limit ${cfg.killStopOuts30d})` };
  }
  if (i.equityPeak > 0 && i.equityNow <= i.equityPeak * (1 - cfg.killDrawdown)) {
    const dd = (1 - i.equityNow / i.equityPeak) * 100;
    return { halt: true, reason: `equity drawdown ${dd.toFixed(1)}% from peak (limit ${(cfg.killDrawdown * 100).toFixed(0)}%)` };
  }
  const recent = i.exits.filter((e) => nowMs - e.atMs <= DAY_MS).length;
  if (recent >= cfg.killExits24h) {
    return { halt: true, reason: `${recent} exits within 24 hours (limit ${cfg.killExits24h})` };
  }
  return { halt: false, reason: null };
}
