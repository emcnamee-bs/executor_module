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
import { resolveGateConfig, type GateConfig } from './decide/anthropicGateClient.js';
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

/**
 * EXECUTOR_PAPER_LOW_TIER: a time-boxed, PAPER-ONLY data-collection test that lets a
 * single-source tier 3/4 item through the rumor rung as `reported`. It must be
 * impossible to engage on a live-capable process, so this refuses to start unless:
 * the value is exactly "true" (or unset/empty, which means off; anything else fails
 * closed), KALSHI_DRY_RUN is exactly "true", EXECUTOR_LIVE_TRADE is absent (only the
 * live unit sets it), and the profile is not on the live ledger or consumer group.
 * The pipeline re-checks dry-run and EXECUTOR_LIVE_TRADE per item (defence in depth).
 */
export function resolvePaperLowTier(
  profile: Pick<TradeProfile, 'name' | 'ledgerPath' | 'consumerGroup'>,
  env: NodeJS.ProcessEnv
): boolean {
  const value = env.EXECUTOR_PAPER_LOW_TIER;
  if (value === undefined || value === '') return false;
  const refuse = (why: string) =>
    new Error(
      `start refused for trade ${profile.name}: EXECUTOR_PAPER_LOW_TIER is set, but ${why}. It is a paper-only, ` +
        `time-boxed test, enabled only on a paper unit via its low-tier.conf drop-in (HANDOFF.md Sec 5a.5); the live unit must never set it.`
    );
  if (value !== 'true') throw refuse(`its value ${JSON.stringify(value)} is not exactly "true" (unset it to turn it off)`);
  if (env.KALSHI_DRY_RUN !== 'true') throw refuse('KALSHI_DRY_RUN is not "true" (this would be a live, paper-only-violating process)');
  if (env.EXECUTOR_LIVE_TRADE !== undefined) throw refuse('EXECUTOR_LIVE_TRADE is set, so this is the live unit');
  if (profile.ledgerPath.toLowerCase() === LIVE_LEDGER_PATH || profile.consumerGroup === LIVE_CONSUMER_GROUP) {
    throw refuse(`the profile uses the live ledger ${LIVE_LEDGER_PATH} or live consumer group ${LIVE_CONSUMER_GROUP}`);
  }
  return true;
}

export interface ExitReviewConfig {
  enabled: boolean;
  /** EXIT_REVIEW_MODEL; undefined = the default (Sonnet). */
  model: string | undefined;
  exitFeeCents: number;
  retryMs: number;
  dailyUsdCap: number;
}

/**
 * EXIT_REVIEW=on enables the paper exit review (docs/superpowers/specs/2026-10-12-exit-review-design.md).
 * Like resolvePaperLowTier it must be impossible to engage on a live-capable process: it refuses to
 * start unless KALSHI_DRY_RUN is exactly "true", EXECUTOR_LIVE_TRADE is absent, and the profile is
 * not on the live ledger or consumer group. Unset, empty or "off" means off; anything else fails closed.
 */
export function resolveExitReview(
  profile: Pick<TradeProfile, 'name' | 'ledgerPath' | 'consumerGroup'>,
  env: NodeJS.ProcessEnv
): ExitReviewConfig {
  const off: ExitReviewConfig = { enabled: false, model: undefined, exitFeeCents: 0, retryMs: 20_000, dailyUsdCap: 5 };
  const value = env.EXIT_REVIEW;
  if (value === undefined || value === '' || value === 'off') return off;
  const refuse = (why: string) =>
    new Error(
      `start refused for trade ${profile.name}: EXIT_REVIEW is set, but ${why}. Exit review is paper-only, enabled per paper unit ` +
        `via its exit-review.conf drop-in; the live unit must never set it.`
    );
  if (value !== 'on') throw refuse(`its value ${JSON.stringify(value)} is not "on" or "off"`);
  if (env.KALSHI_DRY_RUN !== 'true') throw refuse('KALSHI_DRY_RUN is not "true" (this would be a live process)');
  if (env.EXECUTOR_LIVE_TRADE !== undefined) throw refuse('EXECUTOR_LIVE_TRADE is set, so this is the live unit');
  if (profile.ledgerPath.toLowerCase() === LIVE_LEDGER_PATH || profile.consumerGroup === LIVE_CONSUMER_GROUP) {
    throw refuse(`the profile uses the live ledger ${LIVE_LEDGER_PATH} or live consumer group ${LIVE_CONSUMER_GROUP}`);
  }
  const num = (name: string, fallback: number, ok: (n: number) => boolean, rule: string): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name} must be ${rule}, got ${JSON.stringify(raw)}`);
    return n;
  };
  return {
    enabled: true,
    model: env.EXIT_REVIEW_MODEL === undefined || env.EXIT_REVIEW_MODEL === '' ? undefined : env.EXIT_REVIEW_MODEL,
    exitFeeCents: num('EXIT_FEE_CENTS', 0, (n) => n >= 0, 'a number of cents >= 0'),
    retryMs: num('EXIT_RETRY_MS', 20_000, (n) => Number.isInteger(n) && n >= 1000, 'a whole number of milliseconds >= 1000'),
    dailyUsdCap: num('EXIT_DAILY_USD_CAP', 5, (n) => n > 0, 'a positive number of US dollars'),
  };
}

export type DecisionMode = 'classic' | 'unified';

/**
 * DECISION_MODE=unified replaces triage + decide + per-position exit reviews with one position-aware call
 * (docs/superpowers/specs/2026-10-13-unified-position-aware-decision-design.md). Like the exit review it must
 * be impossible to engage on a live-capable process, and it reuses the exit review's fills, timer and
 * lateness, so it also requires EXIT_REVIEW=on. Unset, empty or "classic" means the existing behaviour.
 */
export function resolveDecisionMode(
  profile: Pick<TradeProfile, 'name' | 'ledgerPath' | 'consumerGroup'>,
  env: NodeJS.ProcessEnv,
  exitReviewEnabled: boolean
): DecisionMode {
  const value = env.DECISION_MODE;
  if (value === undefined || value === '' || value === 'classic') return 'classic';
  const refuse = (why: string) =>
    new Error(
      `start refused for trade ${profile.name}: DECISION_MODE is set, but ${why}. Unified decisions are paper-only, enabled per paper ` +
        `unit via its decision-mode.conf drop-in; the live unit must never set it.`
    );
  if (value !== 'unified') throw refuse(`its value ${JSON.stringify(value)} is not "classic" or "unified"`);
  if (env.KALSHI_DRY_RUN !== 'true') throw refuse('KALSHI_DRY_RUN is not "true" (this would be a live process)');
  if (env.EXECUTOR_LIVE_TRADE !== undefined) throw refuse('EXECUTOR_LIVE_TRADE is set, so this is the live unit');
  if (profile.ledgerPath.toLowerCase() === LIVE_LEDGER_PATH || profile.consumerGroup === LIVE_CONSUMER_GROUP) {
    throw refuse(`the profile uses the live ledger ${LIVE_LEDGER_PATH} or live consumer group ${LIVE_CONSUMER_GROUP}`);
  }
  if (!exitReviewEnabled) throw refuse('EXIT_REVIEW=on is also required (unified mode reuses the exit review fills and retry timer)');
  return 'unified';
}

export interface Startup {
  loaded: LoadedProfile;
  ledgerPath: string;
  consumerOptions: ConsumerOptions;
  compiledPhrases: CompiledPhrase[];
  dryRun: boolean;
  halted: boolean;
  /** EXECUTOR_PAPER_LOW_TIER, resolved and validated by resolvePaperLowTier. */
  paperLowTier: boolean;
  /** EXIT_REVIEW and friends, resolved and validated by resolveExitReview. */
  exitReview: ExitReviewConfig;
  /** DECISION_MODE, resolved and validated by resolveDecisionMode (classic unless a paper unit opts in to unified). */
  decisionMode: DecisionMode;
  /** GATE_PROVIDER and friends, resolved and validated by resolveGateConfig (default: the local Ollama gate). */
  gate: GateConfig;
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
  const paperLowTier = resolvePaperLowTier(profile, env);
  const exitReview = resolveExitReview(profile, env);
  const decisionMode = resolveDecisionMode(profile, env, exitReview.enabled);
  const gate = resolveGateConfig(env);
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
  // A Claude-backed gate needs no Ollama, so the model-pulled check applies only to the local gate.
  if (gate.provider === 'ollama') {
    await assertOllamaModelAvailable(env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL, profile.gateModel, deps.fetchImpl);
  }

  // Last, after every refusal: a refused start leaves no lock behind.
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const lock = acquireLedgerLock(ledgerPath);

  const dryRun = env.KALSHI_DRY_RUN === 'true';
  const halted = env.EXECUTOR_TRADING_HALTED === 'true';
  // Startup visibility: an empty list, a wrong bank, or a kill switch inherited from a
  // shared env file is indistinguishable at runtime from a healthy quiet pipeline.
  log(
    `[profile] trade=${profile.name} series=${profile.seriesTicker} ` +
      `structure=${profile.marketStructure} gateProvider=${gate.provider} gateModel=${gate.provider === 'anthropic' ? gate.anthropicModel : profile.gateModel} ` +
      `ledger=${ledgerPath} group=${profile.consumerGroup} ` +
      `bankSha=${loaded.bankSha.slice(0, 12)} keyphrases=${loaded.keyphrases.length} ` +
      `directSources=${JSON.stringify(profile.directSources)} dryRun=${dryRun} halted=${halted} lowTier=${paperLowTier} exitReview=${exitReview.enabled ? 'on' : 'off'} decision=${decisionMode}`
  );

  if (!dryRun && !halted) {
    // Allowed (this is how the live trade runs), but never quietly.
    console.warn(
      `[profile] WARN: LIVE AND NOT HALTED trade=${profile.name}: real orders will be placed. ` +
        `To halt, set EXECUTOR_TRADING_HALTED=true in .env.kxaprpotus and restart.`
    );
  }

  return { loaded, ledgerPath, consumerOptions, compiledPhrases, dryRun, halted, paperLowTier, exitReview, decisionMode, gate, lock };
}
