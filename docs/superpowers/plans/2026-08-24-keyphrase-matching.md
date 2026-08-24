# Keyphrase Matching (Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when an incoming `iip:items` entry contains an AI-curated keyphrase (checked against `headline`+`snippet`, with a synthetic-headline exception) and log the match — with a companion script that uses Sonnet to refine the keyphrase list itself. No Haiku/Sonnet dispatch on a match yet.

**Architecture:** Two new independent modules — a deterministic `keyphrases/match.ts` (no API calls, runs on every item) and a standalone `keyphrases/generate.ts` script (one real Sonnet call, run manually or by a future cron job) — both built on a shared `keyphrases/list.ts` loader. `main.ts`'s per-item handling is rewired from a `onLine(string)` callback to an `onItem` callback carrying the parsed `Item` and its matched phrases, so matching logic lives outside the formatting/logging concern.

**Tech Stack:** Same as slice 1 (Node >=20, TypeScript strict/ESM, vitest, real local Redis for consumer tests) plus `@anthropic-ai/sdk` for the generator, calling `claude-sonnet-5` with Zod-based structured output (`zodOutputFormat` + `client.messages.parse`).

**Spec:** `docs/superpowers/specs/2026-08-24-keyphrase-matching-design.md`

## Global Constraints

- Match fields: `headline` + `snippet`; **`snippet` only** when `item.provenance_gaps` includes `'synthetic_headline'` (the headline is a content-free template in that case, produced by `Internet_Info_Plug`'s page-watcher adapter).
- Match semantics: case-insensitive, **word-boundary-aware, contiguous phrase match** (not order-independent word presence).
- Keyphrase list: `data/keyphrases.json`, a flat JSON array of strings, starts as `[]`. No tiering, no size cap.
- Minimum phrase length: **2 words**. Enforced when the list is loaded — a too-short entry is logged as a warning and skipped, never a fatal error (the file is operator/LLM-editable data, not code).
- A malformed `data/keyphrases.json` (bad JSON, wrong shape, non-string entries) **must throw** when loaded — never silently produce an empty/degraded list.
- Generator model: exactly `claude-sonnet-5`, via `@anthropic-ai/sdk`'s `client.messages.parse()` with `output_config.format` built from a Zod schema (`zodOutputFormat`) — never free-text parsing of the model's response.
- Generator behavior: refines the *current* `data/keyphrases.json` (never regenerates from nothing when a list already exists). On any failure, **leave the file untouched and exit non-zero** — no custom retry loop.
- Credentials: `ANTHROPIC_API_KEY` comes from the environment only (the operator's `.envrc`, via direnv) — never hardcoded, never logged. `.envrc` must be added to `.gitignore` before any code that could read it is written.
- Match reporting: **one log line per item** listing every matched phrase (not one line per phrase) — `[KEYPHRASE-MATCH] item=<id> phrases=[...] headline=...`.
- No Kalshi/order-execution/Haiku-dispatch code anywhere in this plan — out of scope for this slice.
- Real-Redis testing (no mocks) for anything touching the stream, per this project's established pattern from slice 1; the generator's tests include a real Anthropic API call (per the operator's explicit choice), not a mocked client.

---

### Task 1: Project setup — credential hygiene, keyphrase data file, SDK dependency

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `data/keyphrases.json`

**Interfaces:**
- Produces: `@anthropic-ai/sdk` as an installed dependency; `data/keyphrases.json` as a file every later task can load; an `npm run generate-keyphrases` script later tasks' code will be runnable through.

- [ ] **Step 1: Add `.envrc` to `.gitignore`**

Add this line under the existing "Credential hygiene" section of `.gitignore` (which currently reads `.env`, `.env.*`, `*.pem`, `*.key`, `secrets/`, `credentials/`):

```
.envrc
```

- [ ] **Step 2: Add the Anthropic SDK dependency and the generator script to `package.json`**

Current `package.json`:

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

Change `scripts` and `dependencies` to:

```json
  "scripts": {
    "dev": "tsx src/main.ts",
    "generate-keyphrases": "tsx src/keyphrases/generate.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.120.0",
    "redis": "^4.7.0",
    "zod": "^3.23.8"
  },
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/@anthropic-ai/sdk` created, `package-lock.json` updated, no errors.

- [ ] **Step 4: Create `data/keyphrases.json`**

```json
[]
```

- [ ] **Step 5: Verify nothing broke and the new file/ignore rule are correct**

Run: `npm run typecheck && npm test`
Expected: unchanged — same 47 tests passing (no new code yet).

Run: `git check-ignore .envrc`
Expected: prints `.envrc` (confirms it is now ignored). If it prints nothing, the `.gitignore` edit did not take — check the line was added correctly.

Run: `cat data/keyphrases.json`
Expected: `[]`

- [ ] **Step 6: Commit**

```bash
git add .gitignore package.json package-lock.json data/keyphrases.json
git commit -m "chore: add Anthropic SDK dependency, keyphrases data file, and .envrc hygiene"
```

---

### Task 2: Keyphrase list loader and validator

**Files:**
- Create: `src/keyphrases/list.ts`
- Test: `test/keyphrases/list.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `export const DEFAULT_KEYPHRASES_PATH: string` — resolves to `<repo root>/data/keyphrases.json` regardless of current working directory.
  - `export function loadKeyphrases(filePath: string): string[]` — throws if the file is missing/unreadable, not valid JSON, not a JSON array, or contains a non-string entry. Warns (via `console.warn`) and skips any string entry with fewer than 2 words.
  - `export function saveKeyphrases(filePath: string, phrases: string[]): void` — overwrites the file with a pretty-printed JSON array.

- [ ] **Step 1: Write failing tests**

```typescript
// test/keyphrases/list.test.ts
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadKeyphrases, saveKeyphrases } from '../../src/keyphrases/list.js';

function tempFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'keyphrases-test-'));
  const file = path.join(dir, 'keyphrases.json');
  writeFileSync(file, content, 'utf-8');
  return file;
}

describe('loadKeyphrases', () => {
  it('loads a valid list of 2+ word phrases', () => {
    const file = tempFile(JSON.stringify(['trump approval rating', 'new poll released']));
    expect(loadKeyphrases(file)).toEqual(['trump approval rating', 'new poll released']);
  });

  it('warns and skips a phrase with fewer than 2 words', () => {
    const file = tempFile(JSON.stringify(['trump', 'trump approval rating']));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadKeyphrases(file);
    expect(result).toEqual(['trump approval rating']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('loads an empty list', () => {
    const file = tempFile('[]');
    expect(loadKeyphrases(file)).toEqual([]);
  });

  it('throws if the file does not exist', () => {
    expect(() => loadKeyphrases('/nonexistent/path/keyphrases.json')).toThrow();
  });

  it('throws on malformed JSON', () => {
    const file = tempFile('{not valid json');
    expect(() => loadKeyphrases(file)).toThrow(/not valid JSON/);
  });

  it('throws if the parsed content is not an array', () => {
    const file = tempFile(JSON.stringify({ not: 'an array' }));
    expect(() => loadKeyphrases(file)).toThrow(/must be a JSON array/);
  });

  it('throws if an entry is not a string', () => {
    const file = tempFile(JSON.stringify(['valid phrase here', 42]));
    expect(() => loadKeyphrases(file)).toThrow(/non-string entry/);
  });
});

describe('saveKeyphrases', () => {
  it('writes a list that loadKeyphrases can read back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'keyphrases-test-'));
    const file = path.join(dir, 'keyphrases.json');
    saveKeyphrases(file, ['trump approval rating', 'new poll released']);
    expect(loadKeyphrases(file)).toEqual(['trump approval rating', 'new poll released']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/keyphrases/list.test.ts`
Expected: FAIL — `src/keyphrases/list.ts` does not exist yet.

- [ ] **Step 3: Implement `src/keyphrases/list.ts`**

```typescript
// src/keyphrases/list.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_KEYPHRASES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/keyphrases.json'
);

function countWords(phrase: string): number {
  return phrase.trim().split(/\s+/).filter(Boolean).length;
}

export function loadKeyphrases(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `keyphrases file not found or unreadable at ${filePath}: ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `keyphrases file at ${filePath} is not valid JSON: ${(err as Error).message}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `keyphrases file at ${filePath} must be a JSON array, got ${typeof parsed}`
    );
  }

  const result: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      throw new Error(
        `keyphrases file at ${filePath} contains a non-string entry: ${JSON.stringify(entry)}`
      );
    }
    if (countWords(entry) < 2) {
      console.warn(`[keyphrases] skipping phrase with fewer than 2 words: ${JSON.stringify(entry)}`);
      continue;
    }
    result.push(entry);
  }
  return result;
}

export function saveKeyphrases(filePath: string, phrases: string[]): void {
  fs.writeFileSync(filePath, JSON.stringify(phrases, null, 2) + '\n', 'utf-8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/keyphrases/list.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/keyphrases/list.ts test/keyphrases/list.test.ts
git commit -m "feat: add keyphrase list loader with 2-word-minimum validation"
```

---

### Task 3: Keyphrase matcher

**Files:**
- Create: `src/keyphrases/match.ts`
- Test: `test/keyphrases/match.test.ts`

**Interfaces:**
- Consumes: `Item` type from `src/item.ts` (for `getMatchableText` only).
- Produces:
  - `export interface CompiledPhrase { phrase: string; regex: RegExp }`
  - `export function compilePhrases(phrases: string[]): CompiledPhrase[]`
  - `export function findMatches(text: string, compiled: CompiledPhrase[]): string[]`
  - `export function getMatchableText(item: Item): string` — `item.snippet ?? ''` when `item.provenance_gaps` includes `'synthetic_headline'`; otherwise `item.headline` and `item.snippet` joined with a space (skipping a `null` snippet).

- [ ] **Step 1: Write failing tests**

```typescript
// test/keyphrases/match.test.ts
import { describe, it, expect } from 'vitest';
import { compilePhrases, findMatches, getMatchableText } from '../../src/keyphrases/match.js';
import type { Item } from '../../src/item.js';

describe('compilePhrases + findMatches', () => {
  it('matches case-insensitively', () => {
    const compiled = compilePhrases(['trump approval rating']);
    expect(findMatches('TRUMP APPROVAL RATING drops', compiled)).toEqual(['trump approval rating']);
  });

  it('respects word boundaries (does not match inside a longer word)', () => {
    const compiled = compilePhrases(['poll release']);
    expect(findMatches('a bipoll release-like event', compiled)).toEqual([]);
  });

  it('matches a phrase containing an apostrophe', () => {
    const compiled = compilePhrases(["trump's approval numbers"]);
    expect(findMatches("New data on trump's approval numbers today", compiled)).toEqual([
      "trump's approval numbers",
    ]);
  });

  it('matches a phrase containing a hyphen', () => {
    const compiled = compilePhrases(['self-driving car poll']);
    expect(findMatches('A new self-driving car poll was released', compiled)).toEqual([
      'self-driving car poll',
    ]);
  });

  it('returns all matched phrases when multiple match', () => {
    const compiled = compilePhrases(['trump approval', 'new poll released']);
    const result = findMatches('trump approval steady after new poll released today', compiled);
    expect(result.sort()).toEqual(['new poll released', 'trump approval'].sort());
  });

  it('returns an empty array when nothing matches', () => {
    const compiled = compilePhrases(['trump approval rating']);
    expect(findMatches('completely unrelated sports news', compiled)).toEqual([]);
  });

  it('safely handles phrases containing regex-special characters', () => {
    const compiled = compilePhrases(['q&a session (live)']);
    expect(findMatches('the q&a session (live) starts soon', compiled)).toEqual([
      'q&a session (live)',
    ]);
  });
});

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

describe('getMatchableText', () => {
  it('combines headline and snippet for a normal item', () => {
    const item = baseItem({ headline: 'Headline text', snippet: 'Snippet text' });
    expect(getMatchableText(item)).toBe('Headline text Snippet text');
  });

  it('uses headline alone when snippet is null', () => {
    const item = baseItem({ headline: 'Headline only', snippet: null });
    expect(getMatchableText(item)).toBe('Headline only');
  });

  it('uses only snippet for a synthetic-headline item', () => {
    const item = baseItem({
      headline: 'source_x: watched page region changed',
      snippet: 'real page content here',
      provenance_gaps: ['synthetic_headline'],
    });
    expect(getMatchableText(item)).toBe('real page content here');
  });

  it('returns an empty string for a synthetic-headline item with no snippet', () => {
    const item = baseItem({
      headline: 'source_x: watched page region changed',
      snippet: null,
      provenance_gaps: ['synthetic_headline'],
    });
    expect(getMatchableText(item)).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/keyphrases/match.test.ts`
Expected: FAIL — `src/keyphrases/match.ts` does not exist yet.

- [ ] **Step 3: Implement `src/keyphrases/match.ts`**

```typescript
// src/keyphrases/match.ts
import type { Item } from '../item.js';

export interface CompiledPhrase {
  phrase: string;
  regex: RegExp;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compilePhrases(phrases: string[]): CompiledPhrase[] {
  return phrases.map((phrase) => ({
    phrase,
    regex: new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i'),
  }));
}

export function findMatches(text: string, compiled: CompiledPhrase[]): string[] {
  return compiled.filter(({ regex }) => regex.test(text)).map(({ phrase }) => phrase);
}

export function getMatchableText(item: Item): string {
  if (item.provenance_gaps.includes('synthetic_headline')) {
    return item.snippet ?? '';
  }
  return [item.headline, item.snippet].filter((value): value is string => Boolean(value)).join(' ');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/keyphrases/match.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/keyphrases/match.ts test/keyphrases/match.test.ts
git commit -m "feat: add deterministic keyphrase matcher and matchable-text builder"
```

---

### Task 4: Keyphrase generator (Sonnet-driven refinement script)

**Files:**
- Create: `src/keyphrases/generate.ts`
- Test: `test/keyphrases/generate.test.ts`

**Interfaces:**
- Consumes: `loadKeyphrases`, `saveKeyphrases`, `DEFAULT_KEYPHRASES_PATH` from `src/keyphrases/list.ts` (Task 2).
- Produces: `export async function refineKeyphrases(client: Anthropic, currentPhrases: string[]): Promise<string[]>` — the testable core logic (no file I/O), plus a CLI entrypoint (`main()`, guarded by the `import.meta.url` check) that wires `loadKeyphrases` → `refineKeyphrases` → `saveKeyphrases`, catching any failure to leave the file untouched and exit non-zero.

**Prerequisite:** `ANTHROPIC_API_KEY` must be set in the environment (e.g. via the operator's `.envrc` and direnv) for this task's tests to pass — they make real API calls, per this project's explicit testing choice for the generator.

- [ ] **Step 1: Write failing tests**

```typescript
// test/keyphrases/generate.test.ts
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { refineKeyphrases } from '../../src/keyphrases/generate.js';

describe('refineKeyphrases (real Sonnet call)', () => {
  it('returns a non-empty list of >=2-word phrase strings given a small seed list', async () => {
    const client = new Anthropic();
    const result = await refineKeyphrases(client, ['trump approval rating']);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const phrase of result) {
      expect(typeof phrase).toBe('string');
      expect(phrase.trim().split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(2);
    }
  }, 30000);

  it('returns a non-empty list when starting from an empty seed list', async () => {
    const client = new Anthropic();
    const result = await refineKeyphrases(client, []);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  }, 30000);
});

describe('refineKeyphrases (failure path)', () => {
  it('rejects when the Anthropic client is misconfigured, so main() would never call saveKeyphrases', async () => {
    const client = new Anthropic({ apiKey: 'sk-ant-invalid-test-key-000000000000000000' });
    await expect(refineKeyphrases(client, ['trump approval rating'])).rejects.toThrow();
  }, 30000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/keyphrases/generate.test.ts`
Expected: FAIL — `src/keyphrases/generate.ts` does not exist yet.

- [ ] **Step 3: Implement `src/keyphrases/generate.ts`**

```typescript
// src/keyphrases/generate.ts
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { loadKeyphrases, saveKeyphrases, DEFAULT_KEYPHRASES_PATH } from './list.js';

const MARKET_CONTEXT = `This keyphrase list is used to scan a live news stream for items relevant to the Kalshi market series KXAPRPOTUS ("President RCP approval rating this week"). Each weekly event in this series resolves based on a SNAPSHOT of the President's approval rating as displayed on RealClearPolitics's approval-rating aggregate page (realclearpolling.com/polls/approval/donald-trump/approval-rating), read at a fixed moment (11:00 AM ET on the resolution date). This is not a subjective judgment of the president's standing -- it is literally whatever number that page shows at that instant.

Because of this, TWO categories of news matter equally (do not rank one above the other):
1. Individual poll publications that would feed directly into that RCP average (e.g. a new Rasmussen, Quinnipiac, Economist/YouGov, Morning Consult, or similar poll on presidential approval being released).
2. General political and economic news that could plausibly shift how people respond to approval polls taken in the following days (e.g. major policy actions, economic data releases, significant scandals or controversies, foreign policy developments).

Every keyphrase must be at least 2 words long -- a single word like "Trump" or "poll" would match nearly every news item and produce useless noise. Prefer specific, multi-word phrases that would plausibly appear verbatim in a real news headline or opening sentence (e.g. "Trump approval rating", "new Rasmussen poll", "job approval numbers"), not generic single concepts.`;

const KeyphraseResponseSchema = z.object({
  keyphrases: z.array(z.string()),
});

export async function refineKeyphrases(
  client: Anthropic,
  currentPhrases: string[]
): Promise<string[]> {
  const response = await client.messages.parse({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${MARKET_CONTEXT}\n\nHere is the current keyphrase list (may be empty on first run):\n${JSON.stringify(currentPhrases, null, 2)}\n\nRevise and extend this list. Keep phrases that are still relevant, remove ones that are stale or too generic, and add new ones you think are missing. Return the complete revised list, not just additions.`,
      },
    ],
    output_config: {
      format: zodOutputFormat(KeyphraseResponseSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error('Sonnet did not return parseable structured output for the keyphrase list');
  }

  return response.parsed_output.keyphrases;
}

// Intended schedule (NOT installed by this slice -- see
// docs/superpowers/specs/2026-08-24-keyphrase-matching-design.md):
//   Daily via cron, e.g.:
//     0 6 * * * cd /path/to/executor_module && npm run generate-keyphrases >> logs/keyphrases.log 2>&1
//   Or an equivalent systemd timer unit calling the same command once a day.
async function main(): Promise<void> {
  const client = new Anthropic();
  const currentPhrases = loadKeyphrases(DEFAULT_KEYPHRASES_PATH);

  let refined: string[];
  try {
    refined = await refineKeyphrases(client, currentPhrases);
  } catch (err) {
    console.error('[generate-keyphrases] failed, leaving existing list untouched:', err);
    process.exit(1);
    return;
  }

  saveKeyphrases(DEFAULT_KEYPHRASES_PATH, refined);
  console.log(`[generate-keyphrases] wrote ${refined.length} phrases to ${DEFAULT_KEYPHRASES_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/keyphrases/generate.test.ts`
Expected: PASS. If the first test fails with an authentication error, confirm `ANTHROPIC_API_KEY` is set in the shell running the tests (direnv-loaded `.envrc` only applies if direnv is hooked into the shell that invoked `npm test` — if it isn't, export the variable manually for this run).

- [ ] **Step 5: Commit**

```bash
git add src/keyphrases/generate.ts test/keyphrases/generate.test.ts
git commit -m "feat: add Sonnet-driven keyphrase list generator"
```

---

### Task 5: Wire keyphrase matching into the consumer

**Files:**
- Modify: `src/main.ts` (currently exports `runOnce(client, opts, onLine, signal)` and `main()` — full rewrite of the per-item handling)
- Modify: `test/main.test.ts` (currently asserts on `onLine`-produced strings — replaced with assertions on the new `onItem` outcome shape)

**Interfaces:**
- Consumes: `createRedisClient` (`src/redis/client.ts`), `StreamConsumer`/`ConsumerOptions`/`StreamEntry` (`src/redis/consumer.ts`), `parseItemFields`/`Item` (`src/item.ts`), `formatSummaryLine` (`src/log.ts`), `compilePhrases`/`findMatches`/`getMatchableText`/`CompiledPhrase` (Task 3), `loadKeyphrases`/`DEFAULT_KEYPHRASES_PATH` (Task 2).
- Produces:
  - `export type ItemOutcome = { ok: true; entry: StreamEntry; item: Item; matchedPhrases: string[] } | { ok: false; entry: StreamEntry; error: string; raw: string }`
  - `export type OnItem = (outcome: ItemOutcome) => void`
  - `export async function runOnce(client: RedisClientType, opts: ConsumerOptions, compiledPhrases: CompiledPhrase[], onItem: OnItem, signal: AbortSignal): Promise<void>`

**Prerequisite:** same local-Redis requirement as slice 1's Redis-dependent tasks.

- [ ] **Step 1: Write failing end-to-end tests**

```typescript
// test/main.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '../src/redis/client.js';
import { runOnce, type ItemOutcome } from '../src/main.js';
import { compilePhrases } from '../src/keyphrases/match.js';
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

async function runOnceForOneEntry(
  client: RedisClientType,
  streamKey: string,
  groupName: string,
  consumerName: string,
  compiledPhrases: ReturnType<typeof compilePhrases>
): Promise<ItemOutcome> {
  const outcomes: ItemOutcome[] = [];
  const controller = new AbortController();

  await runOnce(
    client,
    { streamKey, groupName, consumerName, blockMs: 500, count: 10 },
    compiledPhrases,
    (outcome) => {
      outcomes.push(outcome);
      controller.abort();
    },
    controller.signal
  );

  expect(outcomes).toHaveLength(1);
  return outcomes[0];
}

describe('runOnce with keyphrase matching (end-to-end)', () => {
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

  it('reports a matched phrase found in the headline', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ headline: 'Trump approval rating drops sharply' })),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-1',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual(['trump approval rating']);
    }
  });

  it('reports no matched phrases when none appear', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(realisticPayload({ headline: 'Local weather stays mild this week' })),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-2',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual([]);
    }
  });

  it('matches against snippet only for a synthetic-headline item', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          headline: 'ofac_recent_actions: watched page region changed',
          snippet: 'New sanctions announced amid trump approval rating criticism',
          provenance_gaps: ['synthetic_headline'],
        })
      ),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-3',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual(['trump approval rating']);
    }
  });

  it('does not match a phrase that appears only in a synthetic item\'s templated headline', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          headline: 'special approval board: watched page region changed',
          snippet: 'Unrelated content with no keyphrase here',
          provenance_gaps: ['synthetic_headline'],
        })
      ),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-4',
      compilePhrases(['special approval board'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases).toEqual([]);
    }
  });

  it('reports multiple matched phrases together', async () => {
    await client.xAdd(streamKey, '*', {
      json: JSON.stringify(
        realisticPayload({
          headline: 'Trump approval rating steady',
          snippet: 'A new Rasmussen poll was released today',
        })
      ),
    });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-5',
      compilePhrases(['trump approval rating', 'new rasmussen poll'])
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.matchedPhrases.sort()).toEqual(
        ['new rasmussen poll', 'trump approval rating'].sort()
      );
    }
  });

  it('still reports a parse error for malformed JSON, unaffected by keyphrase matching', async () => {
    await client.xAdd(streamKey, '*', { json: '{not valid json' });

    const outcome = await runOnceForOneEntry(
      client,
      streamKey,
      groupName,
      'consumer-6',
      compilePhrases(['trump approval rating'])
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).not.toContain('\n');
      expect(outcome.raw).not.toContain('\n');
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL — `runOnce`'s current signature (`onLine: (line: string) => void`, no `compiledPhrases` parameter) doesn't match; `ItemOutcome` doesn't exist yet.

- [ ] **Step 3: Rewrite `src/main.ts`**

```typescript
// src/main.ts
import type { RedisClientType } from 'redis';
import { createRedisClient } from './redis/client.js';
import { StreamConsumer, type ConsumerOptions, type StreamEntry } from './redis/consumer.js';
import { parseItemFields, type Item } from './item.js';
import { formatSummaryLine } from './log.js';
import { compilePhrases, findMatches, getMatchableText, type CompiledPhrase } from './keyphrases/match.js';
import { loadKeyphrases, DEFAULT_KEYPHRASES_PATH } from './keyphrases/list.js';

const STREAM_KEY = 'iip:items';
const GROUP_NAME = 'execmod';
const CONSUMER_NAME = process.env.EXECMOD_CONSUMER_NAME ?? 'execmod-primary';

/** How much of an unparseable payload the error line carries before it is cut off. */
const RAW_PREVIEW_LIMIT = 500;

/**
 * Renders a failed payload for a ONE-LINE log entry: newlines and other control
 * characters flattened to spaces, and cut to `RAW_PREVIEW_LIMIT` with an explicit
 * marker so a truncated payload can never be mistaken for a complete one.
 */
export function truncateRaw(raw: string, limit: number = RAW_PREVIEW_LIMIT): string {
  const flattened = raw.replace(/[\r\n\t]+/g, ' ');
  return flattened.length > limit
    ? `${flattened.slice(0, limit)}...(truncated)`
    : flattened;
}

export type ItemOutcome =
  | { ok: true; entry: StreamEntry; item: Item; matchedPhrases: string[] }
  | { ok: false; entry: StreamEntry; error: string; raw: string };

export type OnItem = (outcome: ItemOutcome) => void;

export async function runOnce(
  client: RedisClientType,
  opts: ConsumerOptions,
  compiledPhrases: CompiledPhrase[],
  onItem: OnItem,
  signal: AbortSignal
): Promise<void> {
  const consumer = new StreamConsumer(client, opts);

  await consumer.run(async (entry) => {
    const result = parseItemFields(entry.fields);
    if (!result.ok) {
      onItem({ ok: false, entry, error: result.error, raw: truncateRaw(result.raw) });
      return;
    }
    const matchableText = getMatchableText(result.item);
    const matchedPhrases = findMatches(matchableText, compiledPhrases);
    onItem({ ok: true, entry, item: result.item, matchedPhrases });
  }, signal);
}

export async function main(): Promise<void> {
  const keyphrases = loadKeyphrases(DEFAULT_KEYPHRASES_PATH);
  const compiledPhrases = compilePhrases(keyphrases);

  const client = createRedisClient();
  await client.connect();

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  await runOnce(
    client,
    { streamKey: STREAM_KEY, groupName: GROUP_NAME, consumerName: CONSUMER_NAME },
    compiledPhrases,
    (outcome) => {
      if (!outcome.ok) {
        console.error(`[parse-error] entry=${outcome.entry.id} error=${outcome.error} raw=${outcome.raw}`);
        return;
      }
      console.log(formatSummaryLine(outcome.item));
      if (outcome.matchedPhrases.length > 0) {
        console.log(
          `[KEYPHRASE-MATCH] item=${outcome.item.item_id} phrases=${JSON.stringify(outcome.matchedPhrases)} headline=${outcome.item.headline}`
        );
      }
    },
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
Expected: PASS, all cases.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: everything passes (all tasks' tests together, including the generator's real API call from Task 4).

- [ ] **Step 6: Manual smoke check (optional, requires a running Redis with keyphrases loaded and, ideally, `iip` actually publishing)**

Run: `npm run dev`
Expected: if `iip` is running and publishing to `iip:items`, summary lines print as before; any item whose text contains a phrase from `data/keyphrases.json` additionally prints a `[KEYPHRASE-MATCH]` line. Stop with Ctrl-C and confirm it exits cleanly. Skip this step if `iip` isn't running locally — it's optional, not a pass/fail gate.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts test/main.test.ts
git commit -m "feat: wire keyphrase matching into the consumer via an item-level handler"
```

---

## Self-Review Notes

- **Spec coverage:** market-context-aware generator with structured output (Task 4), 2-word minimum enforcement (Task 2), fail-loud malformed-list handling (Task 2), deterministic word-boundary matcher (Task 3), synthetic-headline snippet-only exception (Task 3 + Task 5's tests), one-log-line-per-item multi-match reporting (Task 5), real-API-call generator tests (Task 4), real-Redis end-to-end matching tests (Task 5), `.envrc` hygiene (Task 1) are each covered by a task.
- **Placeholder scan:** none found — every step has runnable code or an exact command.
- **Type consistency:** `Item`, `CompiledPhrase`, `ItemOutcome`, `OnItem`, `ConsumerOptions`, `StreamEntry` are used identically across Tasks 2, 3, 4, and 5, matching the actual current definitions in `src/item.ts` and `src/redis/consumer.ts` (verified by reading both files before writing this plan, since slice 1's final-review fix wave changed several signatures after its own plan was written).
