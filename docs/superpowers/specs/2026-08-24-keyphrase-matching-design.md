# Design: Keyphrase Matching (Slice 2 of executor_module)

**Status:** Approved for planning
**Date:** 2026-08-24

## Context

`executor_module`'s full pipeline (`HANDOFF.md` §0) is: news scan → keyphrase match →
Haiku synopsis → Sonnet verify → Sonnet decides → real order execution. Slice 1
(`2026-08-24-redis-consumer-design.md`) built the first stage's plumbing: a Redis
consumer that reads `iip:items`, validates each entry, and logs a one-line summary.
Nothing in slice 1 inspects an item's content — it only proves the item arrived intact.

This spec covers **slice 2**: the keyphrase-matching stage. It bundles two pieces that
HANDOFF.md's own description ties together — "a curated list of AI-generated
keyphrases" (the list itself is AI-generated/refined) and "matched against an article's
title and first paragraph" (the runtime check) — built together in this slice rather
than split further, per the operator's choice during brainstorming.

**Out of scope for this slice:** the Haiku synopsis dispatch, the Sonnet verify/decide
steps, and anything Kalshi-execution-related. A match is detected and logged — nothing
downstream acts on it yet. That mirrors slice 1's own incremental-slice discipline: prove
the mechanism, then add the next cost/complexity layer as its own slice.

## Confirmed market mechanics (per HANDOFF.md §3 step 1's non-negotiable)

Pulled directly from Kalshi's public API (`api.elections.kalshi.com`, no credentials
needed for market/series/event metadata) during brainstorming, since HANDOFF.md requires
confirming real resolution mechanics before designing signal logic:

- **Series `KXAPRPOTUS`** ("President RCP approval rating this week"), **weekly
  frequency**. Each weekly event (e.g. `KXAPRPOTUS-26AUG28`) is a **ladder of narrow
  percentage-band markets** (e.g. "below 38.8", "38.8 to 39.0", ...), not a single
  yes/no market.
- **Settlement source:** RealClearPolitics's Trump approval-rating aggregate page
  (`realclearpolling.com/polls/approval/donald-trump/approval-rating`). Resolution is a
  **snapshot read of that page's displayed number at a fixed moment** (11:00 AM ET on
  the strike date per the sampled event's `rules_primary` text) — not a subjective
  "did the president's standing improve" judgment.
- The RCP page itself is Cloudflare-protected; its live per-poll methodology (exactly
  which pollsters currently feed the average) could not be fetched programmatically
  during this brainstorm. That's a known gap, not something silently assumed away.
- **Implication for keyphrase design, decided with the operator:** because resolution is
  a snapshot of a third-party aggregate, the most direct signal is a **new poll
  publication** (by name — Rasmussen, Quinnipiac, etc. — these tend to run on
  predictable per-pollster cadences). The operator chose to weight **general
  political/economic news phrases equally** with poll-publication phrases rather than
  tiering them — both categories go into the same untiered list.

## Decisions carried in from brainstorming

- **Match mechanism:** deterministic text matching only — no LLM/embedding call per
  item. The "AI" in this pipeline stage is that the *phrase list* is LLM-generated/
  refined; matching it at runtime is a fast, free lookup, keeping model calls for the
  Haiku/Sonnet stages that only run on an actual match.
- **Match fields:** `headline` + `snippet`. `body` is excluded — `body_state` is usually
  `absent` at match time (fetched on demand, not guaranteed present), so gating on it
  would miss or delay most matches.
- **Synthetic-headline items** (`provenance_gaps` contains `synthetic_headline` —
  produced by `Internet_Info_Plug`'s `PrimaryAdapter`, which watches a page region with
  no article/headline concept and fills `headline` with a fixed, content-free template
  like `"{source_id}: watched page region changed"` because `Item.headline` cannot be
  blank): **match against `snippet` only**, excluding the templated headline text from
  the match input.
- **Match semantics:** contiguous phrase match, case-insensitive, word-boundary aware
  (e.g. `"trump approval rating"` matches that exact word sequence, not `"trump approval
  ratings"` or a substring inside a longer word) — not an order-independent
  all-words-present check.
- **Keyphrase list format:** flat JSON array of strings, git-tracked at
  `data/keyphrases.json`, starting as `[]`. No per-phrase metadata, no tiering, no size
  cap — the refine prompt sees the whole current list each run and can already choose to
  prune stale entries; a hard cap is deferred until the list is observed to actually grow
  unmanageably.
- **Minimum phrase length:** at least 2 words, enforced both in the generator's prompt
  instructions and as a load-time validation in the matcher (a too-short entry logs a
  warning and is skipped, not a hard crash — this file is operator/LLM-editable data, not
  code). Rationale: a single word like `"Trump"` or `"poll"` would match nearly every
  item, flooding the pipeline with noise.
- **Generator model:** `claude-sonnet-5` via `@anthropic-ai/sdk`, using structured output
  (`output_config.format` → `{"keyphrases": string[]}`) rather than free-text parsing, so
  the response is guaranteed parseable.
- **Generator context:** a **static, hardcoded** description of the market's resolution
  mechanics (the confirmed facts above), not a live Kalshi API call each run — the
  mechanism is structural and unlikely to change week to week; a new Kalshi dependency
  isn't worth adding just for phrase generation.
- **Refine, not replace:** each run passes the current `data/keyphrases.json` content to
  Sonnet and asks it to revise/extend, per HANDOFF.md's own description ("an LLM
  proposes/refines phrases") — avoids losing good phrases to day-to-day LLM output
  variance.
- **Generator failure handling:** on any failure (API error, malformed structured
  output), leave `data/keyphrases.json` untouched and exit non-zero. No custom retry
  loop — rely on the SDK's own default retry behavior for transient errors.
- **Scheduling:** a daily cadence, via an OS-level cron entry or systemd timer calling a
  standalone script — **not** an in-process scheduler inside the consumer, and **not**
  auto-committing the file to git on each run (committing stays a manual/separate
  concern). This slice builds and tests the generator script and documents the intended
  schedule (a crontab line / systemd timer unit as a reference); actually installing it
  is deferred to the mini-mac deployment slice, which doesn't exist yet.
- **Credentials:** `ANTHROPIC_API_KEY` read from the environment (the operator's
  `.envrc`, via direnv) — never hardcoded. `.envrc` must be added to `.gitignore` before
  any credential-adjacent code is written, per this project's non-negotiable credential
  hygiene rule.
- **Malformed `data/keyphrases.json` at consumer startup:** fail loudly and refuse to
  start, rather than silently running with zero effective keyphrases (which would look
  healthy while doing nothing — exactly the failure class HANDOFF.md §4 warns against).
- **Multi-phrase matches:** one log line per item listing every matched phrase, not one
  line per phrase — keeps slice 1's one-line-per-item log philosophy intact.
- **Testing the generator:** the automated suite includes **one real Anthropic API
  call** verifying the full round-trip (read list → call Sonnet → parse structured
  output → write list) — not a mocked client, per the operator's explicit choice, despite
  the small per-run cost.

## Architecture

Two new components, plus a change to the existing wiring:

1. **`src/keyphrases/list.ts`** — loads and validates `data/keyphrases.json`: parses the
   JSON, enforces the 2-word minimum (warn-and-skip per entry), and fails loudly (throws)
   if the file is missing, malformed JSON, or not an array of strings.
2. **`src/keyphrases/match.ts`** — given a loaded phrase list, precompiles one
   word-boundary, case-insensitive regex per phrase (once, not per item), and exposes a
   function that returns which phrases (if any) matched a given text.
3. **`src/keyphrases/generate.ts`** — standalone script (run via `npm run
   generate-keyphrases`, not imported by the consumer): reads the current list via
   `list.ts`, calls `claude-sonnet-5` with the static market-context description and the
   current list, requests structured output, validates and writes the result back to
   `data/keyphrases.json`. On any failure, exits non-zero without touching the file.
4. **`src/main.ts` (modified)** — the `runOnce`/`onLine(string)` seam becomes an
   item-level handler: after `parseItemFields` succeeds, build the matchable text (see
   below), run the matcher, log slice 1's existing per-item summary line unchanged, and —
   only if at least one phrase matched — log a second line listing the matches. The
   phrase list and matcher are loaded once at startup (fail-loud here if the list is
   malformed), not per item.

## Data flow

```
Item (already parsed by slice 1's parseItemFields)
  → matchable text:
      snippet only,                  if provenance_gaps includes 'synthetic_headline'
      headline + snippet, otherwise
  → matcher.findMatches(text) → [] | ["phrase a", "phrase b", ...]
  → (unchanged) log slice 1's summary line
  → if matches non-empty: log "[KEYPHRASE-MATCH] item=<id> phrases=[...] headline=..."
```

Generator (separate process, not in this data flow):
```
data/keyphrases.json (current) + static market-context description
  → claude-sonnet-5, structured output {"keyphrases": string[]}
  → validate (array of strings) → overwrite data/keyphrases.json
  (on any failure: leave the file untouched, exit non-zero)
```

## Testing

Per `HANDOFF.md` §4 (drive the real call site, not just the function in isolation):

- **Matcher:** unit tests for the matching regex itself (case-insensitivity, word
  boundaries, apostrophes, hyphens, multi-phrase matches, no-match), plus a real-call-site
  test: an item arrives at the (modified) `runOnce`, and the test asserts on the actual
  log lines produced — both the normal summary and, for matching items, the
  `[KEYPHRASE-MATCH]` line — not on `findMatches` called in isolation.
- **Synthetic-headline handling:** a real-call-site test with a synthetic-headline item
  whose `snippet` contains a keyphrase, confirming it still matches (via snippet), and a
  variant where only the templated headline text would have matched, confirming it does
  *not* (proving the headline is genuinely excluded, not just usually not tested).
- **List loading:** tests for a valid list, a list with a too-short entry (warned and
  skipped, not fatal), and a malformed file (throws, fails loudly).
- **Generator:** one test makes a real `claude-sonnet-5` call (structured output) against
  a small fixture list and asserts the response is a valid array of ≥2-word strings;
  additional tests cover the failure-leaves-file-untouched behavior without needing a
  real API failure (e.g., by exercising the write-guard logic directly).

## Explicitly out of scope for this slice

- Haiku synopsis dispatch, Sonnet verify/decide, and any Kalshi/order-execution code —
  later slices.
- Actually installing a cron job or systemd timer anywhere — this slice builds and tests
  the generator script and documents the intended schedule only.
- A live Kalshi API call from the generator itself (context is static/hardcoded).
- A size cap on `data/keyphrases.json`.
- Auto-committing the generator's output to git.

## Follow-ups noted during brainstorming, not part of this slice

- The RCP settlement page's live per-poll methodology (which pollsters currently feed
  the average) is blocked by Cloudflare and was not confirmed. Worth another attempt
  (e.g. a different fetch approach, or asking Kalshi support) before assuming any
  specific pollster list is current.
- `.envrc` needs to be added to this repo's `.gitignore` as the first implementation
  step, before any credential-adjacent code is written.
