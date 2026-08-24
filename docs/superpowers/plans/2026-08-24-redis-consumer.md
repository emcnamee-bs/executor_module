# Redis Consumer (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume the `iip:items` Redis stream published by `Internet_Info_Plug`, parse each entry into a validated typed object, and log a structured summary line per item to stdout — proving the ingestion plumbing end-to-end with no downstream logic yet.

**Architecture:** A single Node.js/TypeScript process: a Redis client wrapper, a `StreamConsumer` that bootstraps a consumer group, drains its own pending entries on startup, then reads new entries in a blocking loop; a zod schema that validates the `json` field of each entry against the real `Item` shape; a log formatter; and a `main.ts` that wires it together with graceful shutdown.

**Tech Stack:** Node.js >=20, TypeScript (strict, ESM, `NodeNext`), `redis` npm package v4 (official client), `zod` for validation, `vitest` for tests, `tsx` for running without a build step.

**Spec:** `docs/superpowers/specs/2026-08-24-redis-consumer-design.md`

## Global Constraints

- Stream key: `iip:items`. Never write to it — this is a read-only consumer.
- Consumer group name: `execmod` (distinct from the sibling project's own group `iipx`, so the two can never collide if ever pointed at the same stream).
- Consumer name: a **fixed** string, `execmod-primary` (overridable via `EXECMOD_CONSUMER_NAME` env var) — never a random per-run UUID. Redis tracks a stream's pending-entries-list by consumer name; a random name would defeat the "restart redrains unacked entries" correctness property this plan relies on.
- Redis connection: `REDIS_URL` env var, default `redis://127.0.0.1:6379/0`. No auth, no TLS — matches how `Internet_Info_Plug`'s Redis is actually deployed.
- Never modify anything under `/Users/eamonmcnamee/Downloads/Internet_Info_Plug`. Read-only reference only.
- No keyphrase matching, model calls, or Kalshi/credential code in this plan — later slices.
- Tests must run against a real local Redis (no mocks) per `HANDOFF.md` §4's lesson — a test that never drives the real call site misses real wiring bugs. This requires a local Redis server reachable at `REDIS_URL` while running `npm test` (e.g. `brew install redis && redis-server` on macOS, running in another terminal). Each test uses its own randomly-suffixed stream/group keys and cleans them up, so it never touches real `iip:items` data.
- The full, corrected `Item` field list and types (from `Internet_Info_Plug/iip/schema.py`, verified directly against source, not from `HANDOFF.md`'s table which was missing 7 fields):

  | Field | Type |
  |---|---|
  | `item_id` | `string` |
  | `dedup_id` | `string` |
  | `story_key` | `string \| null` |
  | `event_type` | `"item" \| "item_amended"` |
  | `replay` | `boolean` |
  | `source_id` | `string` |
  | `adapter` | `string` |
  | `trust_tier` | `number` (integer, 1–5) |
  | `headline` | `string` |
  | `snippet` | `string \| null` |
  | `url` | `string \| null` |
  | `raw_url` | `string \| null` |
  | `enrich_url` | `string \| null` |
  | `author` | `string \| null` |
  | `lang` | `string \| null` |
  | `body_state` | `"absent" \| "fetching" \| "present" \| "paywalled" \| "failed"` |
  | `body` | `string \| null` |
  | `event_time` | `string \| null` (ISO datetime; always `null` in v1 — reserved) |
  | `source_publish_ts` | `string \| null` (ISO datetime) |
  | `first_seen_ts` | `string` (ISO datetime) |
  | `emitted_ts` | `string` (ISO datetime) |
  | `latency_ms` | `number \| null` (integer) |
  | `is_first_sighting` | `boolean` |
  | `corroborations` | `number` (integer) |
  | `provenance_gaps` | `Array<"synthetic_headline" \| "no_article_url" \| "title_not_headline">` |
  | `amends_item_id` | `string \| null` |
  | `amendment_kind` | `"headline_changed" \| "removed" \| null` |

  (Pydantic's `model_dump_json()` serializes `datetime` fields as ISO 8601 strings and `tuple[str, ...]` as a JSON array — this table reflects that.)

---

### Task 1: Project scaffolding and toolchain

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/main.ts` (stub)
- Test: `test/smoke.test.ts`

**Interfaces:**
- Produces: a working `npm run typecheck` and `npm test`, so every later task can rely on the toolchain being correct.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "executor-module",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "redis": "^4.7.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` created, no errors.

- [ ] **Step 4: Write a smoke test**

```typescript
// test/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('toolchain smoke test', () => {
  it('runs TypeScript under vitest', () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
```

- [ ] **Step 5: Create a stub `src/main.ts`**

```typescript
// src/main.ts
export async function main(): Promise<void> {
  console.log('executor-module: not yet implemented');
}
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: both succeed; the smoke test passes.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/main.ts test/smoke.test.ts
git commit -m "chore: scaffold Node/TypeScript toolchain"
```

---

### Task 2: `Item` schema and parser

**Files:**
- Create: `src/item.ts`
- Test: `test/item.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `export const ItemSchema: z.ZodObject<...>` — validates the full `Item` shape from the Global Constraints table.
  - `export type Item = z.infer<typeof ItemSchema>`
  - `export interface ParsedItem { ok: true; item: Item }`
  - `export interface ParseFailure { ok: false; error: string; raw: string }`
  - `export function parseItemFields(fields: Record<string, string>): ParsedItem | ParseFailure` — reads `fields.json`, JSON-parses it, validates against `ItemSchema`.

- [ ] **Step 1: Write failing tests for the schema and parser**

```typescript
// test/item.test.ts
import { describe, it, expect } from 'vitest';
import { parseItemFields, ItemSchema } from '../src/item.js';

function fullItemPayload(overrides: Record<string, unknown> = {}) {
  return {
    item_id: '1755999999999-a1b2c3d4e5f6',
    dedup_id: 'dedup-1',
    story_key: null,
    event_type: 'item',
    replay: false,
    source_id: 'bbc_world',
    adapter: 'feed',
    trust_tier: 1,
    headline: 'A real headline',
    snippet: 'A snippet',
    url: 'https://example.com/article',
    raw_url: 'https://example.com/article',
    enrich_url: null,
    author: 'Jane Reporter',
    lang: 'en',
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: '2026-08-24T10:00:00Z',
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

describe('ItemSchema', () => {
  it('accepts a fully-populated real item', () => {
    const result = ItemSchema.safeParse(fullItemPayload());
    expect(result.success).toBe(true);
  });

  it('accepts an item with a synthetic headline gap', () => {
    const result = ItemSchema.safeParse(
      fullItemPayload({ provenance_gaps: ['synthetic_headline'] })
    );
    expect(result.success).toBe(true);
  });

  it('accepts a replayed item', () => {
    const result = ItemSchema.safeParse(fullItemPayload({ replay: true }));
    expect(result.success).toBe(true);
  });

  it('accepts an amended item', () => {
    const result = ItemSchema.safeParse(
      fullItemPayload({
        event_type: 'item_amended',
        amends_item_id: '1755999999998-000000000000',
        amendment_kind: 'headline_changed',
      })
    );
    expect(result.success).toBe(true);
  });

  it('accepts an item with body absent', () => {
    const result = ItemSchema.safeParse(
      fullItemPayload({ body_state: 'absent', body: null })
    );
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const payload = fullItemPayload() as Record<string, unknown>;
    delete payload.item_id;
    const result = ItemSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe('parseItemFields', () => {
  it('parses a valid stream entry', () => {
    const fields = { json: JSON.stringify(fullItemPayload()) };
    const result = parseItemFields(fields);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.item_id).toBe('1755999999999-a1b2c3d4e5f6');
    }
  });

  it('fails cleanly when the json field is missing', () => {
    const result = parseItemFields({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('missing');
    }
  });

  it('fails cleanly on malformed JSON', () => {
    const result = parseItemFields({ json: '{not valid json' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
    }
  });

  it('fails cleanly on schema validation failure', () => {
    const payload = fullItemPayload() as Record<string, unknown>;
    delete payload.headline;
    const result = parseItemFields({ json: JSON.stringify(payload) });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/item.test.ts`
Expected: FAIL — `src/item.ts` does not exist yet.

- [ ] **Step 3: Implement `src/item.ts`**

```typescript
// src/item.ts
import { z } from 'zod';

const EventType = z.enum(['item', 'item_amended']);
const BodyState = z.enum(['absent', 'fetching', 'present', 'paywalled', 'failed']);
const AmendmentKind = z.enum(['headline_changed', 'removed']);
const ProvenanceGap = z.enum([
  'synthetic_headline',
  'no_article_url',
  'title_not_headline',
]);

export const ItemSchema = z.object({
  item_id: z.string(),
  dedup_id: z.string(),
  story_key: z.string().nullable(),
  event_type: EventType,
  replay: z.boolean(),
  source_id: z.string(),
  adapter: z.string(),
  trust_tier: z.number().int().min(1).max(5),
  headline: z.string(),
  snippet: z.string().nullable(),
  url: z.string().nullable(),
  raw_url: z.string().nullable(),
  enrich_url: z.string().nullable(),
  author: z.string().nullable(),
  lang: z.string().nullable(),
  body_state: BodyState,
  body: z.string().nullable(),
  event_time: z.string().nullable(),
  source_publish_ts: z.string().nullable(),
  first_seen_ts: z.string(),
  emitted_ts: z.string(),
  latency_ms: z.number().int().nullable(),
  is_first_sighting: z.boolean(),
  corroborations: z.number().int(),
  provenance_gaps: z.array(ProvenanceGap),
  amends_item_id: z.string().nullable(),
  amendment_kind: AmendmentKind.nullable(),
});

export type Item = z.infer<typeof ItemSchema>;

export interface ParsedItem {
  ok: true;
  item: Item;
}

export interface ParseFailure {
  ok: false;
  error: string;
  raw: string;
}

export function parseItemFields(
  fields: Record<string, string>
): ParsedItem | ParseFailure {
  const raw = fields.json;
  if (raw === undefined) {
    return { ok: false, error: 'missing json field on stream entry', raw: JSON.stringify(fields) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}`, raw };
  }

  const result = ItemSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message, raw };
  }

  return { ok: true, item: result.data };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/item.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/item.ts test/item.test.ts
git commit -m "feat: add validated Item schema and stream-entry parser"
```

---

### Task 3: Log formatting

**Files:**
- Create: `src/log.ts`
- Test: `test/log.test.ts`

**Interfaces:**
- Consumes: `Item` type from Task 2 (`src/item.ts`).
- Produces: `export function formatSummaryLine(item: Item): string`

- [ ] **Step 1: Write failing tests**

```typescript
// test/log.test.ts
import { describe, it, expect } from 'vitest';
import { formatSummaryLine } from '../src/log.js';
import type { Item } from '../src/item.js';

function baseItem(overrides: Partial<Item> = {}): Item {
  return {
    item_id: '1755999999999-a1b2c3d4e5f6',
    dedup_id: 'dedup-1',
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

describe('formatSummaryLine', () => {
  it('includes item id, source, trust tier, event type, and headline', () => {
    const line = formatSummaryLine(baseItem());
    expect(line).toContain('1755999999999-a1b2c3d4e5f6');
    expect(line).toContain('bbc_world');
    expect(line).toContain('trust=1');
    expect(line).toContain('event=item');
    expect(line).toContain('A real headline');
  });

  it('marks a synthetic headline', () => {
    const line = formatSummaryLine(
      baseItem({ provenance_gaps: ['synthetic_headline'] })
    );
    expect(line).toContain('[synthetic]');
  });

  it('tags a replayed item', () => {
    const line = formatSummaryLine(baseItem({ replay: true }));
    expect(line).toContain('REPLAY');
  });

  it('does not tag a non-replayed item', () => {
    const line = formatSummaryLine(baseItem({ replay: false }));
    expect(line).not.toContain('REPLAY');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/log.test.ts`
Expected: FAIL — `src/log.ts` does not exist yet.

- [ ] **Step 3: Implement `src/log.ts`**

```typescript
// src/log.ts
import type { Item } from './item.js';

export function formatSummaryLine(item: Item): string {
  const headlinePart = item.provenance_gaps.includes('synthetic_headline')
    ? `[synthetic] ${item.headline}`
    : item.headline;
  const replayTag = item.replay ? ' REPLAY' : '';

  return `[${item.item_id}] source=${item.source_id} trust=${item.trust_tier} event=${item.event_type}${replayTag} :: ${headlinePart}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/log.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "feat: add stdout summary line formatter"
```

---

### Task 4: Redis client wrapper

**Files:**
- Create: `src/redis/client.ts`
- Test: `test/redis/client.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export function createRedisClient(url?: string): RedisClientType` (from the `redis` package).

**Prerequisite:** a local Redis server must be running and reachable at `REDIS_URL` (default `redis://127.0.0.1:6379/0`) for this task's test to pass.

- [ ] **Step 1: Write a failing test**

```typescript
// test/redis/client.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/redis/client.test.ts`
Expected: FAIL — `src/redis/client.ts` does not exist yet.

- [ ] **Step 3: Implement `src/redis/client.ts`**

```typescript
// src/redis/client.ts
import { createClient, type RedisClientType } from 'redis';

export function createRedisClient(
  url: string = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0'
): RedisClientType {
  return createClient({ url }) as RedisClientType;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/redis/client.test.ts`
Expected: PASS. If it fails with a connection error, start a local Redis server first (`redis-server`, or `brew services start redis` on macOS) and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/redis/client.ts test/redis/client.test.ts
git commit -m "feat: add Redis client wrapper"
```

---

### Task 5: Stream consumer loop

**Files:**
- Create: `src/redis/consumer.ts`
- Test: `test/redis/consumer.test.ts`

**Interfaces:**
- Consumes: `RedisClientType` from Task 4 (`createRedisClient`).
- Produces:
  - `export interface ConsumerOptions { streamKey: string; groupName: string; consumerName: string; blockMs?: number; count?: number }`
  - `export interface StreamEntry { id: string; fields: Record<string, string> }`
  - `export type ItemHandler = (entry: StreamEntry) => Promise<void>`
  - `export class StreamConsumer { constructor(client: RedisClientType, opts: ConsumerOptions); ensureGroup(): Promise<void>; drainPending(handler: ItemHandler): Promise<void>; run(handler: ItemHandler, signal: AbortSignal): Promise<void> }`

**Prerequisite:** same local Redis requirement as Task 4.

- [ ] **Step 1: Write failing tests**

```typescript
// test/redis/consumer.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/redis/consumer.test.ts`
Expected: FAIL — `src/redis/consumer.ts` does not exist yet.

- [ ] **Step 3: Implement `src/redis/consumer.ts`**

```typescript
// src/redis/consumer.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/redis/consumer.test.ts`
Expected: PASS, all cases. If the API shape of `xReadGroup`/`xPending` from the installed `redis` package version differs from what's used here, adjust the implementation (not the test's intent) to match — the test's assertions (what gets handled, what gets acked, what survives a simulated restart) are the actual spec.

- [ ] **Step 5: Commit**

```bash
git add src/redis/consumer.ts test/redis/consumer.test.ts
git commit -m "feat: add stream consumer with PEL drain and fixed consumer identity"
```

---

### Task 6: Wire `main.ts` end-to-end

**Files:**
- Modify: `src/main.ts`
- Test: `test/main.test.ts`

**Interfaces:**
- Consumes: `createRedisClient` (Task 4), `StreamConsumer`/`StreamEntry` (Task 5), `parseItemFields` (Task 2), `formatSummaryLine` (Task 3).
- Produces: `export async function runOnce(client: RedisClientType, opts: ConsumerOptions, onLine: (line: string) => void, signal: AbortSignal): Promise<void>` — the assembled pipeline, factored out of `main()` so it can be driven directly in a test against a real Redis instance without relying on process signals or stdout capture.

**Prerequisite:** same local Redis requirement as Tasks 4–5.

- [ ] **Step 1: Write failing end-to-end tests**

```typescript
// test/main.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../src/redis/client.js';
import { runOnce } from '../src/main.js';
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
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL — `runOnce` does not exist yet.

- [ ] **Step 3: Implement `src/main.ts`**

```typescript
// src/main.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/main.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: everything passes.

- [ ] **Step 6: Manual smoke check against the real stream (optional, requires `iip` actually publishing)**

Run: `npm run dev`
Expected: if `iip` is running and publishing to `iip:items` on the same Redis, summary lines print to stdout as items arrive. Stop with Ctrl-C and confirm it exits cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts test/main.test.ts
git commit -m "feat: wire Redis consumer, parser, and logger end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 6), all five components from the spec (Tasks 2–6), corrected field list (Global Constraints + Task 2), data flow/error handling incl. parse-failure-still-acks (Task 2 + Task 6's `runOnce`), real-Redis testing incl. all named edge cases and a restart/redrain test (Tasks 5–6) are each covered by a task.
- **Placeholder scan:** none found — every step has runnable code or an exact command.
- **Type consistency:** `Item`, `ParsedItem`/`ParseFailure`, `StreamEntry`, `ItemHandler`, `ConsumerOptions`, and `StreamConsumer`'s method names are used identically across Tasks 2, 3, 5, and 6.
