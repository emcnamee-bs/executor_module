import { createClient, type RedisClientType } from 'redis';

export function createRedisClient(
  url: string = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0'
): RedisClientType {
  const client = createClient({ url }) as RedisClientType;

  // node-redis re-emits socket failures as an 'error' event. Node's default for an
  // 'error' event with ZERO listeners is to throw, which kills the process — so
  // without this listener the design's stated resilience story ("rely on the client
  // library's built-in reconnect/backoff") never gets a chance to run: the process is
  // already dead. Log it loudly rather than swallowing it; the library reconnects.
  client.on('error', (err) => {
    console.error('[redis] connection error:', err);
  });

  return client;
}
