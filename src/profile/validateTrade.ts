import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKeyphrases, saveKeyphrases } from '../keyphrases/list.js';
import type { LoadedProfile } from './profile.js';
import {
  applyRemovals,
  decideRemovals,
  judgeCandidates,
  makeCoreMatcher,
  matchCorpus,
  selectCandidates,
  type Corpus,
  type CorpusItem,
  type PhraseStat,
  type PhraseVerdict,
} from './validate.js';

export interface ValidateTradeOptions {
  /** A phrase needs at least this many archive hits before it is worth judging. */
  minHits: number;
  maxCandidates: number;
  /** Hits sampled per candidate phrase and sent to the gate. */
  sampleSize: number;
  /** Fewer judged hits than this is thin evidence: the phrase is kept. */
  minJudged: number;
  /** A phrase whose sampled hits the gate passes less often than this is recommended for removal. */
  maxPassRate: number;
  concurrency: number;
  /** Hard ceiling on gate calls for one trade (cost guard). */
  maxCalls: number;
  /** Exact phrases a human has decided to keep: never recommended for removal, whatever their sample judged. */
  keepPhrases: string[];
}

export const DEFAULT_VALIDATE_OPTIONS: ValidateTradeOptions = {
  minHits: 10,
  maxCandidates: 15,
  sampleSize: 12,
  minJudged: 8,
  maxPassRate: 0.2,
  concurrency: 4,
  maxCalls: 1500,
  keepPhrases: [],
};

/** Never trim a list below build-trade's own generation minimum. */
export const DEFAULT_KEYPHRASE_FLOOR = 150;

export interface TradeValidation {
  trade: string;
  phrases: number;
  matchedItems: number;
  hitsPerDay: number;
  candidates: PhraseStat[];
  verdicts: PhraseVerdict[];
  callsMade: number;
  errors: number;
  budgetExhausted: boolean;
}

export async function validateTrade(
  loaded: LoadedProfile,
  corpus: Corpus,
  judge: (item: CorpusItem) => Promise<boolean>,
  opts: ValidateTradeOptions
): Promise<TradeValidation> {
  const report = matchCorpus(loaded.keyphrases, corpus.items, corpus.days, loaded.profile.directSources);
  const candidates = selectCandidates(report, { minHits: opts.minHits, maxCandidates: opts.maxCandidates });
  const byId = new Map(corpus.items.map((i) => [i.id, i]));
  const judged = await judgeCandidates(candidates, byId, judge, {
    sampleSize: opts.sampleSize,
    concurrency: opts.concurrency,
    maxCalls: opts.maxCalls,
  });
  return {
    trade: loaded.profile.name,
    phrases: loaded.keyphrases.length,
    matchedItems: report.matchedItems,
    hitsPerDay: report.matchedItems / Math.max(1, report.days),
    candidates,
    verdicts: decideRemovals(candidates, judged.verdicts, {
      minJudged: opts.minJudged,
      maxPassRate: opts.maxPassRate,
      protect: ((core, keep) => (phrase: string) => core(phrase) || keep.has(phrase))(
        makeCoreMatcher([loaded.profile.title, loaded.profile.settlement]),
        new Set(opts.keepPhrases)
      ),
    }),
    callsMade: judged.callsMade,
    errors: judged.errors,
    budgetExhausted: judged.budgetExhausted,
  };
}

export interface TrimResult {
  removed: string[];
  blocked: string[];
  kept: number;
  /** Where the previous keyphrases.json was saved (outside the repo); null when nothing changed. */
  backupPath: string | null;
}

export interface TrimOptions {
  floor: number;
  backupDir?: string;
  now?: () => Date;
}

/** The hand-pinned live profile must never be edited by a tool: its values are pinned by tests and reviewed by hand. */
export function isLivePinned(loaded: LoadedProfile): boolean {
  return loaded.profile.ledgerPath === 'data/decisions.db' || loaded.profile.consumerGroup === 'execmod';
}

export function trimKeyphrases(loaded: LoadedProfile, verdicts: PhraseVerdict[], opts: TrimOptions): TrimResult {
  if (isLivePinned(loaded)) throw new Error(`refusing to edit the live profile ${loaded.profile.name}: it is hand-pinned`);
  const applied = applyRemovals(loaded.keyphrases, verdicts, opts.floor);
  if (applied.removed.length === 0) return { removed: [], blocked: applied.blocked, kept: loaded.keyphrases.length, backupPath: null };

  const file = path.join(loaded.dir, 'keyphrases.json');
  const backupRoot = opts.backupDir ?? path.join(os.homedir(), 'trade-profile-backups');
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const backupDir = path.join(backupRoot, loaded.profile.name);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `keyphrases.json.bak-${stamp}`);
  fs.copyFileSync(file, backupPath);

  // Write beside the target and rename over it (atomic on one filesystem), so a crash never leaves a half-written list.
  const tmp = path.join(loaded.dir, `.keyphrases.json.tmp-${process.pid}`);
  saveKeyphrases(tmp, applied.kept);
  try {
    if (loadKeyphrases(tmp).length !== applied.kept.length) throw new Error('trimmed keyphrase list failed its own reload check; leaving the profile untouched');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { removed: applied.removed, blocked: applied.blocked, kept: applied.kept.length, backupPath };
}
