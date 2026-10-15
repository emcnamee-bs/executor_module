// scripts/replay-guards.ts
//
// Replays the paper guards (src/decide/guards.ts) over exported paper positions to show which entries they
// would have declined and what those entries went on to earn. Read-only; the input is a JSON array exported from
// the ledgers' paper_positions (id, trade, structure, market_ticker, side, contracts, entry_price_cents,
// direction, magnitude, edge_cents, ladder_json, settled_at, pnl_cents).
//
// Usage: npx tsx scripts/replay-guards.ts <positions.json> [outcomes.json]
//   outcomes.json (optional): { "<market_ticker>": <final pnl cents per contract bought> } is not needed; unsettled
//   rows are listed without a result.
import fs from 'node:fs';
import { buildThresholdCurve, buildProbabilityCurve, typicalBandWidthPts } from '../src/decide/sizing.js';
import { ladderIqr, tailEdgeProblem, PAPER_GUARDS } from '../src/decide/guards.js';
import type { BandMarket } from '../src/decide/kalshi.js';

interface Row {
  id: number; trade: string; structure: string; market_ticker: string; side: 'yes' | 'no'; contracts: number;
  entry_price_cents: number; direction: 'up' | 'down' | null; magnitude: number | null; edge_cents: number | null;
  ladder_json: string; settled_at: string | null; result: string | null; pnl_cents: number | null;
}

const file = process.argv[2];
if (!file) throw new Error('usage: replay-guards.ts <positions.json>');
const rows = JSON.parse(fs.readFileSync(file, 'utf-8')) as Row[];

let declined = 0;
let declinedPnl = 0;
let declinedKnown = 0;
for (const r of rows) {
  const bands = (JSON.parse(r.ladder_json).bands ?? []) as BandMarket[];
  const kind = r.structure === 'threshold' ? 'threshold' : r.structure === 'band' ? 'band' : null;
  let ratio: number | null = null;
  let iqr: number | null = null;
  if (kind !== null && r.magnitude !== null) {
    const curve = kind === 'threshold' ? buildThresholdCurve(bands) : buildProbabilityCurve(bands, typicalBandWidthPts(bands));
    iqr = ladderIqr(curve, kind);
    ratio = iqr === null ? null : r.magnitude / iqr;
  }
  const tail = r.edge_cents === null ? null : tailEdgeProblem(r.entry_price_cents, r.edge_cents, PAPER_GUARDS);
  const shiftBlocked = ratio !== null && ratio > PAPER_GUARDS.maxShiftIqrMultiple;
  const blocked = shiftBlocked || tail !== null;
  if (blocked) declined += 1;
  if (blocked && r.pnl_cents !== null) { declinedPnl += r.pnl_cents; declinedKnown += 1; }
  console.log(
    `${r.trade.padEnd(15)} #${String(r.id).padEnd(3)} ${r.side} ${String(r.contracts).padStart(2)}@${String(r.entry_price_cents).padEnd(2)} edge ${String(r.edge_cents ?? '-').padEnd(4)} ` +
      `mag ${String(r.magnitude ?? '-').padEnd(5)} iqr ${iqr === null ? '-' : iqr.toPrecision(3)} ratio ${ratio === null ? '-' : ratio.toFixed(1)} ` +
      `${shiftBlocked ? 'SHIFT ' : ''}${tail !== null ? 'TAIL ' : ''}${blocked ? 'DECLINE' : 'ok'} ` +
      `pnl ${r.pnl_cents === null ? 'open' : r.pnl_cents}`
  );
}
console.log(`\n${declined}/${rows.length} entries declined; of those ${declinedKnown} are settled/closed with total pnl ${declinedPnl}c`);
