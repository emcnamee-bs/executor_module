import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  // I6: the crash must be simulated THROUGH run(), not by a hand-rolled xReadGroup.
  // The load-bearing property is that run() itself leaves an entry pending when it
  // dies mid-flight — a raw client call proves Redis's PEL semantics, not ours.
  it('redrains an entry left pending by a crash inside run(), after a simulated restart', async () => {
    await client.xAdd(streamKey, '*', { json: '{"n":2}' });

    const firstConsumer = new StreamConsumer(client, {
      streamKey,
      groupName,
      consumerName: 'stable-consumer',
      blockMs: 500,
      count: 10,
    });

    // Crash: the handler throws while processing the entry, so run() rejects BEFORE
    // it reaches its xAck. Not caught in a way that would let run() ack anyway.
    const crashController = new AbortController();
    const boom = new Error('simulated crash mid-flight');
    await expect(
      firstConsumer.run(async () => {
        throw boom;
      }, crashController.signal)
    ).rejects.toThrow('simulated crash mid-flight');

    // run() really did leave the entry un-acked in the PEL.
    const pendingAfterCrash = await client.xPending(streamKey, groupName);
    expect(pendingAfterCrash.pending).toBe(1);

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

  // I3: a pending entry whose stream entry has been trimmed away comes back with a nil
  // body, which node-redis's reply transform throws on before our code sees the batch.
  // Unhandled that is a crash loop nothing but a manual XACK can break.
  describe('poison (trimmed) pending entry', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('confirms the raw client really does reject on a nil message body', async () => {
      // Pins the premise the fix is built on. If a future `redis` upgrade starts
      // returning nils gracefully instead of throwing, this test says so out loud.
      const consumer = new StreamConsumer(client, {
        streamKey,
        groupName,
        consumerName: 'poison-premise',
        count: 10,
      });
      await consumer.ensureGroup();

      const id = await client.xAdd(streamKey, '*', { json: '{"n":9}' });
      await client.xReadGroup(groupName, 'poison-premise', [{ key: streamKey, id: '>' }], {
        COUNT: 10,
      });
      await client.xDel(streamKey, id);

      await expect(
        client.xReadGroup(groupName, 'poison-premise', [{ key: streamKey, id: '0' }], {
          COUNT: 10,
        })
      ).rejects.toThrow(TypeError);
    });

    it('drainPending does not crash, acks the poison entry, and logs it loudly', async () => {
      const consumer = new StreamConsumer(client, {
        streamKey,
        groupName,
        consumerName: 'poison-consumer',
        blockMs: 500,
        count: 10,
      });
      await consumer.ensureGroup();

      const poisonId = await client.xAdd(streamKey, '*', { json: '{"n":"poison"}' });

      // Deliver it (so it lands in the PEL) without acking, then trim it away.
      await client.xReadGroup(groupName, 'poison-consumer', [{ key: streamKey, id: '>' }], {
        COUNT: 10,
      });
      await client.xDel(streamKey, poisonId);
      expect((await client.xPending(streamKey, groupName)).pending).toBe(1);

      const seen: StreamEntry[] = [];
      await expect(
        drainWithTimeout(consumer, async (entry) => {
          seen.push(entry);
        })
      ).resolves.toBeUndefined();

      // It did not deliver a phantom entry, it did unstick the PEL, and it said so.
      expect(seen).toHaveLength(0);
      expect((await client.xPending(streamKey, groupName)).pending).toBe(0);
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(poisonId);
      expect(logged).toContain('poison pending entry');
    });

    it('still processes the healthy pending entries in the same poisoned batch', async () => {
      const consumer = new StreamConsumer(client, {
        streamKey,
        groupName,
        consumerName: 'mixed-consumer',
        blockMs: 500,
        count: 10,
      });
      await consumer.ensureGroup();

      const poisonId = await client.xAdd(streamKey, '*', { json: '{"n":"poison"}' });
      const goodIdA = await client.xAdd(streamKey, '*', { json: '{"n":"good-a"}' });
      const goodIdB = await client.xAdd(streamKey, '*', { json: '{"n":"good-b"}' });

      await client.xReadGroup(groupName, 'mixed-consumer', [{ key: streamKey, id: '>' }], {
        COUNT: 10,
      });
      await client.xDel(streamKey, poisonId);
      expect((await client.xPending(streamKey, groupName)).pending).toBe(3);

      const seen: StreamEntry[] = [];
      await expect(
        drainWithTimeout(consumer, async (entry) => {
          seen.push(entry);
        })
      ).resolves.toBeUndefined();

      expect(seen.map((e) => e.id)).toEqual([goodIdA, goodIdB]);
      expect(seen.map((e) => e.fields.json)).toEqual(['{"n":"good-a"}', '{"n":"good-b"}']);
      expect((await client.xPending(streamKey, groupName)).pending).toBe(0);
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(poisonId);
    });

    it('run() survives a poisoned PEL and goes on to process a newly added entry', async () => {
      const consumer = new StreamConsumer(client, {
        streamKey,
        groupName,
        consumerName: 'run-poison-consumer',
        blockMs: 200,
        count: 10,
      });
      await consumer.ensureGroup();

      const poisonId = await client.xAdd(streamKey, '*', { json: '{"n":"poison"}' });
      await client.xReadGroup(
        groupName,
        'run-poison-consumer',
        [{ key: streamKey, id: '>' }],
        { COUNT: 10 }
      );
      await client.xDel(streamKey, poisonId);

      // A fresh entry added after the poisoning; run() must reach it.
      const freshId = await client.xAdd(streamKey, '*', { json: '{"n":"fresh"}' });

      const seen: StreamEntry[] = [];
      const controller = new AbortController();
      await expect(
        withTimeout(
          consumer.run(async (entry) => {
            seen.push(entry);
            controller.abort();
          }, controller.signal),
          5000,
          'run() did not terminate — poison entry caused a loop'
        )
      ).resolves.toBeUndefined();

      expect(seen.map((e) => e.id)).toEqual([freshId]);
      expect((await client.xPending(streamKey, groupName)).pending).toBe(0);
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(poisonId);
    });

    it('rethrows a read failure that is NOT caused by a trimmed pending entry', async () => {
      // The recovery path must not become a blanket swallow: it only acts when it can
      // actually confirm a missing stream entry, otherwise the original error stands.
      const consumer = new StreamConsumer(client, {
        streamKey,
        groupName,
        consumerName: 'unrelated-failure',
        count: 10,
      });
      await consumer.ensureGroup();
      await client.xAdd(streamKey, '*', { json: '{"n":1}' });

      const original = new Error('ECONNRESET-ish, nothing to do with trimming');
      const spy = vi.spyOn(client, 'xReadGroup').mockRejectedValue(original);
      try {
        await expect(consumer.drainPending(async () => {})).rejects.toThrow(original);
      } finally {
        spy.mockRestore();
      }
      // Nothing was acked away in the process.
      expect(errorSpy.mock.calls).toHaveLength(0);
    });
  });

  // Recommendation: startId makes the new-group position configurable without
  // changing the default.
  describe('startId', () => {
    it('defaults to replaying all existing entries from the beginning of history', async () => {
      await client.xAdd(streamKey, '*', { json: '{"n":"pre-existing"}' });

      const consumer = new StreamConsumer(client, {
        streamKey,
        groupName,
        consumerName: 'default-start',
        count: 10,
      });
      await consumer.ensureGroup();

      const read = await client.xReadGroup(
        groupName,
        'default-start',
        [{ key: streamKey, id: '>' }],
        { COUNT: 10 }
      );
      expect(read?.[0]?.messages).toHaveLength(1);
    });

    it("with startId '$' skips entries that already existed", async () => {
      await client.xAdd(streamKey, '*', { json: '{"n":"pre-existing"}' });

      const consumer = new StreamConsumer(client, {
        streamKey,
        groupName,
        consumerName: 'tail-start',
        count: 10,
        startId: '$',
      });
      await consumer.ensureGroup();

      const readBefore = await client.xReadGroup(
        groupName,
        'tail-start',
        [{ key: streamKey, id: '>' }],
        { COUNT: 10 }
      );
      expect(readBefore ?? []).toHaveLength(0);

      const afterId = await client.xAdd(streamKey, '*', { json: '{"n":"after"}' });
      const readAfter = await client.xReadGroup(
        groupName,
        'tail-start',
        [{ key: streamKey, id: '>' }],
        { COUNT: 10 }
      );
      expect(readAfter?.[0]?.messages.map((m) => m.id)).toEqual([afterId]);
    });
  });
});

/** Fails loudly instead of hanging, so a "loops forever" regression shows up as a failure. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function drainWithTimeout(
  consumer: StreamConsumer,
  handler: (entry: StreamEntry) => Promise<void>
): Promise<void> {
  return withTimeout(
    consumer.drainPending(handler),
    5000,
    'drainPending did not terminate — poison entry caused a loop'
  );
}
