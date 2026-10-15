// src/perp/ops/history.ts
import type Database from 'better-sqlite3';

export interface HistoryReport {
  header: string;
  rows: Array<{ tsMs: number; mark: number }>;
}

/**
 * A compact, token-friendly view of the recorded perp marks in [fromMs, toMs]: a summary line (count, first/last,
 * high and low with their times) and at most `maxRows` rows, each the LAST mark of an equal-width time bucket.
 * Meant for an investigating agent: start from the summary, then narrow the window instead of loading raw rows.
 */
export function marksReport(db: Database.Database, fromMs: number, toMs: number, maxRows: number): HistoryReport {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM marks WHERE ts_ms BETWEEN ? AND ?').get(fromMs, toMs) as { n: number }).n;
  if (n === 0) return { header: `no marks between ${new Date(fromMs).toISOString()} and ${new Date(toMs).toISOString()}`, rows: [] };
  const first = db.prepare('SELECT ts_ms, mark FROM marks WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC LIMIT 1').get(fromMs, toMs) as { ts_ms: number; mark: number };
  const last = db.prepare('SELECT ts_ms, mark FROM marks WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms DESC LIMIT 1').get(fromMs, toMs) as { ts_ms: number; mark: number };
  const hi = db.prepare('SELECT ts_ms, mark FROM marks WHERE ts_ms BETWEEN ? AND ? ORDER BY mark DESC, ts_ms ASC LIMIT 1').get(fromMs, toMs) as { ts_ms: number; mark: number };
  const lo = db.prepare('SELECT ts_ms, mark FROM marks WHERE ts_ms BETWEEN ? AND ? ORDER BY mark ASC, ts_ms ASC LIMIT 1').get(fromMs, toMs) as { ts_ms: number; mark: number };
  const iso = (t: number): string => new Date(t).toISOString();
  const header =
    `# ${n} marks ${iso(first.ts_ms)} .. ${iso(last.ts_ms)}; first ${first.mark}, last ${last.mark}, ` +
    `high ${hi.mark} at ${iso(hi.ts_ms)}, low ${lo.mark} at ${iso(lo.ts_ms)}`;
  if (n <= maxRows) {
    const all = db.prepare('SELECT ts_ms, mark FROM marks WHERE ts_ms BETWEEN ? AND ? ORDER BY ts_ms ASC').all(fromMs, toMs) as Array<{ ts_ms: number; mark: number }>;
    return { header, rows: all.map((r) => ({ tsMs: r.ts_ms, mark: r.mark })) };
  }
  const width = Math.max(1, Math.ceil((toMs - fromMs + 1) / maxRows));
  const rows = db
    .prepare(
      `SELECT m.ts_ms, m.mark FROM marks m
       JOIN (SELECT MAX(ts_ms) AS t FROM marks WHERE ts_ms BETWEEN ? AND ? GROUP BY CAST((ts_ms - ?) / ? AS INTEGER)) b ON b.t = m.ts_ms
       ORDER BY m.ts_ms ASC`
    )
    .all(fromMs, toMs, fromMs, width) as Array<{ ts_ms: number; mark: number }>;
  return { header, rows: rows.map((r) => ({ tsMs: r.ts_ms, mark: r.mark })) };
}

/** `--from` / `--to` value: an ISO timestamp, epoch milliseconds, or "<N>m|h|d" meaning that long before `nowMs`. */
export function parseWhen(v: string, nowMs: number): number | null {
  const rel = /^(\d+(?:\.\d+)?)([mhd])$/.exec(v);
  if (rel !== null) return nowMs - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd'];
  if (/^\d{10,}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
