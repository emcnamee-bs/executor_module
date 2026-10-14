// scripts/perp-clear-halt.ts
// Operator: lift a kill-switch halt. Usage: npm run perp-clear-halt -- --db data/perp/perp-paper.db [--force]
// Works while the bot is running (it re-reads the risk state every tick). Exits and equity peaks from before now stop
// counting (a new kill-switch epoch). Refuses when the bot is not halted unless --force (which only resets the epoch).
import fs from 'node:fs';
import { parseArgs } from '../src/perp/ops/args.js';
import { clearHaltInDb, shouldClear } from '../src/perp/ops/clearHalt.js';
import { loadRiskState, openPerpDb } from '../src/perp/store/db.js';

const USAGE = 'usage: perp-clear-halt --db <path to perp-<mode>.db> [--force]';

const args = parseArgs(process.argv.slice(2), { values: ['db'], booleans: ['force'] });
if (!args.ok || args.values.db === undefined) {
  if (!args.ok) console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
const file = args.values.db;
if (!fs.existsSync(file)) {
  console.error(`database ${file} does not exist`);
  console.error(USAGE);
  process.exit(2);
}
const db = openPerpDb(file);
const risk = loadRiskState(db);
if (!shouldClear(risk.halted, args.flags.has('force'))) {
  console.error(
    'the bot is not halted; nothing to clear. Re-run with --force only to start a fresh kill-switch epoch ' +
      '(this resets the kill-switch lookback: older exits and the old equity peak stop counting).'
  );
  db.close();
  process.exit(1);
}
const out = clearHaltInDb(db, Date.now());
console.log(out.wasHalted ? `cleared halt (was: ${out.reason})` : 'the bot was not halted; recorded a fresh kill-switch epoch (--force)');
db.close();
