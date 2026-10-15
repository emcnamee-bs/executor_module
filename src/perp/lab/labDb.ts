// src/perp/lab/labDb.ts
import Database from 'better-sqlite3';
import { ensureModelCallsTable } from '../model/callJson.js';

export interface LabItemRow {
  item_id: string;
  received_ms: number;
  published_ms: number | null;
  source_id: string;
  tier: number;
  headline: string;
  snippet: string | null;
  commit_sha: string;
  class: string;
  score: number;
  hits: string;
  prod_pass: 0 | 1;
  prod_reason: string;
  dup_of: string | null;
  variants: string;
  mark_at_ms: number | null;
  mark: number | null;
}

export function openLabDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY, received_ms INTEGER NOT NULL, published_ms INTEGER, source_id TEXT NOT NULL, tier INTEGER NOT NULL,
      headline TEXT NOT NULL, snippet TEXT, commit_sha TEXT NOT NULL,
      class TEXT NOT NULL, score INTEGER NOT NULL, hits TEXT NOT NULL,
      prod_pass INTEGER NOT NULL CHECK (prod_pass IN (0, 1)), prod_reason TEXT NOT NULL, dup_of TEXT, variants TEXT NOT NULL,
      mark_at_ms INTEGER, mark REAL, ret_1h REAL, ret_4h REAL
    );
    CREATE INDEX IF NOT EXISTS items_received ON items (received_ms);
    CREATE TABLE IF NOT EXISTS audits (
      item_id TEXT PRIMARY KEY REFERENCES items(item_id), at_ms INTEGER NOT NULL, stratum TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('random', 'boundary')),
      bucket TEXT, direction TEXT, credibility REAL, novelty TEXT, already_priced TEXT, confidence REAL, rationale TEXT,
      miss INTEGER, cost_usd REAL, model TEXT, ok INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS heartbeat (
      ts_ms INTEGER PRIMARY KEY, last_item_ms INTEGER, stream_ok INTEGER NOT NULL, bot_db_ok INTEGER NOT NULL, marks_fresh INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  ensureModelCallsTable(db); // the audit spend lives here, so callJson's daily cap applies to the lab on its own
  return db;
}

export function insertItem(db: Database.Database, r: LabItemRow): boolean {
  const res = db
    .prepare(
      `INSERT INTO items (item_id, received_ms, published_ms, source_id, tier, headline, snippet, commit_sha, class, score, hits,
         prod_pass, prod_reason, dup_of, variants, mark_at_ms, mark)
       VALUES (@item_id, @received_ms, @published_ms, @source_id, @tier, @headline, @snippet, @commit_sha, @class, @score, @hits,
         @prod_pass, @prod_reason, @dup_of, @variants, @mark_at_ms, @mark)
       ON CONFLICT(item_id) DO NOTHING`
    )
    .run(r);
  return res.changes > 0;
}

export function hasItem(db: Database.Database, itemId: string): boolean {
  return db.prepare('SELECT 1 FROM items WHERE item_id = ?').get(itemId) !== undefined;
}

export function firstItemMs(db: Database.Database): number | null {
  const row = db.prepare('SELECT MIN(received_ms) AS m FROM items').get() as { m: number | null };
  return row.m;
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row === undefined ? null : row.value;
}

/** One meta row per lab process start (`start_<ms>` -> commit): the prefilter's in-memory dedup/cap state is cold after each start. */
export function recordProcessStart(db: Database.Database, nowMs: number, commit: string): void {
  setMeta(db, `start_${nowMs}`, commit);
}

export function listProcessStarts(db: Database.Database): Array<{ atMs: number; commit: string }> {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key GLOB 'start_[0-9]*'").all() as Array<{ key: string; value: string }>;
  return rows
    .map((r) => ({ atMs: Number(r.key.slice('start_'.length)), commit: r.value }))
    .filter((s) => Number.isFinite(s.atMs))
    .sort((a, b) => a.atMs - b.atMs);
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
