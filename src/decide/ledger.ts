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
  settled_at TEXT,
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

-- Mirrors enforce_total_exposure for the UPDATE path. recordPendingDecision always
-- INSERTs with would_trade forced to 0 (the INSERT trigger's WHEN is therefore
-- never true for a real trade), and resolveDecision is what later UPDATEs a row to
-- would_trade=1 with the real fill -- with no trigger here, that path would have no
-- DB-level exposure cap at all, silently losing one of the two defense-in-depth
-- layers this project built specifically for this check. The id != NEW.id clause
-- excludes the row being updated from its own sum: it is the row whose new value is
-- being checked, not a pre-existing sibling to add on top of.
CREATE TRIGGER IF NOT EXISTS enforce_total_exposure_on_resolve
BEFORE UPDATE ON decisions
WHEN NEW.would_trade = 1
BEGIN
  SELECT RAISE(ABORT, 'total exposure cap exceeded')
  WHERE (SELECT COALESCE(SUM(notional_cents), 0) FROM decisions
         WHERE would_trade = 1 AND event_ticker = NEW.event_ticker AND id != NEW.id)
        + NEW.notional_cents > ${MAX_TOTAL_EXPOSURE_CENTS};
END;

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  client_order_id TEXT NOT NULL UNIQUE,
  kalshi_order_id TEXT,
  market_ticker TEXT NOT NULL,
  -- Which leg was bought. Required (never nullable) because reconcilePendingOrders
  -- has ONLY this row to work from at crash recovery, and Kalshi's position field
  -- is signed: without knowing the side, a position diff cannot be interpreted at
  -- all -- a real NO fill moves the position DOWN, and reading that as an unsigned
  -- YES-shaped diff silently records a real position as zero contracts.
  side TEXT NOT NULL CHECK (side IN ('yes','no')),
  requested_contracts INTEGER NOT NULL CHECK (requested_contracts > 0),
  position_before_contracts INTEGER NOT NULL,
  filled_contracts INTEGER NOT NULL DEFAULT 0 CHECK (filled_contracts >= 0),
  avg_fill_price_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'filled', 'partial', 'unfilled', 'rejected', 'error', 'unknown',
    'declined-at-execution'
  )),
  -- Kalshi's OWN word for the order, straight off the createOrder response, kept
  -- purely as an audit trail: fill counts are always derived from a position diff,
  -- never from this. Without it there is no persisted evidence of what the exchange
  -- itself said if the position-diff math is ever wrong again. NULL on every path
  -- where no real response was received (ambiguous failure, rejection, dry run).
  kalshi_order_status TEXT,
  error_detail TEXT,
  placed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS market_blocks (
  market_ticker TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  expected_contracts INTEGER NOT NULL,
  real_contracts INTEGER NOT NULL,
  blocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cleared_at TEXT
);
`;

/**
 * `CREATE TABLE IF NOT EXISTS decisions (...)` is a NO-OP against a `decisions`
 * table that already exists -- so on any machine carrying a `data/decisions.db`
 * written by slices 1-4, the `settled_at` column slice 5 added to `SCHEMA` would
 * silently never be created. The consequence is not a loud failure: `market_blocks`
 * (a brand-new table) gets created fine, `isMarketBlocked` always answers false, and
 * `findOpenUnsettledDecisions` throws `no such column: settled_at` on every single
 * reconciliation pass forever while real trading continues completely unguarded by
 * this slice's safety mechanism.
 *
 * This one column is the ONLY drift slice 5 introduces to a pre-existing table, so
 * this is deliberately one targeted `ALTER TABLE`, not a general migration
 * framework. `ADD COLUMN ... TEXT` (nullable, no default) backfills every existing
 * row as NULL, which is exactly the correct starting state: not yet settled.
 */
function migrateDecisionsSettledAt(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(decisions)`).all() as Array<{ name: string }>;
  const hasSettledAt = columns.some((column) => column.name === 'settled_at');
  if (!hasSettledAt) {
    db.exec(`ALTER TABLE decisions ADD COLUMN settled_at TEXT`);
  }
}

export function openLedger(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrateDecisionsSettledAt(db);
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
  /** Required: crash recovery has only this row to interpret a SIGNED position diff against. */
  side: 'yes' | 'no';
  requestedContracts: number;
  positionBeforeContracts: number;
}

export function recordPendingOrder(db: Database.Database, input: PendingOrderInput): number {
  const info = db.prepare(
    `INSERT INTO orders
      (decision_id, client_order_id, market_ticker, side, requested_contracts, position_before_contracts, status)
     VALUES (@decisionId, @clientOrderId, @marketTicker, @side, @requestedContracts, @positionBeforeContracts, 'pending')`
  ).run(input);
  return Number(info.lastInsertRowid);
}

export interface OrderResolution {
  filledContracts: number;
  avgFillPriceCents: number | null;
  status: OrderStatus;
  kalshiOrderId: string | null;
  /** Kalshi's own status word off the createOrder response; null when none was received. Audit trail only. */
  kalshiOrderStatus: string | null;
  errorDetail: string | null;
}

export function resolveOrder(db: Database.Database, orderId: number, resolution: OrderResolution): void {
  db.prepare(
    `UPDATE orders SET
       filled_contracts = @filledContracts, avg_fill_price_cents = @avgFillPriceCents,
       status = @status, kalshi_order_id = @kalshiOrderId,
       kalshi_order_status = @kalshiOrderStatus, error_detail = @errorDetail,
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @orderId`
  ).run({ ...resolution, orderId });
}

export interface PendingOrderRow {
  id: number;
  decisionId: number;
  clientOrderId: string;
  marketTicker: string;
  side: 'yes' | 'no';
  requestedContracts: number;
  positionBeforeContracts: number;
}

export function findPendingOrders(db: Database.Database): PendingOrderRow[] {
  const rows = db
    .prepare(
      `SELECT id, decision_id AS decisionId, client_order_id AS clientOrderId, market_ticker AS marketTicker,
              side, requested_contracts AS requestedContracts, position_before_contracts AS positionBeforeContracts
       FROM orders WHERE status = 'pending'`
    )
    .all();
  return rows as PendingOrderRow[];
}

export function markDecisionSettled(db: Database.Database, decisionId: number): void {
  db.prepare(`UPDATE decisions SET settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(decisionId);
}

export interface OpenUnsettledDecision {
  id: number;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
}

/**
 * Every would-trade position the ledger still believes is open and not yet
 * confirmed finalized by Kalshi -- the working set the periodic reconciliation pass
 * checks each tick.
 *
 * Rows missing `market_ticker` or `side` are FILTERED OUT here rather than cast
 * non-null and trusted. Nothing enforces non-nullness on those two columns: the
 * schema's CHECK covers entry_price_cents/event_ticker/notional only, and
 * assertNotionalIsConsistent checks the same three -- neither says anything about
 * these. And the consequences are not cosmetic: a would_trade=1 row with a NULL
 * `side` would be summed with the WRONG SIGN into a real-money block decision (this
 * project's worst bug to date was a sign error on Kalshi's signed position), and a
 * NULL `market_ticker` would group under a null key and fail every pass forever. A
 * row in either state is a bug worth investigating, but it must not be allowed to
 * silently invert a safety check in the meantime.
 */
export function findOpenUnsettledDecisions(db: Database.Database): OpenUnsettledDecision[] {
  const rows = db
    .prepare(
      `SELECT id, market_ticker AS marketTicker, side, contracts
       FROM decisions
       WHERE would_trade = 1 AND settled_at IS NULL
         AND market_ticker IS NOT NULL AND side IS NOT NULL`
    )
    .all();
  return rows as OpenUnsettledDecision[];
}

export function isMarketBlocked(db: Database.Database, marketTicker: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM market_blocks WHERE market_ticker = ? AND cleared_at IS NULL`)
    .get(marketTicker);
  return row !== undefined;
}

/**
 * Blocks a market_ticker from further NEW order placement (checked by placeOrder).
 * An UPSERT: blocking an already-active block updates its reason/counts; blocking a
 * PREVIOUSLY-CLEARED ticker reactivates it (cleared_at reset to NULL) rather than
 * silently no-op-ing -- a market can legitimately diverge again after a human clears
 * an earlier block.
 */
export function blockMarket(
  db: Database.Database,
  marketTicker: string,
  reason: string,
  expectedContracts: number,
  realContracts: number
): void {
  db.prepare(
    `INSERT INTO market_blocks (market_ticker, reason, expected_contracts, real_contracts)
     VALUES (@marketTicker, @reason, @expectedContracts, @realContracts)
     ON CONFLICT(market_ticker) DO UPDATE SET
       reason = @reason, expected_contracts = @expectedContracts, real_contracts = @realContracts,
       blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cleared_at = NULL`
  ).run({ marketTicker, reason, expectedContracts, realContracts });
}
