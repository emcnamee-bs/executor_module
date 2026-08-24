import type { RedisClientType } from 'redis';

export interface ConsumerOptions {
  streamKey: string;
  groupName: string;
  consumerName: string;
  blockMs?: number;
  count?: number;
}

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export type ItemHandler = (entry: StreamEntry) => Promise<void>;

export class StreamConsumer {
  constructor(
    private readonly client: RedisClientType,
    private readonly opts: ConsumerOptions
  ) {}

  /** Creates the consumer group at the tail-of-history marker '0', creating the stream if absent. Idempotent. */
  async ensureGroup(): Promise<void> {
    try {
      await this.client.xGroupCreate(this.opts.streamKey, this.opts.groupName, '0', {
        MKSTREAM: true,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('BUSYGROUP')) {
        return;
      }
      throw err;
    }
  }

  /** Reads and acks this consumer's own already-delivered-but-unacked entries. */
  async drainPending(handler: ItemHandler): Promise<void> {
    while (true) {
      const result = await this.client.xReadGroup(
        this.opts.groupName,
        this.opts.consumerName,
        [{ key: this.opts.streamKey, id: '0' }],
        { COUNT: this.opts.count ?? 10 }
      );

      const messages = result?.[0]?.messages ?? [];
      if (messages.length === 0) {
        return;
      }

      for (const message of messages) {
        if (!message.message) continue;
        await handler({ id: message.id, fields: message.message });
        await this.client.xAck(this.opts.streamKey, this.opts.groupName, message.id);
      }
    }
  }

  /** Reads new entries until the signal aborts. Drains pending entries first. */
  async run(handler: ItemHandler, signal: AbortSignal): Promise<void> {
    await this.ensureGroup();
    await this.drainPending(handler);

    while (!signal.aborted) {
      const result = await this.client.xReadGroup(
        this.opts.groupName,
        this.opts.consumerName,
        [{ key: this.opts.streamKey, id: '>' }],
        { COUNT: this.opts.count ?? 10, BLOCK: this.opts.blockMs ?? 5000 }
      );

      const messages = result?.[0]?.messages ?? [];
      for (const message of messages) {
        if (!message.message) continue;
        await handler({ id: message.id, fields: message.message });
        await this.client.xAck(this.opts.streamKey, this.opts.groupName, message.id);
        if (signal.aborted) return;
      }
    }
  }
}
