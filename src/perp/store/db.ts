// src/perp/store/db.ts
import Database from 'better-sqlite3';
import type { ExitRecord } from '../risk/killSwitch.js';
import { initialRiskState, type RiskState } from '../risk/state.js';
import type { ImpactAssessment, PositionState, Snapshot } from '../types.js';

export function openPerpDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS journal_kind_ts ON journal (kind, ts_ms);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS exits (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, rule TEXT NOT NULL, side TEXT NOT NULL, pnl_usd REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS assessments (item_id TEXT PRIMARY KEY, received_ms INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots (ts_ms INTEGER PRIMARY KEY, mark REAL NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS equity (ts_ms INTEGER PRIMARY KEY, equity REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS marks (ts_ms INTEGER PRIMARY KEY, mark REAL NOT NULL);
  `);
  // One-time (idempotent) carry-over of the price history recorded before the marks table existed.
  db.exec(`INSERT OR IGNORE INTO marks (ts_ms, mark) SELECT ts_ms, mark FROM snapshots WHERE ts_ms > COALESCE((SELECT MAX(ts_ms) FROM marks), 0)`);
  return db;
}

export function appendJournal(db: Database.Database, e: { tsMs: number; kind: string; payload: unknown }): void {
  db.prepare('INSERT INTO journal (ts_ms, kind, payload) VALUES (?, ?, ?)').run(e.tsMs, e.kind, JSON.stringify(e.payload));
}

export function listJournal(db: Database.Database, kind: string, limit: number): Array<{ tsMs: number; payload: unknown }> {
  const rows = db
    .prepare('SELECT ts_ms, payload FROM journal WHERE kind = ? ORDER BY ts_ms DESC, id DESC LIMIT ?')
    .all(kind, limit) as Array<{ ts_ms: number; payload: string }>;
  return rows.map((r) => ({ tsMs: r.ts_ms, payload: JSON.parse(r.payload) as unknown }));
}

export function getState<T>(db: Database.Database, key: string): T | null {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.value) as T);
}

export function setState(db: Database.Database, key: string, value: unknown): void {
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function saveRiskState(db: Database.Database, r: RiskState): void {
  setState(db, 'risk', r);
}
export function loadRiskState(db: Database.Database): RiskState {
  return getState<RiskState>(db, 'risk') ?? initialRiskState();
}

export function savePosition(db: Database.Database, p: PositionState | null): void {
  setState(db, 'position', p);
}
export function loadPosition(db: Database.Database): PositionState | null {
  return getState<PositionState | null>(db, 'position') ?? null;
}

export function recordExit(db: Database.Database, e: ExitRecord): void {
  db.prepare('INSERT INTO exits (at_ms, rule, side, pnl_usd) VALUES (?, ?, ?, ?)').run(e.atMs, e.rule, e.side, e.pnlUsd);
}
export function listExits(db: Database.Database, sinceMs: number): ExitRecord[] {
  const rows = db
    .prepare('SELECT at_ms, rule, side, pnl_usd FROM exits WHERE at_ms >= ? ORDER BY at_ms ASC, id ASC')
    .all(sinceMs) as Array<{ at_ms: number; rule: ExitRecord['rule']; side: ExitRecord['side']; pnl_usd: number }>;
  return rows.map((r) => ({ atMs: r.at_ms, rule: r.rule, side: r.side, pnlUsd: r.pnl_usd }));
}

/** Returns false (and stores nothing) when the item id was already recorded. */
export function recordAssessment(db: Database.Database, a: ImpactAssessment): boolean {
  const res = db.prepare('INSERT OR IGNORE INTO assessments (item_id, received_ms, json) VALUES (?, ?, ?)').run(a.itemId, a.receivedAtMs, JSON.stringify(a));
  return res.changes > 0;
}
export function listAssessments(db: Database.Database, sinceMs: number): ImpactAssessment[] {
  const rows = db
    .prepare('SELECT json FROM assessments WHERE received_ms >= ? ORDER BY received_ms ASC')
    .all(sinceMs) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as ImpactAssessment);
}

export function saveSnapshot(db: Database.Database, s: Snapshot): void {
  db.prepare('INSERT OR REPLACE INTO snapshots (ts_ms, mark, json) VALUES (?, ?, ?)').run(s.tsMs, s.perp.mark, JSON.stringify(s));
}
export function snapshotNear(db: Database.Database, tsMs: number, maxGapMs: number): Snapshot | null {
  const row = db
    .prepare('SELECT ts_ms, json FROM snapshots ORDER BY ABS(ts_ms - ?) ASC LIMIT 1')
    .get(tsMs) as { ts_ms: number; json: string } | undefined;
  if (row === undefined || Math.abs(row.ts_ms - tsMs) > maxGapMs) return null;
  return JSON.parse(row.json) as Snapshot;
}
export function markSeries(db: Database.Database, sinceMs: number): Array<{ tsMs: number; mark: number }> {
  const rows = db.prepare('SELECT ts_ms, mark FROM snapshots WHERE ts_ms >= ? ORDER BY ts_ms ASC').all(sinceMs) as Array<{ ts_ms: number; mark: number }>;
  return rows.map((r) => ({ tsMs: r.ts_ms, mark: r.mark }));
}

/** The perp mark at every tick (16 bytes a row), full snapshot or not: the compact price record the history queries use. */
export function recordMark(db: Database.Database, tsMs: number, mark: number): void {
  db.prepare('INSERT OR REPLACE INTO marks (ts_ms, mark) VALUES (?, ?)').run(tsMs, mark);
}
/** The LAST mark of every UTC hour since `sinceMs`, oldest first (at most about 24 rows per day). */
export function hourlyMarks(db: Database.Database, sinceMs: number): Array<{ tsMs: number; mark: number }> {
  const rows = db
    .prepare(
      `SELECT m.ts_ms, m.mark FROM marks m
       JOIN (SELECT MAX(ts_ms) AS t FROM marks WHERE ts_ms >= ? GROUP BY ts_ms / 3600000) h ON h.t = m.ts_ms
       ORDER BY m.ts_ms ASC`
    )
    .all(sinceMs) as Array<{ ts_ms: number; mark: number }>;
  return rows.map((r) => ({ tsMs: r.ts_ms, mark: r.mark }));
}
/** The mark closest in time to `targetMs`, or null when none is within `maxGapMs`. */
export function markNear(db: Database.Database, targetMs: number, maxGapMs: number): { tsMs: number; mark: number } | null {
  const before = db.prepare('SELECT ts_ms, mark FROM marks WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1').get(targetMs) as { ts_ms: number; mark: number } | undefined;
  const after = db.prepare('SELECT ts_ms, mark FROM marks WHERE ts_ms >= ? ORDER BY ts_ms ASC LIMIT 1').get(targetMs) as { ts_ms: number; mark: number } | undefined;
  let best: { ts_ms: number; mark: number } | undefined;
  for (const c of [before, after]) {
    if (c !== undefined && (best === undefined || Math.abs(c.ts_ms - targetMs) < Math.abs(best.ts_ms - targetMs))) best = c;
  }
  return best === undefined || Math.abs(best.ts_ms - targetMs) > maxGapMs ? null : { tsMs: best.ts_ms, mark: best.mark };
}
/** Highest ('max') or lowest ('min') mark since `sinceMs`, or null when there is none. Reads no rows into memory. */
export function markExtreme(db: Database.Database, sinceMs: number, which: 'max' | 'min'): number | null {
  const row = db.prepare(`SELECT ${which === 'max' ? 'MAX' : 'MIN'}(mark) AS v FROM marks WHERE ts_ms >= ?`).get(sinceMs) as { v: number | null };
  return row.v;
}

export function recordEquity(db: Database.Database, tsMs: number, equity: number): void {
  db.prepare('INSERT OR REPLACE INTO equity (ts_ms, equity) VALUES (?, ?)').run(tsMs, equity);
}
export function equityPeak(db: Database.Database, sinceMs = 0): number {
  const row = db.prepare('SELECT MAX(equity) AS m FROM equity WHERE ts_ms >= ?').get(sinceMs) as { m: number | null };
  return row.m ?? 0;
}
