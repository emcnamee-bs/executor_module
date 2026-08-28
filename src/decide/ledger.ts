// src/decide/ledger.ts
import Database from 'better-sqlite3';
import type { Rung } from './rung.js';

export const MAX_NOTIONAL_CENTS_PER_TRADE = 1000;
export const MAX_TOTAL_EXPOSURE_CENTS = 4000;

export type OrderStatus =
  | 'pending' | 'filled' | 'partial' | 'unfilled'
  | 'rejected' | 'error' | 'unknown' | 'declined-at-execution';

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
  orderStatus: 'pending' | 'resolved';
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
  notional_cents INTEGER NOT NULL DEFAULT 0 CHECK (notional_cents >= 0 AND (would_trade = 0 OR notional_cents <= ${MAX_NOTIONAL_CENTS_PER_TRADE})),
  edge_cents REAL,
  would_trade INTEGER NOT NULL CHECK (would_trade IN (0,1)),
  reason TEXT NOT NULL,
  order_status TEXT NOT NULL DEFAULT 'resolved' CHECK (order_status IN ('pending','resolved')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- The cap layer above is only worth anything if notional_cents is the real
  -- notional. Nothing else ties it to the position it describes, so a row claiming
  -- contracts=100 @ 50c with notional_cents=0 would otherwise insert cleanly and
  -- report zero exposure for a real $50 position. Deliberately redundant with
  -- recordDecision's construction-time check: this one also holds for a future code
  -- path that prepares its own INSERT.
  --
  -- event_ticker IS NOT NULL is required here too: the enforce_total_exposure
  -- trigger below sums WHERE event_ticker = NEW.event_ticker, and SQL's
  -- three-valued logic means that comparison is never true when NEW.event_ticker
  -- is NULL -- a would-trade row with no event_ticker would otherwise sum against
  -- nothing and bypass the exposure cap entirely, regardless of notional_cents.
  CHECK (would_trade = 0 OR (
    entry_price_cents IS NOT NULL
    AND event_ticker IS NOT NULL
    AND notional_cents = contracts * entry_price_cents
  ))
);

-- Redis delivery is at-least-once, so the same item CAN arrive twice. The pipeline
-- checks hasDecisionForItem() first; this is the backstop that makes a second row
-- for one item impossible rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_item_id ON decisions(item_id);

-- Scoped to NEW.event_ticker, matching totalExposureCents(): each week's ladder is
-- its own event, so exposure is per-event rather than an all-time sum that would
-- silently and permanently exhaust itself after ~20 lifetime trades.
CREATE TRIGGER IF NOT EXISTS enforce_total_exposure
BEFORE INSERT ON decisions
WHEN NEW.would_trade = 1
BEGIN
  SELECT RAISE(ABORT, 'total exposure cap exceeded')
  WHERE (SELECT COALESCE(SUM(notional_cents), 0) FROM decisions
         WHERE would_trade = 1 AND event_ticker = NEW.event_ticker)
        + NEW.notional_cents > ${MAX_TOTAL_EXPOSURE_CENTS};
END;

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  client_order_id TEXT NOT NULL UNIQUE,
  kalshi_order_id TEXT,
  market_ticker TEXT NOT NULL,
  requested_contracts INTEGER NOT NULL CHECK (requested_contracts > 0),
  position_before_contracts INTEGER NOT NULL,
  filled_contracts INTEGER NOT NULL DEFAULT 0 CHECK (filled_contracts >= 0),
  avg_fill_price_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'filled', 'partial', 'unfilled', 'rejected', 'error', 'unknown',
    'declined-at-execution'
  )),
  error_detail TEXT,
  placed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
`;

export function openLedger(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

/**
 * Construction-time half of the notional-integrity guarantee (the DB CHECK in
 * `SCHEMA` is the other half). Caught here, before any I/O, a mismatch is a clear
 * error naming both numbers rather than an opaque SQLite constraint failure.
 */
function assertNotionalIsConsistent(record: DecisionRecord): void {
  if (!record.wouldTrade) return;
  if (record.entryPriceCents === null) {
    throw new Error(
      `A would-trade decision must carry an entry price, but item ${record.itemId} has entryPriceCents null`
    );
  }
  const expected = record.contracts * record.entryPriceCents;
  if (record.notionalCents !== expected) {
    throw new Error(
      `A would-trade decision's notionalCents must equal contracts x entryPriceCents, but item ` +
        `${record.itemId} has notionalCents ${record.notionalCents} against ${record.contracts} x ` +
        `${record.entryPriceCents} = ${expected}`
    );
  }
}

export function recordDecision(db: Database.Database, record: DecisionRecord): void {
  assertNotionalIsConsistent(record);
  db.prepare(
    `INSERT INTO decisions
      (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
       magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
       would_trade, reason, order_status)
     VALUES (@itemId, @storyKey, @eventTicker, @marketTicker, @side, @rung, @direction,
       @magnitudePts, @contracts, @entryPriceCents, @notionalCents, @edgeCents,
       @wouldTrade, @reason, @orderStatus)`
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

/**
 * Whether this item already has ANY decision row. Redis delivery is at-least-once:
 * a crash or restart mid-item re-delivers the unacked entry, and re-running the
 * pipeline would spend three model calls again and could write a second
 * would-trade row that double-counts against the exposure cap.
 */
export function hasDecisionForItem(db: Database.Database, itemId: string): boolean {
  const row = db.prepare(`SELECT 1 FROM decisions WHERE item_id = ? LIMIT 1`).get(itemId);
  return row !== undefined;
}

/**
 * Exposure for ONE event, not all time. Each week's ladder is its own
 * `event_ticker`, so a resolved week's positions must not keep consuming the cap
 * of the week that follows it -- an all-time sum with no exit logic silences the
 * engine permanently after roughly 20 lifetime trades.
 */
export function totalExposureCents(db: Database.Database, eventTicker: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(notional_cents), 0) AS total FROM decisions
       WHERE would_trade = 1 AND event_ticker = ?`
    )
    .get(eventTicker) as { total: number };
  return row.total;
}

/** Writes a not-yet-executed decision: forced would_trade=0, order_status='pending', regardless of the input record's own wouldTrade -- a pending row is never a confirmed position. Returns the new row's id. */
export function recordPendingDecision(db: Database.Database, record: DecisionRecord): number {
  const pendingRecord: DecisionRecord = { ...record, wouldTrade: false, orderStatus: 'pending' };
  assertNotionalIsConsistent(pendingRecord);
  const info = db.prepare(
    `INSERT INTO decisions
      (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
       magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
       would_trade, reason, order_status)
     VALUES (@itemId, @storyKey, @eventTicker, @marketTicker, @side, @rung, @direction,
       @magnitudePts, @contracts, @entryPriceCents, @notionalCents, @edgeCents,
       @wouldTrade, @reason, @orderStatus)`
  ).run({ ...pendingRecord, wouldTrade: 0 });
  return Number(info.lastInsertRowid);
}

/** Updates a pending decision row in place with the real outcome. */
export function resolveDecision(db: Database.Database, decisionId: number, record: DecisionRecord): void {
  assertNotionalIsConsistent(record);
  db.prepare(
    `UPDATE decisions SET
       market_ticker = @marketTicker, side = @side, contracts = @contracts,
       entry_price_cents = @entryPriceCents, notional_cents = @notionalCents,
       edge_cents = @edgeCents, would_trade = @wouldTrade, reason = @reason,
       order_status = @orderStatus
     WHERE id = @decisionId`
  ).run({ ...record, wouldTrade: record.wouldTrade ? 1 : 0, decisionId });
}

export interface PendingOrderInput {
  decisionId: number;
  clientOrderId: string;
  marketTicker: string;
  requestedContracts: number;
  positionBeforeContracts: number;
}

export function recordPendingOrder(db: Database.Database, input: PendingOrderInput): number {
  const info = db.prepare(
    `INSERT INTO orders
      (decision_id, client_order_id, market_ticker, requested_contracts, position_before_contracts, status)
     VALUES (@decisionId, @clientOrderId, @marketTicker, @requestedContracts, @positionBeforeContracts, 'pending')`
  ).run(input);
  return Number(info.lastInsertRowid);
}

export interface OrderResolution {
  filledContracts: number;
  avgFillPriceCents: number | null;
  status: OrderStatus;
  kalshiOrderId: string | null;
  errorDetail: string | null;
}

export function resolveOrder(db: Database.Database, orderId: number, resolution: OrderResolution): void {
  db.prepare(
    `UPDATE orders SET
       filled_contracts = @filledContracts, avg_fill_price_cents = @avgFillPriceCents,
       status = @status, kalshi_order_id = @kalshiOrderId, error_detail = @errorDetail,
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @orderId`
  ).run({ ...resolution, orderId });
}

export interface PendingOrderRow {
  id: number;
  decisionId: number;
  clientOrderId: string;
  marketTicker: string;
  requestedContracts: number;
  positionBeforeContracts: number;
}

export function findPendingOrders(db: Database.Database): PendingOrderRow[] {
  const rows = db
    .prepare(
      `SELECT id, decision_id AS decisionId, client_order_id AS clientOrderId, market_ticker AS marketTicker,
              requested_contracts AS requestedContracts, position_before_contracts AS positionBeforeContracts
       FROM orders WHERE status = 'pending'`
    )
    .all();
  return rows as PendingOrderRow[];
}
