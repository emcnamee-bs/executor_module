// scripts/clear-breaker.ts
//
// Manual operator tool: clears every currently-tripped automatic circuit breaker.
// Run this only after confirming the underlying problem is actually resolved --
// clearing does not investigate anything, it only un-halts trading. Not part of
// `npm test` -- invoke directly:
//   EXECUTOR_TRADE=<trade> direnv exec . npx tsx scripts/clear-breaker.ts
// EXECUTOR_TRADE is required: each trade has its own ledger, and clearing the wrong one
// would un-halt a different trade. A missing ledger is an error, never created.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openExistingLedger, clearAllTrips } from '../src/decide/ledger.js';
import { resolveTradeLedger } from '../src/profile/profile.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const { trade, ledgerPath } = resolveTradeLedger(process.env, REPO_ROOT);
  console.log(`[clear-breaker] trade=${trade} ledger=${ledgerPath}`);
  const db = openExistingLedger(ledgerPath);
  const cleared = clearAllTrips(db);
  db.close();

  if (cleared === 0) {
    console.error('[clear-breaker] no circuit breaker is currently tripped -- nothing to clear');
    process.exit(1);
  }

  console.log(`[clear-breaker] cleared ${cleared} trip(s). Trading will resume on the next decision.`);
}

main();
