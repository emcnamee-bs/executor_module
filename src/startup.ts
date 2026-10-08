import fs from 'node:fs';
import path from 'node:path';
import type { ConsumerOptions } from './redis/consumer.js';
import { compilePhrases, type CompiledPhrase } from './keyphrases/match.js';
import {
  loadProfile,
  assertLiveAllowed,
  resolveLedgerPath,
  TRADES_ROOT,
  type LoadedProfile,
  type TradeProfile,
} from './profile/profile.js';
import { loadIipSourceIds, assertDirectSourcesKnown } from './profile/iipSources.js';
import { assertOllamaModelAvailable, DEFAULT_OLLAMA_BASE_URL } from './decide/ollamaClient.js';
import { acquireLedgerLock, type LedgerLock } from './decide/ledgerLock.js';
import { setAlertTrade } from './alert.js';

export const STREAM_KEY = 'iip:items';

/** The live trade's ledger and consumer group (preserved from before trade profiles). */
export const LIVE_LEDGER_PATH = 'data/decisions.db';
export const LIVE_CONSUMER_GROUP = 'execmod';

/**
 * A live (non-dry-run) start on a ledger file that does not exist means a mis-pinned
 * profile would silently run with zero exposure, no breaker history and no pending-order
 * reconciliation. Refuse unless the operator opts in with the exact string "true".
 */
export function assertLedgerStartAllowed(
  ledgerPath: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync
): void {
  if (env.KALSHI_DRY_RUN === 'true') return;
  if (exists(ledgerPath)) return;
  if (env.EXECUTOR_ALLOW_NEW_LEDGER === 'true') return;
  throw new Error(
    `live start refused: ledger ${ledgerPath} does not exist, so this would run on a fresh empty ledger ` +
      `(no exposure, breaker or pending-order history). Fix the profile's ledgerPath, or set ` +
      `EXECUTOR_ALLOW_NEW_LEDGER=true to create a new ledger deliberately.`
  );
}

/**
 * Final review C1. systemd's EnvironmentFile= overrides Environment=, so a unit's
 * "hard-coded" KALSHI_DRY_RUN=true could be undone by an env file. The units now pin
 * their values on the ExecStart command line (`/usr/bin/env ...`), and this guard makes
 * the code itself refuse a real-money start unless EXECUTOR_LIVE_TRADE names exactly
 * this profile. Only the live unit sets it (on its ExecStart line); the paper template
 * strips it (`env -u`). So a paper unit can never go live by an env-file edit, and the
 * live unit cannot be retargeted to another trade's profile and go live.
 */
export function assertLiveTradeIdentity(profile: Pick<TradeProfile, 'name'>, env: NodeJS.ProcessEnv): void {
  if (env.KALSHI_DRY_RUN === 'true') return;
  if (env.EXECUTOR_LIVE_TRADE === profile.name) return;
  throw new Error(
    `live start refused for trade ${profile.name}: KALSHI_DRY_RUN is not "true", but EXECUTOR_LIVE_TRADE is ` +
      `${env.EXECUTOR_LIVE_TRADE === undefined ? 'unset' : JSON.stringify(env.EXECUTOR_LIVE_TRADE)}, not ${JSON.stringify(profile.name)}. ` +
      `Real orders run only from the live unit (executor-module.service), which pins EXECUTOR_LIVE_TRADE on its ExecStart line.`
  );
}

/**
 * Final review I2. The live trade's ledger and consumer group belong to the live unit
 * alone, dry-run or not: a second process on them splits the stream and its decision
 * rows hide items from the live trade forever. Any profile pinned to either needs
 * EXECUTOR_LIVE_TRADE to name it, which a paper unit never has.
 */
export function assertLiveLedgerOwnership(
  profile: Pick<TradeProfile, 'name' | 'ledgerPath' | 'consumerGroup'>,
  env: NodeJS.ProcessEnv
): void {
  const onLive = profile.ledgerPath.toLowerCase() === LIVE_LEDGER_PATH || profile.consumerGroup === LIVE_CONSUMER_GROUP;
  if (!onLive || env.EXECUTOR_LIVE_TRADE === profile.name) return;
  throw new Error(
    `start refused for trade ${profile.name}: its profile uses the live ledger ${LIVE_LEDGER_PATH} or the live ` +
      `consumer group ${LIVE_CONSUMER_GROUP} (ledgerPath ${profile.ledgerPath}, group ${profile.consumerGroup}), which only ` +
      `the live unit may run (it sets EXECUTOR_LIVE_TRADE=${profile.name}). Never start it from the paper template.`
  );
}

export interface Startup {
  loaded: LoadedProfile;
  ledgerPath: string;
  consumerOptions: ConsumerOptions;
  compiledPhrases: CompiledPhrase[];
  dryRun: boolean;
  halted: boolean;
  lock: LedgerLock;
}

export interface StartupDeps {
  tradesRoot?: string;
  exists?: (p: string) => boolean;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set (see .envrc)`);
  return value;
}

/**
 * Everything main() does before it opens the ledger or connects to anything that
 * trades: select and validate the profile, apply every start guard, pin the ledger,
 * consumer group and stream position, compile the phrases, confirm the gate model and
 * take the single-instance lock. Extracted so each of these is driven by a test.
 */
export async function prepareStartup(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  deps: StartupDeps = {}
): Promise<Startup> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const loaded = loadProfile(requireEnv(env, 'EXECUTOR_TRADE'), deps.tradesRoot ?? TRADES_ROOT);
  const { profile } = loaded;
  setAlertTrade(profile.name);

  assertLiveAllowed(profile, env);
  assertLiveTradeIdentity(profile, env);
  assertLiveLedgerOwnership(profile, env);
  const ledgerPath = resolveLedgerPath(profile, repoRoot);
  // Refuses a LIVE start on a ledger file that does not exist (mis-pinned profile guard).
  assertLedgerStartAllowed(ledgerPath, env, deps.exists ?? fs.existsSync);
  if (profile.directSources.length > 0) {
    assertDirectSourcesKnown(profile, loadIipSourceIds(requireEnv(env, 'IIP_SOURCES_FILE')));
  }
  const compiledPhrases = compilePhrases(loaded.keyphrases);
  const consumerOptions: ConsumerOptions = {
    streamKey: STREAM_KEY,
    groupName: profile.consumerGroup,
    consumerName: env.EXECMOD_CONSUMER_NAME ?? `${profile.consumerGroup}-primary`,
    startId: '$',
  };
  await assertOllamaModelAvailable(env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL, profile.gateModel, deps.fetchImpl);

  // Last, after every refusal: a refused start leaves no lock behind.
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const lock = acquireLedgerLock(ledgerPath);

  const dryRun = env.KALSHI_DRY_RUN === 'true';
  const halted = env.EXECUTOR_TRADING_HALTED === 'true';
  // Startup visibility: an empty list, a wrong bank, or a kill switch inherited from a
  // shared env file is indistinguishable at runtime from a healthy quiet pipeline.
  log(
    `[profile] trade=${profile.name} series=${profile.seriesTicker} ` +
      `structure=${profile.marketStructure} gateModel=${profile.gateModel} ` +
      `ledger=${ledgerPath} group=${profile.consumerGroup} ` +
      `bankSha=${loaded.bankSha.slice(0, 12)} keyphrases=${loaded.keyphrases.length} ` +
      `directSources=${JSON.stringify(profile.directSources)} dryRun=${dryRun} halted=${halted}`
  );

  if (!dryRun && !halted) {
    // Allowed (this is how the live trade runs), but never quietly.
    console.warn(
      `[profile] WARN: LIVE AND NOT HALTED trade=${profile.name}: real orders will be placed. ` +
        `To halt, set EXECUTOR_TRADING_HALTED=true in .env.kxaprpotus and restart.`
    );
  }

  return { loaded, ledgerPath, consumerOptions, compiledPhrases, dryRun, halted, lock };
}
