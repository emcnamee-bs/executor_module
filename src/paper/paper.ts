// src/paper/paper.ts
import type Database from 'better-sqlite3';

export interface PaperPositionRecord {
  trade: string;
  itemId: string;
  structure: 'band' | 'threshold' | 'binary' | 'capture';
  eventTicker: string;
  marketTicker: string | null;
  side: 'yes' | 'no' | null;
  contracts: number;
  entryPriceCents: number | null;
  direction: 'up' | 'down' | null;
  magnitude: number | null;
  edgeCents: number | null;
  reasoning: string | null;
  ladderJson: string;
}

/**
 * Records one simulated position (or, for `capture`, a market snapshot with no
 * position). The table's CHECK constraints are the real guard: a side without
 * contracts, a market ticker or an entry price is rejected by SQLite, and item_id is
 * UNIQUE so a redelivered stream entry cannot create a second paper position.
 */
export function recordPaperPosition(db: Database.Database, rec: PaperPositionRecord): number {
  const info = db
    .prepare(
      `INSERT INTO paper_positions
        (trade, item_id, structure, event_ticker, market_ticker, side, contracts,
         entry_price_cents, direction, magnitude, edge_cents, reasoning, ladder_json)
       VALUES
        (@trade, @itemId, @structure, @eventTicker, @marketTicker, @side, @contracts,
         @entryPriceCents, @direction, @magnitude, @edgeCents, @reasoning, @ladderJson)`
    )
    .run(rec);
  return Number(info.lastInsertRowid);
}

export function hasPaperPosition(db: Database.Database, itemId: string): boolean {
  return db.prepare(`SELECT 1 FROM paper_positions WHERE item_id = ?`).get(itemId) !== undefined;
}

/**
 * A research bankroll for paper positions, deliberately larger than the live caps
 * ($1.25 per trade, $5 total): at the live size a typical edge sizes to zero contracts
 * and a paper run would record nothing. Applies ONLY to `paper_positions`; the live caps
 * keep governing the simulated-order path and the real `decisions` table.
 */
export const PAPER_CAPS = { perTradeCents: 1000, totalExposureCents: 5000 } as const;

export function paperExposureCents(db: Database.Database, eventTicker: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(contracts * entry_price_cents), 0) AS total
         FROM paper_positions WHERE event_ticker = ? AND side IS NOT NULL`
    )
    .get(eventTicker) as { total: number };
  return row.total;
}
