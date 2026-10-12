import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { openLedger } from '../decide/ledger.js';
import { createAnthropicGateClient, DEFAULT_GATE_ANTHROPIC_MODEL, gateCostUsd } from '../decide/anthropicGateClient.js';
import { loadProfile } from './profile.js';
import { makeAuditJudge, type AuditUsage } from './auditJudge.js';
import type { Corpus } from './validate.js';
import { isLivePinned, trimKeyphrases, validateTrade, type TradeValidation, type TrimResult, type ValidateTradeOptions } from './validateTrade.js';

export interface RunValidationArgs {
  names: string[];
  /** Rewrite keyphrases.json (old list backed up outside the repo). Without it the run is a report only. */
  apply: boolean;
  floor: number;
  backupDir?: string;
  options: ValidateTradeOptions;
}

export interface RunValidationDeps {
  anthropic: Pick<Anthropic, 'messages'>;
  corpus: Corpus;
  tradesRoot: string;
  log: (line: string) => void;
}

export interface RunValidationResult {
  validations: TradeValidation[];
  trims: Record<string, TrimResult>;
  totalCalls: number;
  spendUsd: number;
}

function formatValidation(v: TradeValidation, log: (l: string) => void): void {
  log(
    `[${v.trade}] phrases=${v.phrases} matched=${v.matchedItems} (${v.hitsPerDay.toFixed(1)}/day) ` +
      `candidates=${v.candidates.length} audit-calls=${v.callsMade}${v.errors ? ` errors=${v.errors}` : ''}${v.budgetExhausted ? ' BUDGET-EXHAUSTED' : ''}`
  );
  for (const x of v.verdicts) {
    const stat = v.candidates.find((c) => c.phrase === x.phrase);
    const share = stat ? ` share=${Math.round(stat.share * 100)}%` : '';
    log(`   ${x.action === 'remove' ? 'REMOVE' : 'keep  '} ${JSON.stringify(x.phrase)} hits=${x.hits}${share} ${x.reason}`);
  }
}

/**
 * Replays each trade's keyphrases over the archive and has a strict audit judge (see auditJudge.ts) rate a sample of each
 * frequent phrase's hits. Model calls go through the same Claude client the live gate uses, against a throwaway ledger, so no
 * trade's real ledger, spend cap or breaker is touched.
 */
export async function runValidation(args: RunValidationArgs, deps: RunValidationDeps): Promise<RunValidationResult> {
  const validations: TradeValidation[] = [];
  const trims: Record<string, TrimResult> = {};
  let totalCalls = 0;
  let spendUsd = 0;
  for (const name of args.names) {
    const loaded = loadProfile(name, deps.tradesRoot);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-bank-'));
    const db = openLedger(path.join(dir, 'ledger.db'));
    try {
      const client = createAnthropicGateClient(deps.anthropic, db, { dailyUsdCap: 100 });
      const usage: AuditUsage = { promptTokens: 0, outputTokens: 0, calls: 0 };
      const judge = makeAuditJudge(loaded, client, DEFAULT_GATE_ANTHROPIC_MODEL, usage);
      const v = await validateTrade(loaded, deps.corpus, judge, args.options);
      validations.push(v);
      totalCalls += v.callsMade;
      spendUsd += gateCostUsd(DEFAULT_GATE_ANTHROPIC_MODEL, usage.promptTokens, usage.outputTokens);
      formatValidation(v, deps.log);
      if (args.apply) {
        if (isLivePinned(loaded)) {
          deps.log(`[${name}] live profile is hand-pinned: not edited (report only)`);
        } else {
          const t = trimKeyphrases(loaded, v.verdicts, { floor: args.floor, backupDir: args.backupDir });
          trims[name] = t;
          deps.log(`[${name}] trimmed ${t.removed.length} phrase(s) -> ${t.kept} kept${t.blocked.length ? `; ${t.blocked.length} blocked by the ${args.floor}-phrase floor` : ''}${t.backupPath ? `; backup ${t.backupPath}` : ''}`);
        }
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { validations, trims, totalCalls, spendUsd };
}
