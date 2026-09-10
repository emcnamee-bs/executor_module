# Local Qwen Models (Synopsis + Verify) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Anthropic API calls in `synopsize`/`verifySynopsis` with a
local Ollama-served Qwen model, leaving `decideTrade` untouched on the real API.

**Architecture:** One new generic `OllamaClient` HTTP wrapper
(`src/decide/ollamaClient.ts`); `synopsis.ts`/`verify.ts` swap their client
parameter type and hardcode their own Ollama model tag internally, exactly
matching how they already hardcode their own Anthropic model name today;
`pipeline.ts`/`main.ts` thread a second `ollamaClient` dependency alongside the
existing `anthropicClient`.

**Tech Stack:** TypeScript, native `fetch` (no new dependency — Ollama's HTTP API
needs nothing beyond what's already used for the Kalshi client), vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-local-qwen-models-design.md`

## Global Constraints

- `decide.ts` and every one of its existing tests are OUT OF SCOPE — do not
  touch them.
- `synopsize`/`verifySynopsis`'s exported function signatures keep the same
  argument COUNT and ORDER as today, only the first parameter's TYPE changes
  (`Anthropic` -> `OllamaClient`). Every other parameter and the return type are
  unchanged.
- Models: `qwen2.5:3b-instruct-q4_K_M` (synopsis), `qwen2.5:7b-instruct-q4_K_M`
  (verify) — exact tags, verbatim, both already confirmed pulled and working on
  this dev machine.
- `OllamaClient.chat()` throws loudly (naming the model and HTTP status/body) on
  any non-OK response or a missing `message.content` field in the response body
  — never returns an empty string or fabricated default.
- Every test that currently exercises a real Anthropic call in
  `synopsis.test.ts`/`verify.test.ts` must keep exercising a REAL local Ollama
  call after this change (per this project's "test the real call site" law) —
  never replaced with a mocked HTTP response.
- `pipeline.test.ts` mocks `synopsize`/`verifySynopsis` at the module level
  already (`vi.spyOn`) — do not change that; just thread a placeholder
  `ollamaClient` value through every `runDecisionPipeline` deps object so the
  code compiles.

---

### Task 1: `OllamaClient` — the shared HTTP wrapper

**Files:**
- Create: `src/decide/ollamaClient.ts`
- Test: `test/decide/ollamaClient.test.ts`

**Interfaces:**
- Produces: `export interface OllamaClient { chat(model: string, prompt: string, options?: { format?: object }): Promise<string>; }`
  and `export function createOllamaClient(baseUrl?: string): OllamaClient`.
  Later tasks import both by these exact names from `./ollamaClient.js`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/decide/ollamaClient.test.ts
import { describe, it, expect } from 'vitest';
import { createOllamaClient } from '../../src/decide/ollamaClient.js';

describe('createOllamaClient (real local Ollama call)', () => {
  it('returns the model\'s text content for a plain prompt', async () => {
    const client = createOllamaClient();
    const content = await client.chat(
      'qwen2.5:3b-instruct-q4_K_M',
      'Reply with exactly the word: PONG'
    );
    expect(typeof content).toBe('string');
    expect(content.trim().length).toBeGreaterThan(0);
  }, 30000);

  it('honors a JSON format constraint and returns parseable JSON text', async () => {
    const client = createOllamaClient();
    const content = await client.chat(
      'qwen2.5:7b-instruct-q4_K_M',
      'Return a JSON object describing whether 2+2=4 is true, with a boolean field "correct" and a string field "note".',
      {
        format: {
          type: 'object',
          properties: { correct: { type: 'boolean' }, note: { type: 'string' } },
          required: ['correct', 'note'],
          additionalProperties: false,
        },
      }
    );
    const parsed = JSON.parse(content);
    expect(typeof parsed.correct).toBe('boolean');
    expect(typeof parsed.note).toBe('string');
  }, 30000);

  it('throws loudly, naming the model, when the model does not exist', async () => {
    const client = createOllamaClient();
    await expect(
      client.chat('this-model-definitely-does-not-exist:latest', 'hello')
    ).rejects.toThrow(/this-model-definitely-does-not-exist/);
  }, 30000);

  it('throws loudly when the base URL is unreachable', async () => {
    const client = createOllamaClient('http://127.0.0.1:1');
    await expect(client.chat('qwen2.5:3b-instruct-q4_K_M', 'hello')).rejects.toThrow();
  }, 10000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/ollamaClient.test.ts`
Expected: FAIL with "Cannot find module '../../src/decide/ollamaClient.js'" (the
file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// src/decide/ollamaClient.ts
export interface OllamaClient {
  chat(model: string, prompt: string, options?: { format?: object }): Promise<string>;
}

export function createOllamaClient(
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
): OllamaClient {
  return {
    async chat(model, prompt, options) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            ...(options?.format ? { format: options.format } : {}),
          }),
        });
      } catch (err) {
        throw new Error(
          `Ollama request to ${baseUrl} for model ${model} failed to connect: ${(err as Error).message}`
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama request for model ${model} failed: ${res.status} ${body}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      if (typeof data.message?.content !== 'string') {
        throw new Error(
          `Ollama returned no message content for model ${model}: ${JSON.stringify(data)}`
        );
      }
      return data.message.content;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/ollamaClient.test.ts`
Expected: PASS (all 4 tests) — requires a real local Ollama running with
`qwen2.5:3b-instruct-q4_K_M` and `qwen2.5:7b-instruct-q4_K_M` already pulled
(`ollama pull <tag>` if not).

- [ ] **Step 5: Typecheck**

Run: `direnv exec . npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/decide/ollamaClient.ts test/decide/ollamaClient.test.ts
git commit -m "feat: add OllamaClient, a thin wrapper for local model calls"
```

---

### Task 2: Swap `synopsize` onto `OllamaClient`

**Files:**
- Modify: `src/decide/synopsis.ts`
- Modify: `test/decide/synopsis.test.ts`

**Interfaces:**
- Consumes: `OllamaClient`, `createOllamaClient` from `./ollamaClient.js` (Task 1).
- Produces: `synopsize(client: OllamaClient, headline: string, snippet: string | null): Promise<string>` — same name, same argument count/order, same return type as today; only the first parameter's TYPE changes.

- [ ] **Step 1: Update the test file to use the real local model**

Replace the full content of `test/decide/synopsis.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createOllamaClient } from '../../src/decide/ollamaClient.js';
import { synopsize } from '../../src/decide/synopsis.js';

describe('synopsize (real local Qwen call)', () => {
  it('produces a non-empty summary of a headline and snippet', async () => {
    const client = createOllamaClient();
    const summary = await synopsize(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced today that the national unemployment rate declined to 3.9%, beating economist expectations of 4.1%, driven by strong hiring in the services sector.'
    );

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
    expect(summary.toLowerCase()).toMatch(/unemploy|labor|job/);
  }, 30000);

  it('produces a summary from headline alone when snippet is null', async () => {
    const client = createOllamaClient();
    const summary = await synopsize(client, 'State Department announces new sanctions on shipping firms', null);

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `direnv exec . npx vitest run test/decide/synopsis.test.ts`
Expected: FAIL (type error / `synopsize` still expects `Anthropic`, not
`OllamaClient` — the old implementation hasn't changed yet).

- [ ] **Step 3: Update the implementation**

Replace the full content of `src/decide/synopsis.ts`:

```typescript
import type { OllamaClient } from './ollamaClient.js';

export async function synopsize(
  client: OllamaClient,
  headline: string,
  snippet: string | null
): Promise<string> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const content = await client.chat(
    'qwen2.5:3b-instruct-q4_K_M',
    `Summarize what this news item is actually about, in 2-3 plain sentences. Do not speculate beyond what the text says, and do not add commentary about its significance.\n\n${sourceText}`
  );

  const summary = content.trim();
  if (summary.length === 0) {
    throw new Error('Local model returned an empty synopsis');
  }
  return summary;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `direnv exec . npx vitest run test/decide/synopsis.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck**

Run: `direnv exec . npm run typecheck`
Expected: clean (this will surface every OTHER call site that still passes an
`Anthropic` client into `synopsize` — that's `pipeline.ts`, fixed in Task 4;
confirm the only errors reported are in `pipeline.ts`/`main.ts`/
`pipeline.test.ts`, not anywhere unexpected).

- [ ] **Step 6: Commit**

```bash
git add src/decide/synopsis.ts test/decide/synopsis.test.ts
git commit -m "feat: run synopsize on a local Qwen model instead of Haiku"
```

---

### Task 3: Swap `verifySynopsis` onto `OllamaClient`

**Files:**
- Modify: `src/decide/verify.ts`
- Modify: `test/decide/verify.test.ts`

**Interfaces:**
- Consumes: `OllamaClient`, `createOllamaClient` from `./ollamaClient.js` (Task 1).
- Produces: `verifySynopsis(client: OllamaClient, headline: string, snippet: string | null, synopsis: string): Promise<VerifyResult>` — same name, same argument count/order, same return type as today; only the first parameter's TYPE changes. `VerifyResult` and `validateVerifyOutput` are UNCHANGED — do not touch them.

- [ ] **Step 1: Update the test file's real-call tests to use the real local model**

In `test/decide/verify.test.ts`, replace ONLY the import lines and the
`describe('verifySynopsis (real Sonnet call)', ...)` block (leave the
`describe('validateVerifyOutput', ...)` block completely untouched):

```typescript
import { describe, it, expect } from 'vitest';
import { createOllamaClient } from '../../src/decide/ollamaClient.js';
import { verifySynopsis, validateVerifyOutput } from '../../src/decide/verify.js';

describe('verifySynopsis (real local Qwen call)', () => {
  it('supports a faithful synopsis of the source text', async () => {
    const client = createOllamaClient();
    const result = await verifySynopsis(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July, beating expectations.',
      'The unemployment rate dropped to 3.9% in July, according to new BLS data, coming in better than economists expected.'
    );

    expect(result.supported).toBe(true);
    expect(typeof result.note).toBe('string');
  }, 30000);

  it('rejects a synopsis that fabricates a claim the source does not make', async () => {
    const client = createOllamaClient();
    const result = await verifySynopsis(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July.',
      'The President announced a major new stimulus package to combat unemployment, sources say.'
    );

    expect(result.supported).toBe(false);
  }, 30000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `direnv exec . npx vitest run test/decide/verify.test.ts`
Expected: FAIL (type error — `verifySynopsis` still expects `Anthropic`).

- [ ] **Step 3: Update the implementation**

Replace the full content of `src/decide/verify.ts`:

```typescript
import type { OllamaClient } from './ollamaClient.js';

export interface VerifyResult {
  supported: boolean;
  note: string;
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['supported', 'note'],
  additionalProperties: false,
};

export function validateVerifyOutput(parsed: unknown): VerifyResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Local model returned an invalid verify output shape: ${JSON.stringify(parsed)}`);
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.supported !== 'boolean') {
    throw new Error(`Local model returned an invalid "supported" field: ${JSON.stringify(p.supported)}`);
  }
  if (typeof p.note !== 'string') {
    throw new Error(`Local model returned an invalid "note" field: ${JSON.stringify(p.note)}`);
  }
  return { supported: p.supported, note: p.note };
}

export async function verifySynopsis(
  client: OllamaClient,
  headline: string,
  snippet: string | null,
  synopsis: string
): Promise<VerifyResult> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const content = await client.chat(
    'qwen2.5:7b-instruct-q4_K_M',
    `Source text:\n${sourceText}\n\nProposed synopsis:\n${synopsis}\n\nDoes this synopsis accurately represent what the source text actually says, without adding claims the source does not make? Answer supported=true only if the synopsis is a faithful, non-exaggerated summary of the source text. Explain your answer briefly in "note".`,
    { format: VERIFY_SCHEMA }
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Local model did not return parseable JSON for verification: ${content}`);
  }

  return validateVerifyOutput(parsed);
}
```

Note: the error message text inside `validateVerifyOutput` changes from
"Sonnet returned..." to "Local model returned..." — check
`test/decide/verify.test.ts`'s `describe('validateVerifyOutput', ...)` block's
`it.each` assertions do NOT match on the word "Sonnet" specifically (they match
on `/invalid verify output shape/`, `/invalid "supported" field/`, `/invalid
"note" field/` — none reference "Sonnet", so no test changes needed there, but
CONFIRM this by reading the actual current regexes before assuming).

- [ ] **Step 4: Run the test to verify it passes**

Run: `direnv exec . npx vitest run test/decide/verify.test.ts`
Expected: PASS (all tests, including the untouched `validateVerifyOutput` block).

- [ ] **Step 5: Typecheck**

Run: `direnv exec . npm run typecheck`
Expected: clean except for `pipeline.ts`/`main.ts`/`pipeline.test.ts` (fixed in
Task 4).

- [ ] **Step 6: Commit**

```bash
git add src/decide/verify.ts test/decide/verify.test.ts
git commit -m "feat: run verifySynopsis on a local Qwen model instead of Sonnet"
```

---

### Task 4: Wire `ollamaClient` through `pipeline.ts`/`main.ts`, update `pipeline.test.ts`

**Files:**
- Modify: `src/decide/pipeline.ts`
- Modify: `src/main.ts`
- Modify: `test/decide/pipeline.test.ts`
- Modify: `test/main.test.ts` (if it constructs a `PipelineDeps`/deps object directly — check first)

**Interfaces:**
- Consumes: `OllamaClient`, `createOllamaClient` from `./ollamaClient.js` (Task 1); the updated `synopsize`/`verifySynopsis` signatures (Tasks 2-3).
- Produces: `PipelineDeps` gains `ollamaClient: OllamaClient`; `runDecisionPipeline` and `makeOnItem` thread it through unchanged otherwise.

- [ ] **Step 1: Update `src/decide/pipeline.ts`**

Find the `PipelineDeps` interface (or equivalent deps type) and add
`ollamaClient: OllamaClient;` alongside the existing `anthropicClient:
Anthropic;` field. Add `import type { OllamaClient } from './ollamaClient.js';`
near the existing `Anthropic` import.

Find the destructuring line (currently `const { anthropicClient, db,
fetchLadder, kalshiClient } = deps;`) and add `ollamaClient` to it.

Change the two call sites:
```typescript
const synopsis = await synopsize(ollamaClient, item.headline, item.snippet);
const verification = await verifySynopsis(ollamaClient, item.headline, item.snippet, synopsis);
```
Leave `const decision = await decideTrade(anthropicClient, ...)` UNCHANGED.

- [ ] **Step 2: Update `src/main.ts`**

Add `import { createOllamaClient } from './decide/ollamaClient.js';` near the
existing `Anthropic` import. Add `const ollamaClient =
createOllamaClient();` right after the existing `const anthropicClient = new
Anthropic();` line. Add `ollamaClient` to the object passed into
`makeOnItem({ anthropicClient, ollamaClient, db, fetchLadder:
fetchActiveLadder, kalshiClient })`. If `main.ts`'s own deps interface (the one
`anthropicClient: Anthropic;` appears in near line 85) is separate from
`pipeline.ts`'s `PipelineDeps`, add `ollamaClient: OllamaClient;` there too.

- [ ] **Step 3: Update `test/decide/pipeline.test.ts`**

Add `import { createOllamaClient } from '../../src/decide/ollamaClient.js';`
near the top. Find every place a deps object is built for a
`runDecisionPipeline(...)` call (search for `anthropicClient` in this file —
there will be several, likely inside a shared helper or repeated per-test) and
add `ollamaClient: createOllamaClient()` alongside the existing
`anthropicClient`. Since `synopsize`/`verifySynopsis` are already mocked at the
module level in this file (`vi.spyOn(synopsisModule, 'synopsize')...`), this
value is threaded through but never actually invoked — it only needs to exist
so the code compiles and the deps object shape matches `PipelineDeps`.

- [ ] **Step 4: Check `test/main.test.ts`**

Read the file first. If it constructs a deps/`PipelineDeps`-shaped object
directly (rather than going through `makeOnItem`'s own real construction), add
`ollamaClient: createOllamaClient()` there too, same reasoning as Step 3. If it
doesn't touch this shape at all, no change needed — note which case it was in
the task report.

- [ ] **Step 5: Typecheck**

Run: `direnv exec . npm run typecheck`
Expected: clean, zero errors anywhere in the project.

- [ ] **Step 6: Run the full test suite**

Run: `direnv exec . npm test`
Expected: all tests pass, including the real-local-Ollama tests from Tasks 1-3
and every existing pipeline/main test (which mock the model calls and don't
need Ollama running to pass, but DO need `ANTHROPIC_API_KEY` set for
`decide.ts`'s own real-call tests, unrelated to this change).

- [ ] **Step 7: Commit**

```bash
git add src/decide/pipeline.ts src/main.ts test/decide/pipeline.test.ts test/main.test.ts
git commit -m "feat: wire ollamaClient through the pipeline; decideTrade stays on Anthropic"
```

## Deployment (not a task — controller does this directly after the branch is reviewed and merged)

1. On `mini-mac`: install Ollama (`curl -fsSL https://ollama.com/install.sh | sh`),
   `ollama pull qwen2.5:3b-instruct-q4_K_M`, `ollama pull qwen2.5:7b-instruct-q4_K_M`.
2. Add `ollama.service` to `deploy/mini-mac/executor-module.service`'s `After=`
   line (a small doc/config update, not part of this plan's tasks — the
   controller edits this directly since it's a one-line change to a file
   already fully understood).
3. Deploy the merged code to `mini-mac` (git pull), restart
   `executor-module.service`, confirm clean startup via journal.
