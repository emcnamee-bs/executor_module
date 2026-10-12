// scripts/validate-bank.ts
//
// Replays a trade's keyphrase list over the iip news archive (read-only) and asks the production relevance gate whether a
// sample of each frequent phrase's hits is relevant. Prints a per-phrase report; with --apply it drops the phrases the gate
// rejects (the old list is backed up outside the repo). Costs about $0.0002 per gate call; --max-calls caps it per trade.
//   npm run validate-bank -- --trade kxgoldmon                  report only
//   npm run validate-bank -- --all --exclude kxaprpotus --apply  validate and trim every paper trade
// Flags: --trade a,b | --all, --exclude, --apply, --iip-db, --since-days, --max-calls, --min-hits, --max-pass-rate,
//        --sample, --floor, --backup-dir, --json <file>
// The hand-pinned live profile is never edited, even with --apply.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { parseValidateArgs } from '../src/profile/validateArgs.js';
import { loadCorpusFromIipDb } from '../src/profile/validate.js';
import { runValidation } from '../src/profile/validateRun.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TRADES_ROOT = path.join(REPO_ROOT, 'trades');

async function main(): Promise<void> {
  const args = parseValidateArgs(process.argv.slice(2));
  const available = fs.readdirSync(TRADES_ROOT).filter((d) => fs.existsSync(path.join(TRADES_ROOT, d, 'profile.json'))).sort();
  const names = (args.all ? available : args.trades).filter((n) => !args.exclude.includes(n));
  const unknown = names.filter((n) => !available.includes(n));
  if (unknown.length > 0) throw new Error(`no such trade profile: ${unknown.join(', ')}`);
  if (names.length === 0) throw new Error('nothing to validate after --exclude');

  console.log(`[validate-bank] reading ${args.iipDb} (read-only)`);
  const corpus = loadCorpusFromIipDb(args.iipDb, { sinceDays: args.sinceDays });
  console.log(`[validate-bank] ${corpus.items.length} published items over ${corpus.days} day(s); ${names.length} trade(s); ${args.apply ? 'APPLY (keyphrases.json will be trimmed)' : 'report only'}`);

  const result = await runValidation(
    { names, apply: args.apply, floor: args.floor, backupDir: args.backupDir, options: args.options },
    { anthropic: new Anthropic(), corpus, tradesRoot: TRADES_ROOT, log: console.log }
  );
  const removed = Object.values(result.trims).reduce((n, t) => n + t.removed.length, 0);
  const recommended = result.validations.reduce((n, v) => n + v.verdicts.filter((x) => x.action === 'remove').length, 0);
  console.log(`[validate-bank] done: ${result.totalCalls} gate calls (~$${result.spendUsd.toFixed(3)}), ${recommended} phrase(s) recommended for removal${args.apply ? `, ${removed} removed` : ''}`);
  if (args.jsonOut) {
    fs.writeFileSync(args.jsonOut, JSON.stringify({ args: { ...args, jsonOut: undefined }, ...result }, null, 2) + '\n');
    console.log(`[validate-bank] wrote ${args.jsonOut}`);
  }
}

main().catch((err) => {
  console.error('[validate-bank] failed:', err);
  process.exit(1);
});
