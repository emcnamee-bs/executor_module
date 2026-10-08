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

const ProfileSchema = z
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
    ledgerPath: z.string().min(1),
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
