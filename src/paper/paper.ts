// src/paper/paper.ts
import type Database from 'better-sqlite3';

export interface PaperPositionRecord {
  trade: string;
  itemId: string;
  structure: 'band' | 'threshold' | 'binary' | 'capture' | 'multi';
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
  /** The news item that opened this position; set by recordPaperLegs (NULL on older rows). */
  sourceItemId?: string | null;
  /** 1, or 2 for the second market bought on an exclusive set (NULL on older rows). */
  leg?: 1 | 2 | null;
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
         entry_price_cents, direction, magnitude, edge_cents, reasoning, ladder_json, source_item_id, leg)
       VALUES
        (@trade, @itemId, @structure, @eventTicker, @marketTicker, @side, @contracts,
         @entryPriceCents, @direction, @magnitude, @edgeCents, @reasoning, @ladderJson, @sourceItemId, @leg)`
    )
    .run({ ...rec, sourceItemId: rec.sourceItemId ?? null, leg: rec.leg ?? null });
  return Number(info.lastInsertRowid);
}

export const SECOND_LEG_SUFFIX = '#2';

export function secondLegItemId(itemId: string): string {
  return `${itemId}${SECOND_LEG_SUFFIX}`;
}

/** True when this delivery already opened a position: either leg counts. */
export function hasPaperPosition(db: Database.Database, itemId: string): boolean {
  return db.prepare(`SELECT 1 FROM paper_positions WHERE item_id IN (?, ?)`).get(itemId, secondLegItemId(itemId)) !== undefined;
}

/**
 * Records the one or two legs a news item opens, atomically and idempotently. Leg 1 keeps the item's
 * own id; leg 2 is stored as `<item>#2` because item_id is UNIQUE (that is what makes a redelivered
 * stream entry harmless). Both rows carry the pairing in source_item_id / leg. Returns the new row
 * ids, or [] when this item already has a paper row.
 */
export function recordPaperLegs(db: Database.Database, sourceItemId: string, legs: PaperPositionRecord[]): number[] {
  if (legs.length < 1 || legs.length > 2) throw new Error(`a news item opens one or two paper legs, got ${legs.length}`);
  if (legs.length === 2 && legs[0].marketTicker === legs[1].marketTicker) {
    throw new Error('the two legs of one item must be on different markets');
  }
  return db.transaction((): number[] => {
    if (hasPaperPosition(db, sourceItemId)) return [];
    return legs.map((l, i) =>
      recordPaperPosition(db, {
        ...l,
        itemId: i === 0 ? sourceItemId : secondLegItemId(sourceItemId),
        sourceItemId,
        leg: (i + 1) as 1 | 2,
      })
    );
  })();
}

/**
 * A research bankroll for paper positions, deliberately larger than the live caps
 * ($1.25 per trade, $5 total): at the live size a typical edge sizes to zero contracts
 * and a paper run would record nothing. Applies ONLY to `paper_positions`; the live caps
 * keep governing the simulated-order path and the real `decisions` table.
 */
export const PAPER_CAPS = { perTradeCents: 1000, totalExposureCents: 5000 } as const;

/**
 * What the paper ledger still holds per market of one event: open cost in cents (entry price x contracts not yet
 * sold) over unsettled positions. Feeds the per-market stacking cap (src/decide/guards.ts), so a story that keeps
 * re-surfacing cannot keep adding to the same contract.
 */
export function paperOpenCostByMarket(db: Database.Database, eventTicker: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT p.market_ticker AS ticker,
              SUM(p.entry_price_cents * MAX(0, p.contracts - COALESCE((SELECT SUM(e.contracts) FROM paper_exits e WHERE e.position_id = p.id), 0))) AS cost
         FROM paper_positions p
        WHERE p.event_ticker = ? AND p.side IS NOT NULL AND p.settled_at IS NULL AND p.market_ticker IS NOT NULL
        GROUP BY p.market_ticker`
    )
    .all(eventTicker) as Array<{ ticker: string; cost: number }>;
  return new Map(rows.map((r) => [r.ticker, r.cost]));
}

export function paperExposureCents(db: Database.Database, eventTicker: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(contracts * entry_price_cents), 0) AS total
         FROM paper_positions WHERE event_ticker = ? AND side IS NOT NULL`
    )
    .get(eventTicker) as { total: number };
  return row.total;
}
