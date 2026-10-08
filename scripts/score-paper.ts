// scripts/score-paper.ts
//
// Settles finalized paper positions in one trade's ledger and prints a per-trade summary.
// Read-only against Kalshi (public market lookups); writes only paper_positions. Not part
// of `npm test` -- invoke directly:
//   EXECUTOR_LEDGER_PATH=data/<trade>/decisions.db npm run score-paper

import { openLedger } from '../src/decide/ledger.js';
import { fetchMarketStatus } from '../src/decide/kalshi.js';
import { settlePaperRows } from '../src/paper/score.js';

async function main(): Promise<void> {
  const ledgerPath = process.env.EXECUTOR_LEDGER_PATH;
  if (!ledgerPath) throw new Error('EXECUTOR_LEDGER_PATH must be set to the ledger file to score');

  const db = openLedger(ledgerPath);
  // fetchMarketStatus is deliberately called WITHOUT the db argument: with it, a Kalshi
  // lookup failure would be recorded in kalshi_errors and could feed the live circuit
  // breaker. Paper scoring must never be able to halt trading.
  const settled = await settlePaperRows(db, (ticker) => fetchMarketStatus(ticker));

  const summary = db
    .prepare(
      `SELECT trade,
              COUNT(*) AS positions,
              SUM(settled_at IS NOT NULL) AS settled,
              COALESCE(SUM(pnl_cents), 0) AS gross_pnl_cents
         FROM paper_positions
        WHERE side IS NOT NULL
        GROUP BY trade`
    )
    .all();
  db.close();

  console.log(`[score-paper] settled ${settled} position(s) this pass`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error('[score-paper] failed:', err);
  process.exit(1);
});
