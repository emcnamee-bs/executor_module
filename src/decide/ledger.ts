// src/decide/ledger.ts
import Database from 'better-sqlite3';
import type { Rung } from './rung.js';

export const MAX_NOTIONAL_CENTS_PER_TRADE = 1000;
export const MAX_TOTAL_EXPOSURE_CENTS = 4000;

export interface DecisionRecord {
  itemId: string;
  storyKey: string | null;
  eventTicker: string | null;
  marketTicker: string | null;
  side: 'yes' | 'no' | null;
  rung: Rung;
  direction: 'up' | 'down' | null;
  magnitudePts: number | null;
  contracts: number;
  entryPriceCents: number | null;
  notionalCents: number;
  edgeCents: number | null;
  wouldTrade: boolean;
  reason: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  story_key TEXT,
  event_ticker TEXT,
  market_ticker TEXT,
  side TEXT CHECK (side IN ('yes','no') OR side IS NULL),
  rung TEXT NOT NULL CHECK (rung IN ('rumor','reported','corroborated','confirmed')),
  direction TEXT CHECK (direction IN ('up','down') OR direction IS NULL),
  magnitude_pts REAL,
  contracts INTEGER NOT NULL DEFAULT 0 CHECK (contracts >= 0),
  entry_price_cents INTEGER CHECK (entry_price_cents IS NULL OR (entry_price_cents > 0 AND entry_price_cents < 100)),
  notional_cents INTEGER NOT NULL DEFAULT 0 CHECK (notional_cents >= 0 AND notional_cents <= ${MAX_NOTIONAL_CENTS_PER_TRADE}),
  edge_cents REAL,
  would_trade INTEGER NOT NULL CHECK (would_trade IN (0,1)),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS enforce_total_exposure
BEFORE INSERT ON decisions
WHEN NEW.would_trade = 1
BEGIN
  SELECT RAISE(ABORT, 'total exposure cap exceeded')
  WHERE (SELECT COALESCE(SUM(notional_cents), 0) FROM decisions WHERE would_trade = 1)
        + NEW.notional_cents > ${MAX_TOTAL_EXPOSURE_CENTS};
END;
`;

export function openLedger(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function recordDecision(db: Database.Database, record: DecisionRecord): void {
  db.prepare(
    `INSERT INTO decisions
      (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
       magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
       would_trade, reason)
     VALUES (@itemId, @storyKey, @eventTicker, @marketTicker, @side, @rung, @direction,
       @magnitudePts, @contracts, @entryPriceCents, @notionalCents, @edgeCents,
       @wouldTrade, @reason)`
  ).run({
    ...record,
    wouldTrade: record.wouldTrade ? 1 : 0,
  });
}

export function hasOpenPosition(db: Database.Database, storyKey: string, eventTicker: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM decisions
       WHERE story_key = ? AND event_ticker = ? AND would_trade = 1
       LIMIT 1`
    )
    .get(storyKey, eventTicker);
  return row !== undefined;
}

export function totalExposureCents(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(notional_cents), 0) AS total FROM decisions WHERE would_trade = 1`)
    .get() as { total: number };
  return row.total;
}
