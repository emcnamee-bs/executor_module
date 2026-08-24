import type { RedisClientType } from 'redis';

export interface ConsumerOptions {
  streamKey: string;
  groupName: string;
  consumerName: string;
  blockMs?: number;
  count?: number;
  /**
   * Where a NEWLY created consumer group starts reading from.
   * `'0'` (the default, and the historical behaviour) is the beginning of history —
   * the group replays every entry still in the stream on its first run.
   * `'$'` is the tail — only entries added after the group is created.
   * Ignored when the group already exists; Redis keeps the existing position.
   */
  startId?: '0' | '$';
}

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export type ItemHandler = (entry: StreamEntry) => Promise<void>;

interface RawMessage {
  id: string;
  message: Record<string, string>;
}

export class StreamConsumer {
  constructor(
    private readonly client: RedisClientType,
    private readonly opts: ConsumerOptions
  ) {}

  /**
   * Creates the consumer group at the beginning-of-history marker '0' (replays all
   * existing entries on first run) unless `startId: '$'` asks for tail-only, creating
   * the stream if absent. Idempotent — an existing group is left exactly where it is.
   */
  async ensureGroup(): Promise<void> {
    try {
      await this.client.xGroupCreate(
        this.opts.streamKey,
        this.opts.groupName,
        this.opts.startId ?? '0',
        { MKSTREAM: true }
      );
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
      let messages: RawMessage[];
      try {
        messages = await this.readGroup('0');
      } catch (err) {
        // A trimmed/XDELed entry that is still in this consumer's pending list makes
        // node-redis's own reply transform throw before we ever see the batch, so the
        // whole read is lost — not just the poison entry. Unstick it and retry, so the
        // OTHER pending entries in the same batch still get processed.
        if (await this.ackTrimmedPendingEntries()) continue;
        throw err;
      }

      if (messages.length === 0) {
        return;
      }

      for (const message of messages) {
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
      let messages: RawMessage[];
      try {
        messages = await this.readGroup('>', this.opts.blockMs ?? 5000);
      } catch (err) {
        if (await this.ackTrimmedPendingEntries()) continue;
        throw err;
      }

      for (const message of messages) {
        await handler({ id: message.id, fields: message.message });
        await this.client.xAck(this.opts.streamKey, this.opts.groupName, message.id);
        if (signal.aborted) return;
      }
    }
  }

  private async readGroup(id: '0' | '>', blockMs?: number): Promise<RawMessage[]> {
    const options: { COUNT: number; BLOCK?: number } = {
      COUNT: this.opts.count ?? 10,
    };
    if (blockMs !== undefined) options.BLOCK = blockMs;

    const result = await this.client.xReadGroup(
      this.opts.groupName,
      this.opts.consumerName,
      [{ key: this.opts.streamKey, id }],
      options
    );

    return (result?.[0]?.messages ?? []) as RawMessage[];
  }

  /**
   * Poison-entry recovery for a failed XREADGROUP.
   *
   * A pending entry whose underlying stream entry has since been removed (XDEL, or
   * MAXLEN trimming — `iip/emit.py` XADDs with `maxlen=1_000_000, approximate=True`,
   * so this is a real production scenario) comes back from Redis with a nil body.
   * node-redis's `transformStreamMessageReply` dereferences that nil and throws a
   * TypeError, so the rejection surfaces from `xReadGroup` itself and the existing
   * `if (!message.message) continue` guard never runs. Left unhandled that is an
   * unrecoverable crash loop: the process dies, restarts, re-reads the same pending
   * entry, and dies again until someone XACKs it by hand.
   *
   * Rather than pattern-match the TypeError's wording, this VERIFIES the diagnosis
   * before acting on it: it lists this consumer's pending ids and checks each one
   * against the stream. Only ids Redis confirms are gone get acked. If none are
   * missing the read failed for some other reason, we report `false`, and the caller
   * rethrows the original error untouched.
   *
   * @returns whether at least one poison entry was acked (i.e. whether a retry can
   *          now make progress).
   */
  private async ackTrimmedPendingEntries(): Promise<boolean> {
    const pending = await this.client.xPendingRange(
      this.opts.streamKey,
      this.opts.groupName,
      '-',
      '+',
      this.opts.count ?? 10,
      { consumer: this.opts.consumerName }
    );

    let ackedAny = false;
    for (const entry of pending) {
      const id = entry.id.toString();
      const stillInStream = await this.client.xRange(this.opts.streamKey, id, id);
      if (stillInStream.length > 0) continue;

      console.error(
        `[consumer] poison pending entry ${id} on stream=${this.opts.streamKey} ` +
          `group=${this.opts.groupName} consumer=${this.opts.consumerName}: the ` +
          `underlying stream entry no longer exists (trimmed or XDELed), so it can ` +
          `never be delivered. Acking it to unblock the pending list. This entry's ` +
          `content is permanently lost.`
      );
      await this.client.xAck(this.opts.streamKey, this.opts.groupName, id);
      ackedAny = true;
    }

    return ackedAny;
  }
}
