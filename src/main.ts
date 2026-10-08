import type { RedisClientType } from 'redis';
import { createRedisClient } from './redis/client.js';
import { StreamConsumer, type ConsumerOptions, type StreamEntry } from './redis/consumer.js';
import { parseItemFields, type Item } from './item.js';
import { formatSummaryLine } from './log.js';
import { findMatches, getMatchableText, type CompiledPhrase } from './keyphrases/match.js';
import type { LoadedProfile } from './profile/profile.js';
import { prepareStartup, assertLedgerStartAllowed } from './startup.js';
import { fetchArticle } from './fetch/excerpt.js';
import {
  openLedger,
  recordProcessStarting,
  recordProcessStoppedCleanly,
} from './decide/ledger.js';
import { sendAlert } from './alert.js';
import { fetchActiveLadder } from './decide/kalshi.js';
import { runDecisionPipeline } from './decide/pipeline.js';
import { createOllamaClient, type OllamaClient } from './decide/ollamaClient.js';
import { KalshiClient } from './execute/kalshiClient.js';
import { reconcilePendingOrders } from './execute/order.js';
import { startReconciliationTimer } from './execute/reconcileOpenPositions.js';
import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Re-exported for existing callers/tests; the guard itself lives with the rest of startup.
export { assertLedgerStartAllowed };

/** How much of an unparseable payload the error line carries before it is cut off. */
const RAW_PREVIEW_LIMIT = 500;

/** How often the periodic account-reconciliation pass runs, in milliseconds. */
const RECONCILE_OPEN_POSITIONS_INTERVAL_MS = 10 * 60 * 1000;

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .envrc)`);
  return value;
}

/**
 * Renders a failed payload for a ONE-LINE log entry: newlines and other control
 * characters flattened to spaces, and cut to `RAW_PREVIEW_LIMIT` with an explicit
 * marker so a truncated payload can never be mistaken for a complete one.
 */
export function truncateRaw(raw: string, limit: number = RAW_PREVIEW_LIMIT): string {
  const flattened = raw.replace(/[\r\n\t]+/g, ' ');
  return flattened.length > limit
    ? `${flattened.slice(0, limit)}...(truncated)`
    : flattened;
}

export type ItemOutcome =
  | { ok: true; entry: StreamEntry; item: Item; matchedPhrases: string[] }
  | { ok: false; entry: StreamEntry; error: string; raw: string };

export type OnItem = (outcome: ItemOutcome) => void | Promise<void>;

export async function runOnce(
  client: RedisClientType,
  opts: ConsumerOptions,
  compiledPhrases: CompiledPhrase[],
  onItem: OnItem,
  signal: AbortSignal
): Promise<void> {
  const consumer = new StreamConsumer(client, opts);

  await consumer.run(async (entry) => {
    const result = parseItemFields(entry.fields);
    if (!result.ok) {
      await onItem({ ok: false, entry, error: result.error, raw: truncateRaw(result.raw) });
      return;
    }
    const matchableText = getMatchableText(result.item);
    const matchedPhrases = findMatches(matchableText, compiledPhrases);
    await onItem({ ok: true, entry, item: result.item, matchedPhrases });
  }, signal);
}

export interface OnItemDeps {
  anthropicClient: Anthropic;
  ollamaClient: OllamaClient;
  db: Database.Database;
  fetchLadder: typeof fetchActiveLadder;
  kalshiClient: KalshiClient;
  profile: LoadedProfile;
  fetchArticle: typeof fetchArticle;
  /** From prepareStartup (resolvePaperLowTier); the pipeline re-checks dry-run per item. */
  paperLowTier?: boolean;
}

/**
 * The real consumer callback, extracted from `main()` so the one seam that matters
 * -- a matched stream entry actually reaching the decision pipeline and landing in
 * the ledger -- is testable. While this was defined inline inside `main()`,
 * deleting the `runDecisionPipeline` call left the whole test suite green.
 */
export function makeOnItem(deps: OnItemDeps): OnItem {
  return async (outcome) => {
    if (!outcome.ok) {
      console.error(`[parse-error] entry=${outcome.entry.id} error=${outcome.error} raw=${outcome.raw}`);
      return;
    }
    console.log(formatSummaryLine(outcome.item));
    // A direct source IS the market's resolution data, so it is routed to the pipeline
    // whether or not a keyphrase matched; every other source needs a keyphrase hit.
    const isDirect = deps.profile.profile.directSources.includes(outcome.item.source_id);
    if (outcome.matchedPhrases.length === 0 && !isDirect) return;

    console.log(
      isDirect
        ? `[DIRECT-SOURCE] item=${outcome.item.item_id} source=${outcome.item.source_id} headline=${outcome.item.headline}`
        : `[KEYPHRASE-MATCH] item=${outcome.item.item_id} phrases=${JSON.stringify(outcome.matchedPhrases)} headline=${outcome.item.headline}`
    );
    try {
      await runDecisionPipeline(outcome.item, deps);
    } catch (err) {
      console.error(`[decision-pipeline] error processing item=${outcome.item.item_id}:`, err);
    }
  };
}

export async function main(): Promise<void> {
  // Every start guard, the ledger/group/stream-position pins, the phrase compile, the
  // gate-model check and the single-instance lock: see src/startup.ts (tested there).
  const startup = await prepareStartup(process.env, REPO_ROOT);
  const { loaded, ledgerPath } = startup;
  process.once('exit', () => startup.lock.release());

  const client = createRedisClient();
  await client.connect();

  const anthropicClient = new Anthropic();
  const db = openLedger(ledgerPath);
  const ollamaClient = createOllamaClient(undefined, db);
  // Isolated like every other auxiliary/observability write in this codebase
  // (checkFailedOrdersSignal, checkDivergencesSignal, recordKalshiError): a
  // diagnostic marker failing to write must never stop the whole system from
  // starting. A false here (the same value a first-ever boot returns) just means
  // no unclean-exit alert this run, which is the right failure direction.
  let uncleanRestart = false;
  try {
    uncleanRestart = recordProcessStarting(db);
  } catch (err) {
    console.error('[lifecycle] failed to record process start (not fatal):', err);
  }
  // The ONE awaited sendAlert in this codebase, and deliberately so. Every other
  // call site is fire-and-forget because it sits on the hot trading path and must
  // never be delayed by a Slack outage. This one runs once during startup, before
  // the Redis consumer loop has accepted any work, so there is no hot path to
  // delay -- and awaiting it means the POST gets a real chance to land before a
  // LATER startup step (a missing env var, say) can crash the process and abandon
  // an in-flight unawaited request. sendAlert never throws, and it is bounded by
  // its own fetch timeout, so this cannot hang or fail the boot.
  if (uncleanRestart) {
    await sendAlert(
      '[UNCLEAN-EXIT] process restarted after an unclean exit. ' +
        'Check logs for the cause before assuming trading resumed safely.'
    );
  }

  const kalshiClient = new KalshiClient(
    { apiKeyId: mustGetEnv('KALSHI_API_KEY_ID'), privateKeyPath: mustGetEnv('KALSHI_PRIVATE_KEY_PATH') },
    { db }
  );

  console.log('[startup] reconciling any orphaned pending orders...');
  await reconcilePendingOrders(db, kalshiClient);
  console.log('[startup] reconciliation complete');

  const reconciliationTimer = startReconciliationTimer(
    { db, client: kalshiClient },
    RECONCILE_OPEN_POSITIONS_INTERVAL_MS
  );

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  await runOnce(
    client,
    startup.consumerOptions,
    startup.compiledPhrases,
    makeOnItem({
      anthropicClient, ollamaClient, db, fetchLadder: fetchActiveLadder, kalshiClient, profile: loaded, fetchArticle,
      paperLowTier: startup.paperLowTier,
    }),
    controller.signal
  );

  // Also isolated, for a second reason beyond the one above: an uncaught throw
  // here would skip the REST of teardown -- leaving the reconciliation timer
  // running and the Redis connection open -- and still leave the lifecycle row
  // 'running', so the next boot would fire a spurious unclean-exit alert on top
  // of it. A missed clean-shutdown marker costs one false alert next boot; a
  // throw costs a dirty shutdown AND that same false alert.
  try {
    recordProcessStoppedCleanly(db);
  } catch (err) {
    console.error('[lifecycle] failed to record clean shutdown (not fatal):', err);
  }
  reconciliationTimer.stop();
  await client.quit();
  db.close();
  startup.lock.release();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
