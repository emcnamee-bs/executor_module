// src/paper/exits.ts
//
// Every read and write of the paper exit tables lives here (spec sections 3, 4, 6).
// A fully sold position is closed by writing settled_at / result NULL / pnl_cents = sum of
// its fills, so existing consumers of paper_positions need no change.
import type Database from 'better-sqlite3';

export type ExitVerdict = 'sell' | 'hold' | 'error';
export type ExitMarker = 'unsellable' | 'held_to_settlement';

export interface OpenPaperPosition {
  id: number;
  trade: string;
  itemId: string;
  structure: 'band' | 'threshold' | 'binary' | 'capture' | 'multi';
  eventTicker: string;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
  /** contracts minus everything already sold. */
  remaining: number;
}

const OPEN_POSITIONS_SQL = `
  SELECT p.id, p.trade, p.item_id AS itemId, p.structure, p.event_ticker AS eventTicker,
         p.market_ticker AS marketTicker, p.side, p.contracts, p.entry_price_cents AS entryPriceCents,
         p.contracts - COALESCE((SELECT SUM(e.contracts) FROM paper_exits e WHERE e.position_id = p.id), 0) AS remaining
    FROM paper_positions p
   WHERE p.side IS NOT NULL AND p.market_ticker IS NOT NULL AND p.settled_at IS NULL
   ORDER BY p.id`;

/** Unsettled paper positions that still hold contracts (capture rows never appear). */
export function listOpenPaperPositions(db: Database.Database): OpenPaperPosition[] {
  return (db.prepare(OPEN_POSITIONS_SQL).all() as OpenPaperPosition[]).filter((p) => p.remaining > 0);
}

/** Contracts of a position not yet sold by exits (0 when the position does not exist). */
export function remainingContracts(db: Database.Database, positionId: number): number {
  const row = db
    .prepare(
      `SELECT p.contracts - COALESCE((SELECT SUM(e.contracts) FROM paper_exits e WHERE e.position_id = p.id), 0) AS remaining
         FROM paper_positions p WHERE p.id = ?`
    )
    .get(positionId) as { remaining: number } | undefined;
  return row?.remaining ?? 0;
}

export interface ExitReviewRecord {
  trade: string;
  itemId: string;
  positionId: number;
  shift: number | null;
  confidence: number | null;
  reason: string | null;
  midCents: number | null;
  fairAfterCents: number | null;
  lossCents: number | null;
  exitCostCents: number | null;
  verdict: ExitVerdict;
  verdictReason: string | null;
  lagJson: string | null;
  /** Unified mode: what the model recommended for this position (NULL for a classic review). */
  modelAction?: 'hold' | 'sell' | null;
  decisionMode?: 'classic' | 'unified' | null;
}

/** One audit row per review. UNIQUE (item_id, position_id): a redelivered item cannot be reviewed twice. */
export function recordExitReview(db: Database.Database, rec: ExitReviewRecord): number {
  const info = db
    .prepare(
      `INSERT INTO paper_exit_reviews
        (trade, item_id, position_id, shift, confidence, reason, mid_cents, fair_after_cents,
         loss_cents, exit_cost_cents, verdict, verdict_reason, lag_json, model_action, decision_mode)
       VALUES
        (@trade, @itemId, @positionId, @shift, @confidence, @reason, @midCents, @fairAfterCents,
         @lossCents, @exitCostCents, @verdict, @verdictReason, @lagJson, @modelAction, @decisionMode)`
    )
    .run({ ...rec, modelAction: rec.modelAction ?? null, decisionMode: rec.decisionMode ?? null });
  return Number(info.lastInsertRowid);
}

export function updateReviewLag(db: Database.Database, reviewId: number, lagJson: string): void {
  db.prepare(`UPDATE paper_exit_reviews SET lag_json = ? WHERE id = ?`).run(lagJson, reviewId);
}

export function hasExitReview(db: Database.Database, itemId: string, positionId: number): boolean {
  return db.prepare(`SELECT 1 FROM paper_exit_reviews WHERE item_id = ? AND position_id = ?`).get(itemId, positionId) !== undefined;
}

/** True once any review of this position said sell (the trigger has fired; the timer finishes the sale). */
export function positionHasSellReview(db: Database.Database, positionId: number): boolean {
  return db.prepare(`SELECT 1 FROM paper_exit_reviews WHERE position_id = ? AND verdict = 'sell' LIMIT 1`).get(positionId) !== undefined;
}

/** True when any position in this market has had a sell trigger: entry must not re-buy it. */
export function hasSellTrigger(db: Database.Database, marketTicker: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM paper_exit_reviews r JOIN paper_positions p ON p.id = r.position_id
          WHERE p.market_ticker = ? AND r.verdict = 'sell' LIMIT 1`
      )
      .get(marketTicker) !== undefined
  );
}

export interface ExitFillInput {
  positionId: number;
  reviewId: number;
  contracts: number;
  /** Sale price in the position's own side cents (YES: yes bid; NO: 100 - yes ask). */
  priceCents: number;
  filledAt?: string;
}

export interface ExitFillResult {
  exitId: number;
  pnlCents: number;
  remaining: number;
  closed: boolean;
}

/**
 * Records one simulated fill atomically. Throws, writing nothing, for an unknown/capture/settled
 * position, a non-positive size, or more contracts than remain. The fill that sells the last
 * contract closes the position (settled_at, result NULL, pnl_cents = sum of fills).
 */
export function recordExitFill(db: Database.Database, input: ExitFillInput): ExitFillResult {
  return db.transaction((): ExitFillResult => {
    const pos = db
      .prepare(
        `SELECT id, side, contracts, entry_price_cents AS entry, settled_at AS settledAt FROM paper_positions WHERE id = ?`
      )
      .get(input.positionId) as { id: number; side: string | null; contracts: number; entry: number | null; settledAt: string | null } | undefined;
    if (pos === undefined) throw new Error(`paper position ${input.positionId} not found`);
    if (pos.side === null || pos.entry === null) throw new Error(`paper position ${input.positionId} is a capture row: nothing to sell`);
    if (pos.settledAt !== null) throw new Error(`paper position ${input.positionId} is already settled or closed`);
    if (!Number.isInteger(input.contracts) || input.contracts <= 0) {
      throw new Error('an exit fill needs a positive whole number of contracts');
    }
    const sold = (db.prepare(`SELECT COALESCE(SUM(contracts), 0) AS n FROM paper_exits WHERE position_id = ?`).get(input.positionId) as { n: number }).n;
    const remainingBefore = pos.contracts - sold;
    if (input.contracts > remainingBefore) {
      throw new Error(`cannot sell ${input.contracts} contracts: only ${remainingBefore} remaining on position ${input.positionId}`);
    }
    const pnl = input.contracts * (input.priceCents - pos.entry);
    const closed = input.contracts === remainingBefore;
    const filledAt = input.filledAt ?? new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO paper_exits (position_id, review_id, contracts, price_cents, pnl_cents, status, filled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.positionId, input.reviewId, input.contracts, input.priceCents, pnl, closed ? 'filled' : 'partial', filledAt);
    if (closed) {
      db.prepare(
        `UPDATE paper_positions
            SET settled_at = ?, result = NULL,
                pnl_cents = (SELECT SUM(pnl_cents) FROM paper_exits WHERE position_id = ?)
          WHERE id = ? AND settled_at IS NULL`
      ).run(filledAt, input.positionId, input.positionId);
    }
    return { exitId: Number(info.lastInsertRowid), pnlCents: pnl, remaining: remainingBefore - input.contracts, closed };
  })();
}

/**
 * Writes an `unsellable` / `held_to_settlement` marker row only when the position's latest
 * paper_exits row does not already carry that status, so a 20 s retry never grows the table.
 * Returns whether a row was written.
 */
export function recordExitMarker(db: Database.Database, positionId: number, reviewId: number, status: ExitMarker): boolean {
  const last = db.prepare(`SELECT status FROM paper_exits WHERE position_id = ? ORDER BY id DESC LIMIT 1`).get(positionId) as
    | { status: string }
    | undefined;
  if (last?.status === status) return false;
  db.prepare(
    `INSERT INTO paper_exits (position_id, review_id, contracts, price_cents, pnl_cents, status) VALUES (?, ?, 0, NULL, 0, ?)`
  ).run(positionId, reviewId, status);
  return true;
}

export interface PendingExit {
  position: OpenPaperPosition;
  /** The first sell review for the position (the trigger). */
  reviewId: number;
}

/** Open positions whose trigger fired but which still hold contracts and were not given up on. */
export function pendingExits(db: Database.Database): PendingExit[] {
  const trigger = db.prepare(`SELECT id FROM paper_exit_reviews WHERE position_id = ? AND verdict = 'sell' ORDER BY id LIMIT 1`);
  const held = db.prepare(`SELECT 1 FROM paper_exits WHERE position_id = ? AND status = 'held_to_settlement' LIMIT 1`);
  const out: PendingExit[] = [];
  for (const position of listOpenPaperPositions(db)) {
    const t = trigger.get(position.id) as { id: number } | undefined;
    if (t === undefined || held.get(position.id) !== undefined) continue;
    out.push({ position, reviewId: t.id });
  }
  return out;
}
