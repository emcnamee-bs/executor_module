import type { RedisClientType } from 'redis';
import { createRedisClient } from './redis/client.js';
import { StreamConsumer, type ConsumerOptions } from './redis/consumer.js';
import { parseItemFields } from './item.js';
import { formatSummaryLine } from './log.js';

const STREAM_KEY = 'iip:items';
const GROUP_NAME = 'execmod';
const CONSUMER_NAME = process.env.EXECMOD_CONSUMER_NAME ?? 'execmod-primary';

/** How much of an unparseable payload the error line carries before it is cut off. */
const RAW_PREVIEW_LIMIT = 500;

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

export async function runOnce(
  client: RedisClientType,
  opts: ConsumerOptions,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<void> {
  const consumer = new StreamConsumer(client, opts);

  await consumer.run(async (entry) => {
    const result = parseItemFields(entry.fields);
    if (!result.ok) {
      // The spec requires the raw entry AND the error, on a structured one-line
      // summary. `result.error` is already collapsed to one line by parseItemFields;
      // `raw` is what tells you WHICH upstream field drifted, so dropping it (as this
      // branch used to) blinds exactly the diagnostic path it exists to serve.
      onLine(
        `[parse-error] entry=${entry.id} error=${result.error} raw=${truncateRaw(result.raw)}`
      );
      return;
    }
    onLine(formatSummaryLine(result.item));
  }, signal);
}

export async function main(): Promise<void> {
  const client = createRedisClient();
  await client.connect();

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  await runOnce(
    client,
    { streamKey: STREAM_KEY, groupName: GROUP_NAME, consumerName: CONSUMER_NAME },
    (line) => console.log(line),
    controller.signal
  );

  await client.quit();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
