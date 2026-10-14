// scripts/perp-report.ts
// Read-only evaluation of a bot database. Usage: npm run perp-report -- --db data/perp/perp-paper.db [--days 30]
import Database from 'better-sqlite3';
import { brierScore, bucketTable, outcomesFor } from '../src/perp/eval/calibration.js';
import type { ImpactAssessment } from '../src/perp/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg('db');
if (!file) {
  console.error('usage: perp-report --db <path to perp-<mode>.db> [--days N]');
  process.exit(2);
}
const days = Number(arg('days') ?? 30);
if (!Number.isFinite(days) || days <= 0) {
  console.error('--days must be a positive number');
  process.exit(2);
}
const since = Date.now() - days * 86_400_000;
const db = new Database(file, { readonly: true, fileMustExist: true });
const pct = (x: number | null): string => (x === null ? 'n/a' : `${(x * 100).toFixed(2)}%`);

console.log(`== ${file} (last ${days} days) ==`);

const eq = db.prepare('SELECT MIN(equity) AS lo, MAX(equity) AS hi, COUNT(*) AS n FROM equity WHERE ts_ms >= ?').get(since) as { lo: number | null; hi: number | null; n: number };
const first = db.prepare('SELECT equity FROM equity WHERE ts_ms >= ? ORDER BY ts_ms ASC LIMIT 1').get(since) as { equity: number } | undefined;
const last = db.prepare('SELECT equity FROM equity ORDER BY ts_ms DESC LIMIT 1').get() as { equity: number } | undefined;
console.log(`equity: start ${first?.equity.toFixed(3) ?? 'n/a'} -> now ${last?.equity.toFixed(3) ?? 'n/a'}  (low ${eq.lo?.toFixed(3) ?? 'n/a'}, high ${eq.hi?.toFixed(3) ?? 'n/a'}, ${eq.n} samples)`);
const topUps = (db.prepare("SELECT payload FROM journal WHERE kind = 'paper_funded' AND ts_ms >= ?").all(since) as Array<{ payload: string }>)
  .map((r) => Number((JSON.parse(r.payload) as { usd?: unknown }).usd))
  .filter(Number.isFinite);
console.log(`paper top-ups: ${topUps.reduce((s, x) => s + x, 0).toFixed(3)} USD (${topUps.length}); P&L = equity change minus top-ups`);

const exits = db.prepare('SELECT at_ms, rule, side, pnl_usd FROM exits WHERE at_ms >= ? ORDER BY at_ms').all(since) as Array<{ at_ms: number; rule: string; side: string; pnl_usd: number }>;
console.log(`\nexits: ${exits.length}, total P&L ${exits.reduce((s, e) => s + e.pnl_usd, 0).toFixed(3)} USD`);
const byRule = new Map<string, { n: number; pnl: number }>();
for (const e of exits) {
  const r = byRule.get(`${e.rule}/${e.side}`) ?? { n: 0, pnl: 0 };
  r.n += 1;
  r.pnl += e.pnl_usd;
  byRule.set(`${e.rule}/${e.side}`, r);
}
for (const [k, v] of byRule) console.log(`  ${k.padEnd(24)} n=${v.n}  pnl=${v.pnl.toFixed(3)}`);

const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM journal WHERE ts_ms >= ? GROUP BY kind ORDER BY n DESC').all(since) as Array<{ kind: string; n: number }>;
console.log('\njournal rows by kind:', kinds.map((k) => `${k.kind}=${k.n}`).join(', ') || 'none');

// model_calls is created lazily by the first model call, so a database that has never called the model has no such
// table. The connection is read-only, so we must not create it here: check for it first.
const hasModelCalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_calls'").get() !== undefined;
const spend = hasModelCalls
  ? (db.prepare('SELECT stage, COUNT(*) AS n, SUM(ok) AS ok, ROUND(SUM(cost_usd), 4) AS usd FROM model_calls WHERE called_at_ms >= ? GROUP BY stage').all(since) as Array<{ stage: string; n: number; ok: number; usd: number }>)
  : [];
console.log('model calls:', spend.map((s) => `${s.stage}: ${s.n} calls (${s.ok} ok) $${s.usd}`).join('; ') || 'none');

const assessments = (db.prepare('SELECT json FROM assessments WHERE received_ms >= ? ORDER BY received_ms').all(since) as Array<{ json: string }>).map((r) => JSON.parse(r.json) as ImpactAssessment);
const marks = (db.prepare('SELECT ts_ms, mark FROM snapshots WHERE ts_ms >= ? ORDER BY ts_ms').all(since - 86_400_000) as Array<{ ts_ms: number; mark: number }>).map((r) => ({ tsMs: r.ts_ms, mark: r.mark }));
const outcomes = outcomesFor(assessments, marks);
console.log(`\nassessments: ${assessments.length} (${outcomes.length} directional with a baseline price)`);
for (const h of ['1d', '5d'] as const) {
  const b = brierScore(outcomes, h);
  console.log(`  Brier ${h}: ${b.brier === null ? 'n/a' : b.brier.toFixed(3)} over ${b.n} items (0.25 = coin-flip calibration; lower is better)`);
}
console.log('  per magnitude bucket (move realized in the item\'s direction):');
for (const r of bucketTable(outcomes)) {
  console.log(`    ${r.bucket.padEnd(9)} n=${String(r.n).padEnd(4)} 1d mean ${pct(r.meanRealized1d).padStart(8)}  hit ${r.hitRate1d === null ? 'n/a' : (r.hitRate1d * 100).toFixed(0) + '%'}  5d mean ${pct(r.meanRealized5d)}`);
}
db.close();
