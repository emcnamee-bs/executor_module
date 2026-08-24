import type { RedisClientType } from 'redis';
import { createRedisClient } from './redis/client.js';
import { StreamConsumer, type ConsumerOptions } from './redis/consumer.js';
import { parseItemFields } from './item.js';
import { formatSummaryLine } from './log.js';

const STREAM_KEY = 'iip:items';
const GROUP_NAME = 'execmod';
const CONSUMER_NAME = process.env.EXECMOD_CONSUMER_NAME ?? 'execmod-primary';

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
      onLine(`[parse-error] entry=${entry.id} error=${result.error}`);
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
