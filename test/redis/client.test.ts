import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRedisClient } from '../../src/redis/client.js';

describe('createRedisClient', () => {
  let client: ReturnType<typeof createRedisClient> | undefined;

  afterEach(async () => {
    if (client?.isOpen) {
      await client.quit();
    }
    client = undefined;
  });

  it('connects to a local Redis and responds to PING', async () => {
    client = createRedisClient();
    await client.connect();
    const response = await client.ping();
    expect(response).toBe('PONG');
  });

  // I2: node-redis re-emits socket failures as an 'error' event. Node throws — and so
  // kills the process — when an 'error' event has zero listeners, which would defeat
  // the library's own reconnect/backoff before it ever runs.
  it('attaches an error listener so a socket error cannot crash the process', () => {
    client = createRedisClient();
    expect(client.listenerCount('error')).toBeGreaterThan(0);
  });

  it('logs an emitted error instead of letting it go unhandled', () => {
    client = createRedisClient();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // With no listener this emit would throw; the assertion is that it does not.
      expect(() => client!.emit('error', new Error('simulated socket failure'))).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toContain('[redis] connection error');
      expect(logged).toContain('simulated socket failure');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
