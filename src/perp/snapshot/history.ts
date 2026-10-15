// src/perp/snapshot/history.ts
import type Database from 'better-sqlite3';
import { hourlyMarks, markNear } from '../store/db.js';
import { MAX_WINDOW_GAP_MS } from './builder.js';

const DAY_MS = 86_400_000;

/**
 * The price history the snapshot builder needs, in about 200 rows instead of every stored row of the last 8 days:
 * the last mark of each hour (all that realizedWeeklySigma reads) plus the mark nearest to 1 and 5 days ago (all that
 * computeReturns reads). Feeding it to buildSnapshot gives the same returns and sigma as the full series.
 */
export function loadCompactHistory(db: Database.Database, nowMs: number): Array<{ tsMs: number; mark: number }> {
  const byTs = new Map<number, number>();
  for (const h of hourlyMarks(db, nowMs - 8 * DAY_MS)) byTs.set(h.tsMs, h.mark);
  for (const days of [1, 5]) {
    const p = markNear(db, nowMs - days * DAY_MS, MAX_WINDOW_GAP_MS);
    if (p !== null) byTs.set(p.tsMs, p.mark);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([tsMs, mark]) => ({ tsMs, mark }));
}
