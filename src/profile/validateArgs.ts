import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KEYPHRASE_FLOOR, DEFAULT_VALIDATE_OPTIONS, type ValidateTradeOptions } from './validateTrade.js';

export interface ValidateCliArgs {
  trades: string[];
  all: boolean;
  exclude: string[];
  apply: boolean;
  iipDb: string;
  sinceDays?: number;
  floor: number;
  backupDir: string;
  jsonOut?: string;
  options: ValidateTradeOptions;
}

const VALUE_FLAGS = new Set([
  '--trade', '--exclude', '--keep-phrases', '--iip-db', '--since-days', '--max-calls', '--min-hits', '--max-pass-rate', '--sample', '--floor', '--backup-dir', '--json',
]);
const BOOL_FLAGS = new Set(['--all', '--apply']);
// build-trade refuses to generate fewer, and the loader refuses fewer than this.
const MIN_FLOOR = 20;

function positiveInt(flag: string, raw: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${flag} must be a whole number, got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${flag} must be between ${min} and ${max}, got ${n}`);
  return n;
}

const list = (v: string | undefined, sep = ','): string[] => (v ?? '').split(sep).map((s) => s.trim()).filter(Boolean);

/** Strict parsing, like parseBuildArgs: a mistyped command fails before it can spend any model calls. */
export function parseValidateArgs(argv: string[]): ValidateCliArgs {
  const values: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOL_FLAGS.has(flag)) {
      if (bools.has(flag)) throw new Error(`duplicate flag ${flag}`);
      bools.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    if (flag in values) throw new Error(`duplicate flag ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new Error(`${flag} requires a value`);
    values[flag] = value;
    i++;
  }
  const all = bools.has('--all');
  const trades = list(values['--trade']);
  if (all && trades.length > 0) throw new Error('use --trade or --all, not both');
  if (!all && trades.length === 0) throw new Error('--trade <name[,name...]> or --all is required');

  // Phrases can contain commas, so this list is semicolon-separated.
  const options: ValidateTradeOptions = { ...DEFAULT_VALIDATE_OPTIONS, keepPhrases: list(values['--keep-phrases'], ';') };
  if (values['--max-calls'] !== undefined) options.maxCalls = positiveInt('--max-calls', values['--max-calls']);
  if (values['--min-hits'] !== undefined) options.minHits = positiveInt('--min-hits', values['--min-hits']);
  if (values['--sample'] !== undefined) options.sampleSize = positiveInt('--sample', values['--sample'], 4, 50);
  if (values['--max-pass-rate'] !== undefined) {
    const r = Number(values['--max-pass-rate']);
    if (!Number.isFinite(r) || r <= 0 || r > 1) throw new Error(`--max-pass-rate must be a number in (0, 1], got ${JSON.stringify(values['--max-pass-rate'])}`);
    options.maxPassRate = r;
  }
  const floor = values['--floor'] !== undefined ? positiveInt('--floor', values['--floor']) : DEFAULT_KEYPHRASE_FLOOR;
  if (floor < MIN_FLOOR) throw new Error(`--floor must be at least ${MIN_FLOOR} (the loader's minimum), got ${floor}`);

  return {
    trades,
    all,
    exclude: list(values['--exclude']),
    apply: bools.has('--apply'),
    iipDb: values['--iip-db'] ?? path.join(os.homedir(), 'Internet_Info_Plug', 'data', 'iip.db'),
    sinceDays: values['--since-days'] !== undefined ? positiveInt('--since-days', values['--since-days']) : undefined,
    floor,
    backupDir: values['--backup-dir'] ?? path.join(os.homedir(), 'trade-profile-backups'),
    jsonOut: values['--json'],
    options,
  };
}
