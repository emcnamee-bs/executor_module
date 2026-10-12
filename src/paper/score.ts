// src/paper/score.ts
import type Database from 'better-sqlite3';

/**
 * Gross P&L in cents for a simulated position, matching the project convention that
 * stored P&L ignores Kalshi trading fees (so it is an upper bound on net P&L).
 * A winning contract pays 100c against its entry price; a losing one loses its entry.
 */
export function pnlCents(
  side: 'yes' | 'no',
  contracts: number,
  entryPriceCents: number,
  result: 'yes' | 'no'
): number {
  return side === result ? contracts * (100 - entryPriceCents) : -contracts * entryPriceCents;
}

interface OpenRow {
  id: number;
  market_ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entry_price_cents: number;
  /** Contracts already sold by exit fills, and what they earned (gross). */
  exited_contracts: number;
  exit_pnl_cents: number;
}

/**
 * Settles every unsettled paper position whose market has finalized. Rows without a
 * side (capture rows) or a market ticker are never touched. A per-row fetch error is
 * skipped, never thrown: one flaky lookup must not stop the others, and the row simply
 * stays unsettled for the next pass. Returns the number of rows settled.
 * Contracts already sold by exits are not re-scored: P&L is the exit fills plus the settlement of what remains.
 */
export async function settlePaperRows(
  db: Database.Database,
  fetchResult: (ticker: string) => Promise<{ status: string; result: string }>
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT p.id, p.market_ticker, p.side, p.contracts, p.entry_price_cents,
              COALESCE((SELECT SUM(e.contracts) FROM paper_exits e WHERE e.position_id = p.id), 0) AS exited_contracts,
              COALESCE((SELECT SUM(e.pnl_cents) FROM paper_exits e WHERE e.position_id = p.id), 0) AS exit_pnl_cents
         FROM paper_positions p
        WHERE p.settled_at IS NULL AND p.market_ticker IS NOT NULL AND p.side IS NOT NULL`
    )
    .all() as OpenRow[];

  const settle = db.prepare(
    `UPDATE paper_positions
        SET settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), result = @result, pnl_cents = @pnl
      WHERE id = @id AND settled_at IS NULL`
  );

  let settled = 0;
  for (const row of rows) {
    let outcome: { status: string; result: string };
    try {
      outcome = await fetchResult(row.market_ticker);
    } catch {
      continue;
    }
    if (outcome.status !== 'finalized' && outcome.status !== 'settled') continue;
    if (outcome.result !== 'yes' && outcome.result !== 'no') continue;
    const remaining = row.contracts - row.exited_contracts;
    if (remaining <= 0) continue; // fully exited rows are closed by recordExitFill and should not reach here
    const pnl = row.exit_pnl_cents + pnlCents(row.side, remaining, row.entry_price_cents, outcome.result);
    const info = settle.run({ id: row.id, result: outcome.result, pnl });
    if (info.changes > 0) settled += 1;
  }
  return settled;
}
