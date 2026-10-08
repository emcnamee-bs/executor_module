// scripts/clear-market-block.ts
//
// Manually clears a market_blocks entry after a human has investigated and
// confirmed it's safe to resume trading that market_ticker. Not part of `npm test`
// -- invoke directly:
//   EXECUTOR_TRADE=<trade> direnv exec . npx tsx scripts/clear-market-block.ts <market_ticker>
// EXECUTOR_TRADE is required (each trade has its own ledger); a missing ledger is an error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openExistingLedger } from '../src/decide/ledger.js';
import { resolveTradeLedger } from '../src/profile/profile.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const marketTicker = process.argv[2];
  if (!marketTicker) {
    console.error('Usage: npm run clear-block -- <market_ticker>');
    process.exit(1);
  }

  const { trade, ledgerPath } = resolveTradeLedger(process.env, REPO_ROOT);
  console.log(`[clear-market-block] trade=${trade} ledger=${ledgerPath}`);
  const db = openExistingLedger(ledgerPath);
  const result = db
    .prepare(
      `UPDATE market_blocks SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE market_ticker = ? AND cleared_at IS NULL`
    )
    .run(marketTicker);

  if (result.changes === 0) {
    console.error(`No active block found for market_ticker=${marketTicker}`);
    db.close();
    process.exit(1);
  }

  console.log(`Cleared block for market_ticker=${marketTicker}`);
  db.close();
}

main();
