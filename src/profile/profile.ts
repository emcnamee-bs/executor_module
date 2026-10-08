import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadKeyphrases } from '../keyphrases/list.js';
import { validateBank } from './bank.js';

export const TRADES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../trades');
export const PROFILE_FILES = ['profile.json', 'keyphrases.json', 'bank.md', 'bank.meta.json'] as const;

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MIN_KEYPHRASES = 20;

export type MarketStructure = 'band' | 'threshold' | 'binary' | 'capture';

export const ProfileSchema = z
  .object({
    name: z.string().regex(NAME_RE),
    seriesTicker: z.string().regex(/^[A-Z0-9]{3,40}$/),
    title: z.string().min(10).max(300),
    settlement: z.string().min(10).max(1200),
    gateModel: z.string().min(1),
    gateKeepAlive: z.string().min(1),
    decideContext: z.string().min(40).max(1500),
    directSources: z.array(z.string().regex(/^[a-z0-9_]+$/)).default([]),
    marketStructure: z.enum(['band', 'threshold', 'binary', 'capture']),
    magnitudeUnit: z.string().min(1).max(30),
    maxMagnitude: z.number().positive().finite(),
    ledgerPath: z
      .string()
      .regex(
        /^data\/([a-z0-9-]+\/)?[A-Za-z0-9._-]+\.db$/,
        'ledgerPath must look like data/<file>.db or data/<trade>/<file>.db (lowercase trade dir, no absolute path)'
      )
      .refine((p) => !p.includes('..') && !p.includes('\\'), 'ledgerPath must not contain ".." or a backslash'),
    consumerGroup: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
    generatedAt: z.string().min(1),
    generatorModel: z.string().min(1),
  })
  .strict();

export type TradeProfile = z.infer<typeof ProfileSchema>;

export interface LoadedProfile {
  profile: TradeProfile;
  keyphrases: string[];
  bank: string;
  bankSha: string;
  dir: string;
}

function readRequired(dir: string, file: string): string {
  const p = path.join(dir, file);
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    throw new Error(`trade profile file ${file} not found or unreadable at ${p}: ${(err as Error).message}`);
  }
}

export function loadProfile(name: string, root: string = TRADES_ROOT): LoadedProfile {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid trade name ${JSON.stringify(name)}: use lowercase letters, digits and dashes`);
  }
  // Symlinked profile directories/files are followed: the trades directory is operator-controlled.
  const dir = path.join(root, name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`trade profile directory not found: ${dir}`);
  }

  const rawProfile = readRequired(dir, 'profile.json');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawProfile);
  } catch (err) {
    throw new Error(`profile.json is invalid JSON in ${dir}: ${(err as Error).message}`);
  }
  const result = ProfileSchema.safeParse(parsedJson);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`profile.json is invalid in ${dir}: ${detail}`);
  }
  const profile = result.data;
  if (profile.name !== name) {
    throw new Error(`profile.json name ${JSON.stringify(profile.name)} does not match directory ${JSON.stringify(name)}`);
  }

  readRequired(dir, 'keyphrases.json');
  const keyphrases = loadKeyphrases(path.join(dir, 'keyphrases.json'));
  if (keyphrases.length < MIN_KEYPHRASES) {
    throw new Error(`keyphrases.json in ${dir} has ${keyphrases.length} usable phrases; need at least ${MIN_KEYPHRASES} keyphrases`);
  }

  const bank = readRequired(dir, 'bank.md');
  try {
    validateBank(bank);
  } catch (err) {
    throw new Error(`bank.md is invalid in ${dir}: ${(err as Error).message}`);
  }
  const bankSha = crypto.createHash('sha256').update(bank).digest('hex');

  const rawMeta = readRequired(dir, 'bank.meta.json');
  let meta: unknown;
  try {
    meta = JSON.parse(rawMeta);
  } catch (err) {
    throw new Error(`bank.meta.json is invalid JSON in ${dir}: ${(err as Error).message}`);
  }
  const metaSha = (meta as { sha256?: unknown } | null)?.sha256;
  if (typeof metaSha !== 'string' || metaSha !== bankSha) {
    throw new Error(
      `bank.meta.json sha256 does not match bank.md in ${dir} ` +
        `(the bank was edited after it was generated; rebuild the profile or fix the meta file)`
    );
  }

  return { profile, keyphrases, bank, bankSha, dir };
}

/**
 * Real orders are only proven for the band structure (the approval ladder the sizing
 * code was built and live-verified against). Every other structure is paper-only until
 * it has been proven against settlements.
 */
export function assertLiveAllowed(profile: TradeProfile, env: NodeJS.ProcessEnv = process.env): void {
  if (profile.marketStructure !== 'band' && env.KALSHI_DRY_RUN !== 'true') {
    throw new Error(
      `trade ${profile.name} has marketStructure ${profile.marketStructure}, which is paper-only: ` +
        `refusing to start without KALSHI_DRY_RUN=true`
    );
  }
}

/**
 * Resolves a profile's ledger path against the repo root and re-checks containment:
 * the schema regex already blocks traversal, but a path that reaches the filesystem
 * is checked again here so no other code path can open a database outside data/.
 */
export function resolveLedgerPath(profile: Pick<TradeProfile, 'ledgerPath'>, repoRoot: string): string {
  const resolved = path.resolve(repoRoot, profile.ledgerPath);
  if (!resolved.startsWith(path.join(repoRoot, 'data') + path.sep)) {
    throw new Error('ledgerPath escapes the data directory');
  }
  return resolved;
}

/**
 * Cross-profile check, run in CI over the committed trades/ directory: no two profiles
 * may share a consumer group (they would split one stream between two trades) or a
 * ledger (they would mix exposure, breakers and dedup). One process cannot see this at
 * startup. Dot directories (build staging, .old copies) are skipped. Returns one
 * message per collision or unreadable profile; empty means clean.
 */
export function findProfileCollisions(root: string = TRADES_ROOT): string[] {
  const problems: string[] = [];
  const byGroup = new Map<string, string[]>();
  const byLedger = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, name: string) => m.set(k, [...(m.get(k) ?? []), name]);
  for (const name of fs.readdirSync(root).filter((d) => !d.startsWith('.')).sort()) {
    const file = path.join(root, name, 'profile.json');
    if (!fs.existsSync(file)) continue;
    let p: { consumerGroup?: unknown; ledgerPath?: unknown };
    try {
      p = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      problems.push(`${name}: profile.json unreadable: ${(err as Error).message}`);
      continue;
    }
    add(byGroup, String(p.consumerGroup), name);
    add(byLedger, String(p.ledgerPath).toLowerCase(), name);
  }
  for (const [g, names] of byGroup) if (names.length > 1) problems.push(`consumerGroup "${g}" is used by ${names.join(', ')}`);
  for (const [l, names] of byLedger) if (names.length > 1) problems.push(`ledgerPath "${l}" is used by ${names.join(', ')}`);
  return problems;
}

/** Operator scripts act on ONE trade's ledger: EXECUTOR_TRADE is required, never defaulted. */
export function resolveTradeLedger(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  tradesRoot: string = TRADES_ROOT
): { trade: string; ledgerPath: string } {
  const trade = env.EXECUTOR_TRADE;
  if (!trade) throw new Error('EXECUTOR_TRADE must be set (the trade whose ledger this script acts on)');
  const loaded = loadProfile(trade, tradesRoot);
  return { trade: loaded.profile.name, ledgerPath: resolveLedgerPath(loaded.profile, repoRoot) };
}

/** score-paper takes an explicit ledger path; it must still resolve to a file under <repo>/data/. */
export function resolveScoreLedgerPath(raw: string | undefined, repoRoot: string): string {
  if (!raw) throw new Error('EXECUTOR_LEDGER_PATH must be set to the ledger file to score');
  return resolveLedgerPath({ ledgerPath: raw }, repoRoot);
}
