// scripts/perp-history.ts
// Read-only price history from a bot database, sized for an investigating agent (a summary line plus at most --max-rows rows).
// Usage: npm run perp-history -- --db data/perp/perp-paper.db [--from 24h] [--to now] [--max-rows 200]
//   --from/--to: ISO time, epoch ms, or "<N>m|h|d" ago (to defaults to now, from defaults to 24h).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { marksReport, parseWhen } from '../src/perp/ops/history.js';
import { parseArgs } from '../src/perp/ops/args.js';

const USAGE = 'usage: perp-history --db <path to perp-<mode>.db> [--from 24h] [--to now] [--max-rows 200]';
const args = parseArgs(process.argv.slice(2), { values: ['db', 'from', 'to', 'max-rows'] });
if (!args.ok || args.values.db === undefined) {
  if (!args.ok) console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
const now = Date.now();
const from = parseWhen(args.values.from ?? '24h', now);
const to = args.values.to === undefined || args.values.to === 'now' ? now : parseWhen(args.values.to, now);
const maxRows = Number(args.values['max-rows'] ?? 200);
if (from === null || to === null || from > to) {
  console.error('--from/--to must be an ISO time, epoch ms or <N>m|h|d ago, with from <= to');
  console.error(USAGE);
  process.exit(2);
}
if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 5000) {
  console.error('--max-rows must be an integer from 1 to 5000');
  console.error(USAGE);
  process.exit(2);
}
if (!fs.existsSync(args.values.db)) {
  console.error(`database ${args.values.db} does not exist`);
  console.error(USAGE);
  process.exit(2);
}
const db = new Database(args.values.db, { readonly: true, fileMustExist: true });
const hasMarks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='marks'").get() !== undefined;
if (!hasMarks) {
  console.error('this database has no marks table yet (it is created when the bot starts on a version that records marks)');
  process.exit(1);
}
const report = marksReport(db, from, to, maxRows);
console.log(report.header);
for (const r of report.rows) console.log(`${new Date(r.tsMs).toISOString()},${r.mark}`);
