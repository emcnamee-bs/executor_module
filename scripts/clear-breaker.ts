// scripts/clear-breaker.ts
//
// Manual operator tool: clears every currently-tripped automatic circuit breaker.
// Run this only after confirming the underlying problem is actually resolved --
// clearing does not investigate anything, it only un-halts trading. Not part of
// `npm test` -- invoke directly:
//   direnv exec . npx tsx scripts/clear-breaker.ts

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLedger, clearAllTrips } from '../src/decide/ledger.js';

const DEFAULT_LEDGER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/decisions.db'
);

function main(): void {
  const db = openLedger(DEFAULT_LEDGER_PATH);
  const cleared = clearAllTrips(db);
  db.close();

  if (cleared === 0) {
    console.error('[clear-breaker] no circuit breaker is currently tripped -- nothing to clear');
    process.exit(1);
  }

  console.log(`[clear-breaker] cleared ${cleared} trip(s). Trading will resume on the next decision.`);
}

main();
