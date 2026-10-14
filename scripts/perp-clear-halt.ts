// scripts/perp-clear-halt.ts
// Operator: lift a kill-switch halt. Usage: npm run perp-clear-halt -- --db data/perp/perp-paper.db
// Works while the bot is running (it re-reads the risk state every tick). Exits and equity peaks from before now stop counting.
import { clearHaltInDb } from '../src/perp/ops/clearHalt.js';
import { openPerpDb } from '../src/perp/store/db.js';

const i = process.argv.indexOf('--db');
const file = i >= 0 ? process.argv[i + 1] : undefined;
if (!file) {
  console.error('usage: perp-clear-halt --db <path to perp-<mode>.db>');
  process.exit(2);
}
const db = openPerpDb(file);
const out = clearHaltInDb(db, Date.now());
console.log(out.wasHalted ? `cleared halt (was: ${out.reason})` : 'the bot was not halted; recorded a fresh kill-switch epoch anyway');
db.close();
