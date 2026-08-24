import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../src/redis/client.js';
import { runOnce, truncateRaw } from '../src/main.js';
import type { RedisClientType } from 'redis';

function realisticPayload(overrides: Record<string, unknown> = {}) {
  return {
    item_id: `${Date.now()}-${randomUUID().slice(0, 12)}`,
    dedup_id: randomUUID(),
    story_key: null,
    event_type: 'item',
    replay: false,
    source_id: 'bbc_world',
    adapter: 'feed',
    trust_tier: 1,
    headline: 'A real headline',
    snippet: null,
    url: null,
    raw_url: null,
    enrich_url: null,
    author: null,
    lang: null,
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: null,
    first_seen_ts: '2026-08-24T10:01:00Z',
    emitted_ts: '2026-08-24T10:01:05Z',
    latency_ms: 5000,
    is_first_sighting: true,
    corroborations: 0,
    provenance_gaps: [],
    amends_item_id: null,
    amendment_kind: null,
    ...overrides,
  };
}

describe('runOnce (end-to-end)', () => {
  let client: RedisClientType;
  let streamKey: string;
  let groupName: string;

  beforeEach(async () => {
    client = createRedisClient();
    await client.connect();
    streamKey = `test:iip:items:${randomUUID()}`;
    groupName = `test-execmod-${randomUUID()}`;
  });

  afterEach(async () => {
    await client.del(streamKey);
    await client.quit();
  });

  it('logs a real item, a synthetic-headline item, a replay, an amendment, and a body-absent item', async () => {
    await client.xAdd(streamKey, '*', { json: JSON.stringify(realisticPayload()) });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ provenance_gaps: ['synthetic_headline'] })),
    });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ replay: true })),
    });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          event_type: 'item_amended',
          amends_item_id: 'some-prior-id',
          amendment_kind: 'headline_changed',
        })
      ),
    });
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ body_state: 'absent', body: null })),
    });
    await client.xAdd(streamKey, '*', { json: '{not valid json' });

    const lines: string[] = [];
    const controller = new AbortController();
    let handled = 0;

    await runOnce(
      client,
      { streamKey, groupName, consumerName: 'test-main-consumer', blockMs: 500, count: 10 },
      (line) => {
        lines.push(line);
        handled += 1;
        if (handled >= 6) controller.abort();
      },
      controller.signal
    );

    expect(lines).toHaveLength(6);
    expect(lines.some((l) => l.includes('[synthetic]'))).toBe(true);
    expect(lines.some((l) => l.includes('REPLAY'))).toBe(true);
    expect(lines.some((l) => l.includes('event=item_amended'))).toBe(true);
    expect(lines.some((l) => l.startsWith('[parse-error]'))).toBe(true);

    // The "one line per item" contract holds on every line, including the error one.
    for (const line of lines) {
      expect(line).not.toContain('\n');
    }
  });

  // I1, end to end: an older archived payload that predates several fields must flow
  // all the way through the real consumer to a real summary line, not a parse error.
  it('logs an older payload that omits the fields upstream defaults, rather than rejecting it', async () => {
    const oldPayload = {
      item_id: '1700000000000-cccccccccccc',
      dedup_id: randomUUID(),
      source_id: 'ap_top',
      adapter: 'feed',
      trust_tier: 1,
      headline: 'An item from before the schema grew',
      first_seen_ts: '2023-11-14T22:13:20Z',
      emitted_ts: '2023-11-14T22:13:21Z',
    };
    await client.xAdd(streamKey, '*', { json: JSON.stringify(oldPayload) });

    const lines: string[] = [];
    const controller = new AbortController();

    await runOnce(
      client,
      { streamKey, groupName, consumerName: 'test-old-payload', blockMs: 500, count: 10 },
      (line) => {
        lines.push(line);
        controller.abort();
      },
      controller.signal
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('[parse-error]');
    expect(lines[0]).toContain('1700000000000-cccccccccccc');
    expect(lines[0]).toContain('source=ap_top');
    // event_type defaulted to 'item' and replay defaulted to false.
    expect(lines[0]).toContain('event=item');
    expect(lines[0]).not.toContain('REPLAY');
    expect((await client.xPending(streamKey, groupName)).pending).toBe(0);
  });

  // I5: the parse-error branch is the diagnostic for upstream schema drift. It must
  // stay on ONE line and must carry the raw payload — dropping `raw` (as it used to)
  // makes it a guard that fires correctly and says nothing about what it saw.
  describe('parse-error line', () => {
    it('is a single line carrying a compact error and the raw payload', async () => {
      const badPayload = JSON.stringify({
        ...realisticPayload(),
        headline: 12345, // wrong type — a realistic schema-drift shape
      });
      await client.xAdd(streamKey, '*', { json: badPayload });

      const lines: string[] = [];
      const controller = new AbortController();
      await runOnce(
        client,
        { streamKey, groupName, consumerName: 'test-parse-error', blockMs: 500, count: 10 },
        (line) => {
          lines.push(line);
          controller.abort();
        },
        controller.signal
      );

      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line).toContain('[parse-error]');
      expect(line).not.toContain('\n');
      expect(line).toContain('headline');
      expect(line).toContain('raw=');
      // The raw payload actually made it into the line, not just the marker.
      expect(line).toContain('"source_id":"bbc_world"');
      // Still acked despite failing to parse, per the spec.
      expect((await client.xPending(streamKey, groupName)).pending).toBe(0);
    });

    it('truncates an oversized raw payload onto one line with an explicit marker', async () => {
      const hugePayload = JSON.stringify({
        ...realisticPayload(),
        headline: 12345,
        body: 'x'.repeat(5000),
      });
      await client.xAdd(streamKey, '*', { json: hugePayload });

      const lines: string[] = [];
      const controller = new AbortController();
      await runOnce(
        client,
        { streamKey, groupName, consumerName: 'test-truncate', blockMs: 500, count: 10 },
        (line) => {
          lines.push(line);
          controller.abort();
        },
        controller.signal
      );

      expect(lines).toHaveLength(1);
      const line = lines[0];
      expect(line).not.toContain('\n');
      expect(line).toContain('...(truncated)');
      expect(line.length).toBeLessThan(1200);
      // The 5000-char body did not make it through wholesale.
      expect(line).not.toContain('x'.repeat(600));
    });

    it('flattens embedded newlines in a raw payload onto one line', () => {
      const withNewlines = '{"headline":"line one\nline two\rline three"}';
      const out = truncateRaw(withNewlines);
      expect(out).not.toContain('\n');
      expect(out).not.toContain('\r');
      expect(out).toContain('line one line two line three');
    });

    it('leaves a short payload untouched and unmarked', () => {
      expect(truncateRaw('{"a":1}')).toBe('{"a":1}');
    });
  });
});
