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
}

/**
 * Settles every unsettled paper position whose market has finalized. Rows without a
 * side (capture rows) or a market ticker are never touched. A per-row fetch error is
 * skipped, never thrown: one flaky lookup must not stop the others, and the row simply
 * stays unsettled for the next pass. Returns the number of rows settled.
 */
export async function settlePaperRows(
  db: Database.Database,
  fetchResult: (ticker: string) => Promise<{ status: string; result: string }>
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT id, market_ticker, side, contracts, entry_price_cents
         FROM paper_positions
        WHERE settled_at IS NULL AND market_ticker IS NOT NULL AND side IS NOT NULL`
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
    const pnl = pnlCents(row.side, row.contracts, row.entry_price_cents, outcome.result);
    const info = settle.run({ id: row.id, result: outcome.result, pnl });
    if (info.changes > 0) settled += 1;
  }
  return settled;
}
