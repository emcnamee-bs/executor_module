import type { RedisClientType } from 'redis';
import { createRedisClient } from './redis/client.js';
import { StreamConsumer, type ConsumerOptions, type StreamEntry } from './redis/consumer.js';
import { parseItemFields, type Item } from './item.js';
import { formatSummaryLine } from './log.js';
import { compilePhrases, findMatches, getMatchableText, type CompiledPhrase } from './keyphrases/match.js';
import { loadKeyphrases, DEFAULT_KEYPHRASES_PATH } from './keyphrases/list.js';
import { openLedger } from './decide/ledger.js';
import { fetchActiveLadder } from './decide/kalshi.js';
import { runDecisionPipeline } from './decide/pipeline.js';
import { KalshiClient } from './execute/kalshiClient.js';
import { reconcilePendingOrders } from './execute/order.js';
import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STREAM_KEY = 'iip:items';
const GROUP_NAME = 'execmod';
const CONSUMER_NAME = process.env.EXECMOD_CONSUMER_NAME ?? 'execmod-primary';

const DEFAULT_LEDGER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/decisions.db'
);

/** How much of an unparseable payload the error line carries before it is cut off. */
const RAW_PREVIEW_LIMIT = 500;

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
  db: Database.Database;
  fetchLadder: typeof fetchActiveLadder;
  kalshiClient: KalshiClient;
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
    if (outcome.matchedPhrases.length === 0) return;

    console.log(
      `[KEYPHRASE-MATCH] item=${outcome.item.item_id} phrases=${JSON.stringify(outcome.matchedPhrases)} headline=${outcome.item.headline}`
    );
    try {
      await runDecisionPipeline(outcome.item, deps);
    } catch (err) {
      console.error(`[decision-pipeline] error processing item=${outcome.item.item_id}:`, err);
    }
  };
}

export async function main(): Promise<void> {
  const keyphrases = loadKeyphrases(DEFAULT_KEYPHRASES_PATH);
  const compiledPhrases = compilePhrases(keyphrases);

  // Startup visibility: without this, an empty list is indistinguishable at runtime
  // from a healthy pipeline that simply has not seen a newsworthy item yet — the
  // process logs item summaries forever and never a match, looking fine either way.
  console.log(`[keyphrases] loaded ${keyphrases.length} phrase(s) from ${DEFAULT_KEYPHRASES_PATH}`);
  if (keyphrases.length === 0) {
    console.warn(
      '[keyphrases] WARNING: 0 keyphrases loaded — keyphrase matching will never fire until data/keyphrases.json has entries'
    );
  }

  const client = createRedisClient();
  await client.connect();

  const anthropicClient = new Anthropic();
  const db = openLedger(DEFAULT_LEDGER_PATH);

  const kalshiClient = new KalshiClient({
    apiKeyId: mustGetEnv('KALSHI_API_KEY_ID'),
    privateKeyPath: mustGetEnv('KALSHI_PRIVATE_KEY_PATH'),
  });

  console.log('[startup] reconciling any orphaned pending orders...');
  await reconcilePendingOrders(db, kalshiClient);
  console.log('[startup] reconciliation complete');

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  await runOnce(
    client,
    { streamKey: STREAM_KEY, groupName: GROUP_NAME, consumerName: CONSUMER_NAME },
    compiledPhrases,
    makeOnItem({ anthropicClient, db, fetchLadder: fetchActiveLadder, kalshiClient }),
    controller.signal
  );

  await client.quit();
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
