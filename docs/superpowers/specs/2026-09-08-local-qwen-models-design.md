# Local Qwen Models for Synopsis/Verify — Design

## Goal

Every real decision run makes three Anthropic API calls: Haiku synopsis, Sonnet
verify, Sonnet decide. This slice replaces the first two with local models served
by Ollama on `mini-mac`, eliminating the large majority of this system's API token
usage (synopsis fires on every keyphrase match; verify only on the ones that pass;
decide — the rarest and highest-stakes call — is gated behind both and stays on the
real API). This is a direct response to a live incident: the shared Anthropic
account's credit balance was exhausted, discovered when a routine local test run
hit `"Your credit balance is too low to access the Anthropic API"` on the same key
`mini-mac`'s live deployment uses.

## Decisions made during brainstorming

1. **Hybrid, not a full local swap.** A dedicated research pass (given
   `mini-mac`'s exact hardware: 4 CPU cores, ~10-11 GiB usable RAM after `iip` and
   `executor_module`'s own overhead, no GPU) found no model that both fits this
   hardware and is trustworthy enough for the trade-DECISION call specifically: the
   realistic ceiling is the same 7-8B tier synopsis/verify already use, far below
   Sonnet's reasoning quality, and reaching further (14B) costs an estimated
   1-3+ minutes per call on 4 CPU cores alone — on this project's own prior
   sibling-repo research, by 60 seconds most positions no longer clear a
   profitability floor. Running `decide` locally here would mean a simultaneous
   quality AND latency regression on the single highest-stakes call in the
   pipeline. `decide.ts` is explicitly out of scope for this slice and stays on
   the real Anthropic API.
2. **Models: `qwen2.5:3b-instruct-q4_K_M` for synopsis, `qwen2.5:7b-instruct-q4_K_M`
   for verify.** Confirmed working empirically against a real local Ollama
   instance before writing this spec (not just researched) — the 3B model
   produces a coherent free-text summary, and the 7B model, given Ollama's
   JSON-schema `format` option, correctly returned `supported: false` on a
   deliberately fabricated synopsis, matching `verify.ts`'s existing
   `VERIFY_SCHEMA` contract exactly. Both comfortably fit alongside `iip.service`
   and `executor-module.service`'s existing memory footprint on `mini-mac`.
3. **A thin, generic Ollama HTTP client, not two bespoke ones.** `synopsize` and
   `verifySynopsis` already hardcode their own model name internally today
   (`'claude-haiku-4-5'`, `'claude-sonnet-5'`) — the new versions keep that exact
   pattern, hardcoding their own Ollama model tag internally, and both call
   through one shared, model-agnostic client (`src/decide/ollamaClient.ts`)
   rather than each rolling its own HTTP call.
4. **Test posture: install Ollama + both models on every machine that runs this
   test suite, matching this project's own established law.** Every other LLM
   call in this codebase is tested against the real API, not a mock, specifically
   because a mock can't catch a real prompt/schema regression. The same standard
   applies here: `synopsis.test.ts`/`verify.test.ts` keep hitting a real running
   Ollama instance (now local instead of Anthropic's API), not a mocked HTTP
   response. This is a real new environmental dependency (~5GB of model weights)
   for wherever this code is tested — an explicit, considered trade-off, not an
   oversight.
5. **`decide`'s own tests, and `pipeline.test.ts`'s mocked
   `synopsize`/`verifySynopsis` spies, are unaffected.** `pipeline.test.ts`
   already mocks both functions at the module level (`vi.spyOn`) rather than
   exercising a real client — those tests only need a placeholder `ollamaClient`
   value threaded into the deps object, never actually invoked.

## Architecture

**New file:**
- `src/decide/ollamaClient.ts` — exports an `OllamaClient` interface (one method,
  `chat(model: string, prompt: string, options?: { format?: object }): Promise<string>`)
  and a `createOllamaClient(baseUrl?: string): OllamaClient` factory.
  `baseUrl` defaults to `process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'`
  — configurable but always localhost in practice, since `executor_module` runs
  colocated with its own Ollama instance on both `mini-mac` and this dev machine.
  `chat()` POSTs to `${baseUrl}/api/chat` with `{model, messages: [{role: 'user',
  content: prompt}], stream: false, ...(options?.format ? {format: options.format}
  : {})}`, throws loudly (naming the model and HTTP status) on a non-OK response
  or a missing `message.content` field — matching this codebase's existing
  "never fabricate a value you didn't verify" law.

**Changed files:**
- `src/decide/synopsis.ts` — `synopsize`'s first parameter changes from
  `Anthropic` to `OllamaClient`. Internally calls
  `client.chat('qwen2.5:3b-instruct-q4_K_M', <same prompt text as today>)`, no
  `format` option (free text). Same trim/empty-string guard as today.
- `src/decide/verify.ts` — `verifySynopsis`'s first parameter changes from
  `Anthropic` to `OllamaClient`. Internally calls
  `client.chat('qwen2.5:7b-instruct-q4_K_M', <same prompt text as today>, {
  format: VERIFY_SCHEMA })`, then `JSON.parse`s the returned string and passes
  it through the EXISTING, unchanged `validateVerifyOutput` — that function's own
  defense-in-depth (throwing on a missing/wrong-typed field) is model-agnostic
  and needs no changes.
- `src/decide/pipeline.ts` — `PipelineDeps` gains `ollamaClient: OllamaClient`.
  The two call sites (`synopsize(anthropicClient, ...)`,
  `verifySynopsis(anthropicClient, ...)`) change to pass `ollamaClient` instead.
  The `decideTrade(anthropicClient, ...)` call site is UNCHANGED.
- `src/main.ts` — constructs `const ollamaClient = createOllamaClient();`
  alongside the existing `const anthropicClient = new Anthropic();`, passes both
  into `makeOnItem`.

## Data flow

```
runDecisionPipeline (per item):
  synopsis = await synopsize(ollamaClient, headline, snippet)
    -> POST http://127.0.0.1:11434/api/chat, model=qwen2.5:3b-instruct-q4_K_M
  verification = await verifySynopsis(ollamaClient, headline, snippet, synopsis)
    -> POST http://127.0.0.1:11434/api/chat, model=qwen2.5:7b-instruct-q4_K_M,
       format=VERIFY_SCHEMA
  ... unchanged: hasOpenPosition / rate limit / evaluateSizing checks ...
  decision = await decideTrade(anthropicClient, headline, snippet, synopsis, rung)
    -> UNCHANGED: real Anthropic Sonnet call, exactly as today
```

## Testing plan

Matching this project's standing law — every value that travels through this
system needs a test driving the real call site, not just the function in
isolation:

- `synopsis.test.ts`'s two existing tests keep their exact assertions, only
  swapping `new Anthropic()` for `createOllamaClient()` — both must still produce
  a non-empty summary, one from headline+snippet, one from headline alone.
- `verify.test.ts`'s two existing "real call" tests keep their exact assertions
  (a faithful synopsis returns `supported: true`; a fabricated one returns
  `supported: false`) against the real local Ollama instance instead of Sonnet.
  `validateVerifyOutput`'s own unit tests are already model-agnostic and need no
  changes.
- New: a test confirming `ollamaClient.ts`'s error path — a request to a model
  name that doesn't exist, or a deliberately wrong `baseUrl`, throws loudly
  naming the failure, never returns a fabricated empty/default value.
- `pipeline.test.ts`: every existing call to `runDecisionPipeline`'s deps object
  gains a placeholder `ollamaClient` (e.g. `createOllamaClient()` or a trivial
  stub) alongside the existing `anthropicClient` — since `synopsize`/
  `verifySynopsis` are mocked at the module level in every pipeline test, this
  value is threaded through but never actually invoked.
- No new test needed for `decide.ts` — entirely unchanged.

## Deployment

- Ollama installed on `mini-mac` via its standard installer
  (`curl -fsSL https://ollama.com/install.sh | sh`), which sets up its own
  system-level `ollama.service` (not a user unit, matching the installer's own
  default rather than fighting it) listening on `127.0.0.1:11434`.
- Both models pulled on `mini-mac` (`ollama pull qwen2.5:3b-instruct-q4_K_M`,
  `ollama pull qwen2.5:7b-instruct-q4_K_M`) before `executor-module.service` is
  restarted onto this code.
- `executor-module.service`'s `After=` line gains `ollama.service` (matching the
  existing pattern of listing `redis-server.service`/`iip.service`).
- No new secret: `OLLAMA_BASE_URL` is not set in `.env` (the default is correct
  for this colocated deployment) — only mentioned here for completeness.

## Credential hygiene / non-negotiables reaffirmed

- No new credential is introduced — Ollama's local HTTP API is unauthenticated
  by design (bound to `127.0.0.1` only, matching every other localhost-only
  service on this box).
- `decide.ts`'s Anthropic API key usage is completely unchanged — this slice
  does not touch credential handling for the one Anthropic call that remains.
- No market-specific logic is introduced or touched — this is a pure
  infrastructure/provider swap behind two existing, already-tested function
  signatures.
