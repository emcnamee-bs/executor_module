import { describe, it, expect, afterEach } from 'vitest';
import { createRedisClient } from '../../src/redis/client.js';

describe('createRedisClient', () => {
  let client: ReturnType<typeof createRedisClient> | undefined;

  afterEach(async () => {
    if (client?.isOpen) {
      await client.quit();
    }
  });

  it('connects to a local Redis and responds to PING', async () => {
    client = createRedisClient();
    await client.connect();
    const response = await client.ping();
    expect(response).toBe('PONG');
  });
});
