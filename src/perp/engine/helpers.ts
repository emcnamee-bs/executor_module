// src/perp/engine/helpers.ts
import type { Side } from '../types.js';

/** Best mark in the series in the position's favour: the highest for a long, the lowest for a short. */
export function extremeSince(series: Array<{ tsMs: number; mark: number }>, side: Side): number | null {
  if (series.length === 0) return null;
  let best = series[0].mark;
  for (const p of series) best = side === 'long' ? Math.max(best, p.mark) : Math.min(best, p.mark);
  return best;
}
