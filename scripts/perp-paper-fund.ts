// scripts/perp-paper-fund.ts
// Operator (paper only): add simulated collateral after paper losses. Usage:
//   systemctl --user stop perp-bot
//   npm run perp-paper-fund -- --db data/perp/perp-paper.db --usd 1
//   systemctl --user start perp-bot
// Refuses while the bot holds the database lock: the running bot would overwrite the saved paper state.
import fs from 'node:fs';
import { acquireLedgerLock, type LedgerLock } from '../src/decide/ledgerLock.js';
import { parseArgs } from '../src/perp/ops/args.js';
import { fundPaperInDb } from '../src/perp/ops/paperFund.js';
import { openPerpDb } from '../src/perp/store/db.js';

const USAGE = 'usage: perp-paper-fund --db <path to perp-paper.db> --usd <amount, > 0 and <= 1000>';

const args = parseArgs(process.argv.slice(2), { values: ['db', 'usd'] });
if (!args.ok || args.values.db === undefined || args.values.usd === undefined) {
  if (!args.ok) console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
const file = args.values.db;
const usd = Number(args.values.usd);
if (!fs.existsSync(file)) {
  console.error(`database ${file} does not exist (start the paper bot once first)`);
  console.error(USAGE);
  process.exit(2);
}

let lock: LedgerLock;
try {
  lock = acquireLedgerLock(file);
} catch (err) {
  console.error(`stop the perp-bot unit first (${err instanceof Error ? err.message : String(err)})`);
  process.exit(1);
}
let code = 0;
try {
  const db = openPerpDb(file);
  try {
    const out = fundPaperInDb(db, usd, Date.now());
    console.log(`paper cash ${out.cashBefore.toFixed(4)} -> ${out.cashAfter.toFixed(4)} USD (+${usd})`);
  } finally {
    db.close();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
} finally {
  lock.release();
}
process.exit(code);
