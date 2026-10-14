// scripts/multi-sizing-dryrun.ts
//
// What would a multi decision buy right now? Reads Kalshi's PUBLIC market data for a series' active event,
// applies the shifts you give on the command line (no model, no ledger, no order), runs the real
// evaluateMultiSizing with the paper caps and prints the table and the legs. Use it to check a series is
// tradeable under the gates before enabling its unit.
import { fetchActiveLadder } from '../src/decide/kalshi.js';
import { evaluateMultiSizing } from '../src/decide/sizing.js';
import { PAPER_CAPS } from '../src/paper/paper.js';
import type { Rung } from '../src/decide/rung.js';

function arg(name: string): string[] {
  const out: string[] = [];
  for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[++i]);
  return out;
}

const series = arg('series')[0];
const moves = arg('move').map((m) => {
  const [market, shift] = m.split('=');
  const n = Number(shift);
  if (!market || !Number.isFinite(n)) throw new Error(`--move must look like TICKER=+6, got ${JSON.stringify(m)}`);
  return { market, shift: n, confidence: 1 };
});
if (!series) throw new Error('usage: multi-dryrun --series SERIES [--move TICKER=+6]... [--rung confirmed] [--group exclusive]');
const rung = (arg('rung')[0] ?? 'confirmed') as Rung;
const group = arg('group')[0] ?? 'independent';

const ladder = await fetchActiveLadder(series);
if (ladder === null) throw new Error(`no open event for ${series}`);
console.log(`event ${ladder.eventTicker}: ${ladder.bands.length} open markets`);
for (const b of ladder.bands.slice(0, 80)) {
  console.log(`  ${b.ticker.padEnd(34)} ${(b.label ?? '').padEnd(28)} bid ${String(b.yesBidCents ?? '-').padStart(3)} ask ${String(b.yesAskCents ?? '-').padStart(3)}`);
}
const result = evaluateMultiSizing({ markets: ladder.bands, moves, maxLegs: group === 'exclusive' ? 2 : 1, rung, currentTotalExposureCents: 0, caps: PAPER_CAPS });
console.log(`\nlegs (${group}, rung ${rung}): ${result.legs.length}`);
for (const l of result.legs) console.log(`  ${l.contracts} ${l.side} ${l.marketTicker} @${l.entryPriceCents}c edge ${l.edgeCents.toFixed(1)}c fairYes ${l.fairYesCents}c`);
for (const r of result.reasons) console.log(`  not bought: ${r}`);
