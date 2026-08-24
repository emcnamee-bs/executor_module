import { createClient, type RedisClientType } from 'redis';

export function createRedisClient(
  url: string = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0'
): RedisClientType {
  return createClient({ url }) as RedisClientType;
}
