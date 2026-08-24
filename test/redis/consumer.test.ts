import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../../src/redis/client.js';
import { StreamConsumer, type StreamEntry } from '../../src/redis/consumer.js';
import type { RedisClientType } from 'redis';

describe('StreamConsumer', () => {
  let client: RedisClientType;
  let streamKey: string;
  let groupName: string;

  beforeEach(async () => {
    client = createRedisClient();
    await client.connect();
    streamKey = `test:iip:items:${randomUUID()}`;
    groupName = `test-group-${randomUUID()}`;
  });

  afterEach(async () => {
    await client.del(streamKey);
    await client.quit();
  });

  it('reads a fresh entry, invokes the handler, and acks it', async () => {
    await client.xAdd(streamKey, '*', { json: '{"n":1}' });

    const consumer = new StreamConsumer(client, {
      streamKey,
      groupName,
      consumerName: 'test-consumer',
      blockMs: 500,
      count: 10,
    });

    const seen: StreamEntry[] = [];
    const controller = new AbortController();

    await consumer.ensureGroup();
    await consumer.drainPending(async (entry) => {
      seen.push(entry);
    });

    const readOne = consumer.run(async (entry) => {
      seen.push(entry);
      controller.abort();
    }, controller.signal);

    await readOne;

    expect(seen).toHaveLength(1);
    expect(seen[0].fields.json).toBe('{"n":1}');

    const pending = await client.xPending(streamKey, groupName);
    expect(pending.pending).toBe(0);
  });

  it('redrains an unacked entry after a simulated restart with the same consumer name', async () => {
    await client.xAdd(streamKey, '*', { json: '{"n":2}' });

    const firstConsumer = new StreamConsumer(client, {
      streamKey,
      groupName,
      consumerName: 'stable-consumer',
      blockMs: 500,
      count: 10,
    });
    await firstConsumer.ensureGroup();

    // Read the entry but never ack it, simulating a crash before ack.
    const claimed: StreamEntry[] = [];
    const controllerOne = new AbortController();
    await firstConsumer['ensureGroup'](); // idempotent re-call, mirrors a fresh process
    const rawRead = await client.xReadGroup(
      groupName,
      'stable-consumer',
      [{ key: streamKey, id: '>' }],
      { COUNT: 10 }
    );
    expect(rawRead?.[0]?.messages).toHaveLength(1);
    // Deliberately do not ack — simulates a crash between read and ack.
    controllerOne.abort();

    // "Restart": a fresh StreamConsumer instance, same fixed consumer name.
    const secondConsumer = new StreamConsumer(client, {
      streamKey,
      groupName,
      consumerName: 'stable-consumer',
      blockMs: 500,
      count: 10,
    });

    const redelivered: StreamEntry[] = [];
    await secondConsumer.ensureGroup();
    await secondConsumer.drainPending(async (entry) => {
      redelivered.push(entry);
    });

    expect(redelivered).toHaveLength(1);
    expect(redelivered[0].fields.json).toBe('{"n":2}');

    const pending = await client.xPending(streamKey, groupName);
    expect(pending.pending).toBe(0);
  });

  it('is idempotent when the consumer group already exists', async () => {
    const consumer = new StreamConsumer(client, {
      streamKey,
      groupName,
      consumerName: 'test-consumer',
    });
    await consumer.ensureGroup();
    await expect(consumer.ensureGroup()).resolves.toBeUndefined();
  });
});
