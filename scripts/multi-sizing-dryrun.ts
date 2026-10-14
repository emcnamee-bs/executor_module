// scripts/multi-sizing-dryrun.ts
//
// What would multi sizing buy right now? Reads Kalshi's PUBLIC market data for a series' active event,
// applies the shifts you give on the command line (no model, no ledger, no order), runs the real
// evaluateMultiSizing with the paper caps and prints the table and the legs. It runs ONLY evaluateMultiSizing on
// the moves you type: it does not apply checkMultiMoves (group rules, ladder repair, 4-move cap) or the
// sell-trigger filter. Use it to check a series is tradeable under the gates before enabling its unit.
import { fetchActiveLadder } from '../src/decide/kalshi.js';
import { evaluateMultiSizing } from '../src/decide/sizing.js';
import { PAPER_CAPS } from '../src/paper/paper.js';
import { OUTCOME_GROUPS, type OutcomeGroup } from '../src/profile/profile.js';
import { RUNG_STAKES, type Rung } from '../src/decide/rung.js';

const USAGE = 'usage: multi-dryrun --series SERIES [--move TICKER=+6]... [--rung reported|corroborated|confirmed|rumor] [--group ladder|exclusive|independent]';
const FLAGS = new Set(['series', 'move', 'rung', 'group']);

// Every argument must be a known `--flag value` pair; a flag with no value (e.g. `--move` last) is an error.
const args = new Map<string, string[]>();
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  const name = flag.startsWith('--') ? flag.slice(2) : '';
  if (!FLAGS.has(name)) throw new Error(`unknown argument ${JSON.stringify(flag)}\n${USAGE}`);
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
  args.set(name, [...(args.get(name) ?? []), value]);
}
const arg = (name: string): string[] => args.get(name) ?? [];

const series = arg('series')[0];
if (!series) throw new Error(USAGE);
const moves = arg('move').map((m) => {
  const [market, shift] = m.split('=');
  const n = Number(shift);
  if (!market || shift === undefined || shift.trim() === '' || !Number.isFinite(n)) throw new Error(`--move must look like TICKER=+6, got ${JSON.stringify(m)}`);
  return { market, shift: n, confidence: 1 };
});

const rungArg = arg('rung')[0] ?? 'reported';
if (!Object.prototype.hasOwnProperty.call(RUNG_STAKES, rungArg)) {
  throw new Error(`--rung must be one of ${Object.keys(RUNG_STAKES).join('|')}, got ${JSON.stringify(rungArg)}`);
}
const rung = rungArg as Rung;
const groupArg = arg('group')[0] ?? 'independent';
if (!(OUTCOME_GROUPS as readonly string[]).includes(groupArg)) {
  throw new Error(`--group must be one of ${OUTCOME_GROUPS.join('|')}, got ${JSON.stringify(groupArg)}`);
}
const group = groupArg as OutcomeGroup;

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
