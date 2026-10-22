// scripts/intake-lab-report.ts
// Regenerates the intake-lab report from the preserved databases (read-only on both).
// Usage: npm run intake-lab-report -- --lab data/perp/lab.db [--bot data/perp/perp-paper.db] [--out data/perp/intake-lab-week1.md]
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { buildReport } from '../src/perp/lab/report.js';
import { parseArgs } from '../src/perp/ops/args.js';

const USAGE = 'usage: intake-lab-report --lab <lab.db> [--bot <perp-paper.db>] [--out <file.md>]';
const args = parseArgs(process.argv.slice(2), { values: ['lab', 'bot', 'out'] });
if (!args.ok || args.values.lab === undefined) {
  if (!args.ok) console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
const lab = new Database(args.values.lab, { readonly: true, fileMustExist: true });
const bot = args.values.bot === undefined ? null : new Database(args.values.bot, { readonly: true, fileMustExist: true });
const md = buildReport(lab, bot, Date.now());
if (args.values.out === undefined) console.log(md);
else {
  fs.writeFileSync(args.values.out, md);
  console.log(`wrote ${args.values.out}`);
}
