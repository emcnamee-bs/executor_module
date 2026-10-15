// src/perp/lab/marks.ts
//
// The second signal: what the perp mark did after each item. Everything reads the bot's ledger read-only.
import type Database from 'better-sqlite3';
import { hourlyMarks, markNear } from '../store/db.js';

const H = 3_600_000;
const INGEST_GAP_MS = 120_000;
const LATER_GAP_MS = 300_000;
const FILL_LOOKBACK_MS = 12 * H;

export function markAtIngest(botDb: Database.Database, receivedMs: number): { tsMs: number; mark: number } | null {
  return markNear(botDb, receivedMs, INGEST_GAP_MS);
}

/** Sample standard deviation of non-overlapping 4 h returns over the last 7 days of hourly marks; null with fewer than 6 returns. */
export function sigma4h(botDb: Database.Database, nowMs: number): number | null {
  const hm = hourlyMarks(botDb, nowMs - 7 * 24 * H);
  if (hm.length === 0) return null;
  const byHour = new Map<number, number>();
  for (const m of hm) byHour.set(Math.floor(m.tsMs / H), m.mark);
  const hours = [...byHour.keys()];
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours);
  const rets: number[] = [];
  for (let h = minH; h + 4 <= maxH; h += 4) {
    const a = byHour.get(h);
    const b = byHour.get(h + 4);
    if (a !== undefined && b !== undefined && a > 0) rets.push(b / a - 1);
  }
  if (rets.length < 6) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

export function movedFlag(ret4h: number | null, sigma: number | null): boolean {
  return ret4h !== null && sigma !== null && Math.abs(ret4h) >= 2 * sigma;
}

/** Fill ret_1h / ret_4h for items whose horizon has passed (within the last 12 h). Returns the number of rows changed. Never invents a return. */
export function fillReturns(labDb: Database.Database, botDb: Database.Database, nowMs: number): number {
  const rows = labDb
    .prepare(
      `SELECT item_id, received_ms, mark, ret_1h, ret_4h FROM items
        WHERE mark IS NOT NULL AND received_ms >= ?
          AND ((ret_1h IS NULL AND received_ms <= ?) OR (ret_4h IS NULL AND received_ms <= ?))`
    )
    .all(nowMs - FILL_LOOKBACK_MS, nowMs - H, nowMs - 4 * H) as Array<{ item_id: string; received_ms: number; mark: number; ret_1h: number | null; ret_4h: number | null }>;
  const upd1 = labDb.prepare('UPDATE items SET ret_1h = ? WHERE item_id = ?');
  const upd4 = labDb.prepare('UPDATE items SET ret_4h = ? WHERE item_id = ?');
  let changed = 0;
  for (const r of rows) {
    let did = false;
    if (r.ret_1h === null && r.received_ms <= nowMs - H) {
      const m = markNear(botDb, r.received_ms + H, LATER_GAP_MS);
      if (m !== null && r.mark > 0) { upd1.run(m.mark / r.mark - 1, r.item_id); did = true; }
    }
    if (r.ret_4h === null && r.received_ms <= nowMs - 4 * H) {
      const m = markNear(botDb, r.received_ms + 4 * H, LATER_GAP_MS);
      if (m !== null && r.mark > 0) { upd4.run(m.mark / r.mark - 1, r.item_id); did = true; }
    }
    if (did) changed += 1;
  }
  return changed;
}
