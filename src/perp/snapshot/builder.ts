// src/perp/snapshot/builder.ts
import type { MacroPoint, ScheduledEvent, Snapshot } from '../types.js';

type History = Array<{ tsMs: number; mark: number }>;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_WINDOW_GAP_MS = 3 * HOUR_MS;
/** 5 trading days x 24 hours; an approximation, only used when VIX is unavailable. */
const HOURS_PER_WEEK_FOR_SCALING = 120;
const MIN_HOURLY_RETURNS = 24;

function priceAround(history: History, targetMs: number): number | null {
  let best: { gap: number; mark: number } | null = null;
  for (const h of history) {
    if (h.tsMs > targetMs + MAX_WINDOW_GAP_MS) continue; // must be at least ~a window old
    const gap = Math.abs(h.tsMs - targetMs);
    if (gap <= MAX_WINDOW_GAP_MS && (best === null || gap < best.gap)) best = { gap, mark: h.mark };
  }
  return best === null ? null : best.mark;
}

export function computeReturns(nowMs: number, mark: number, history: History): { d1: number | null; d5: number | null } {
  const at = (days: number): number | null => {
    const p = priceAround(history, nowMs - days * DAY_MS);
    return p === null || p <= 0 ? null : mark / p - 1;
  };
  return { d1: at(1), d5: at(5) };
}

/** Weekly sigma from the hourly stdev of log returns, scaled by sqrt(120). Null with fewer than 24 hourly returns. */
export function realizedWeeklySigma(history: History): number | null {
  const byHour = new Map<number, number>();
  for (const h of history) byHour.set(Math.floor(h.tsMs / HOUR_MS), h.mark); // last mark in each hour wins
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  const rets: number[] = [];
  for (let i = 1; i < hours.length; i++) {
    const a = byHour.get(hours[i - 1])!;
    const b = byHour.get(hours[i])!;
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < MIN_HOURLY_RETURNS) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(HOURS_PER_WEEK_FOR_SCALING);
}

export function buildSnapshot(i: {
  nowMs: number;
  perp: Snapshot['perp'];
  perpFetchedAtMs: number;
  macro: Record<string, MacroPoint>;
  macroFetchedAtMs: number | null;
  events: ScheduledEvent[];
  kalshiEvents: Snapshot['kalshiEvents'];
  history: History;
}): Snapshot {
  return {
    tsMs: i.nowMs,
    perp: i.perp,
    returns: computeReturns(i.nowMs, i.perp.mark, i.history),
    realizedWeeklySigma: realizedWeeklySigma(i.history),
    macro: i.macro,
    events: i.events,
    kalshiEvents: i.kalshiEvents,
    freshness: {
      perpAgeMs: Math.max(0, i.nowMs - i.perpFetchedAtMs),
      macroAgeMs: i.macroFetchedAtMs === null ? null : Math.max(0, i.nowMs - i.macroFetchedAtMs),
    },
  };
}

export function vixOf(s: Snapshot): number | null {
  const v = s.macro.vix?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
