# Design: `iip:items` Redis Consumer (Slice 1 of executor_module)

**Status:** Approved for planning
**Date:** 2026-08-24

## Context

`executor_module` is a brand-new repo building a live, AI-driven Kalshi trading
pipeline (full scope: `HANDOFF.md`). That pipeline decomposes into several
independent subsystems — market-mechanics research, this Redis consumer,
keyphrase matching, the Haiku→Sonnet→Sonnet decision pipeline, the Kalshi
execution client, risk controls, and deployment. Each gets its own
brainstorm → spec → plan cycle rather than one document covering everything.

This spec covers the **first slice only**: consuming the `iip:items` Redis
stream published by the sibling project `Internet_Info_Plug` (read-only
upstream dependency; never modified, never imported from — see
`HANDOFF.md` §1 and root `CLAUDE.md`) and proving the ingestion plumbing
works end-to-end against the real stream. It does **not** include
keyphrase matching, any model call, or any trade logic.

## Decisions carried in from brainstorming

- **Language/runtime:** Node.js + TypeScript.
- **Deployment target:** a new machine, `mini-mac` (`emac@192.168.1.49`).
  Rather than have `executor_module` reach across the network to
  `Internet_Info_Plug`'s current host (`ai1`), `Internet_Info_Plug` (the
  `iip` daemon) and its Redis instance are being **redeployed onto
  mini-mac too**, so everything for this project runs on one box and Redis
  stays localhost-only — matching how `iip` already assumes it's deployed
  (no `REDIS_URL` convention, no auth, no TLS; a CLI flag defaulting to
  `redis://127.0.0.1:6379/0`, confirmed by reading `iip/__main__.py` and
  `deploy/ai1/iip.service` in that repo). **Migrating `iip` itself to
  mini-mac is deployment/ops work tracked separately — it does not change
  any code in `Internet_Info_Plug`, and is a prerequisite for this slice
  to run for real, not part of this spec's deliverable.**
- **Consumer group name:** `execmod` — deliberately distinct from the
  sibling project's own consumer group name `iipx` (used by
  `Internet_Info_Plug/executor/consume.py`), so the two processes can
  never collide if ever pointed at the same stream.
- **Scope of this slice:** parse and log each item to stdout. No
  persistence, no filtering, no downstream hook — this is the smallest
  concrete proof that the plumbing works, per `HANDOFF.md` §3 step 3.

## Corrected `Item` field list

`HANDOFF.md` §1.2's field table, cross-checked directly against
`Internet_Info_Plug/iip/schema.py`, was missing seven real fields. The
full field set the consumer's schema must model:

`item_id`, `dedup_id`, `story_key`, `event_type`, `replay`, `source_id`,
`adapter`, `trust_tier`, `headline`, `snippet`, `url`, `raw_url`,
`enrich_url`, `author`, `lang`, `body_state`, `body`, `event_time`,
`source_publish_ts`, `first_seen_ts`, `emitted_ts`, `latency_ms`,
`is_first_sighting`, `corroborations`, `provenance_gaps`,
`amends_item_id`, `amendment_kind`.

Stream entries themselves are flat fields as required by `XADD`:
`item_id`, `source_id`, `adapter`, `trust_tier`, `event_type`, `headline`
(indexed strings) plus `json` (the full serialized `Item`) — confirmed
against `iip/emit.py`.

## Architecture

A single long-running Node.js/TypeScript process (`executor-module`
service) that:

1. Connects to Redis (`REDIS_URL` env var, default
   `redis://127.0.0.1:6379/0`).
2. Ensures consumer group `execmod` exists on stream `iip:items`
   (`XGROUP CREATE ... MKSTREAM`, idempotent — ignore `BUSYGROUP`).
3. On startup, drains its own pending entries (`XREADGROUP ... "0"`)
   before reading new ones (`XREADGROUP ... ">"`) — mirrors the sibling
   project's proven PEL-drain pattern in `executor/consume.py`, so a
   crash-and-restart doesn't silently skip in-flight entries.
4. Parses each entry's `json` field against a validated schema (zod),
   logs a structured summary line, and acks (`XACK`).
5. Runs until SIGINT/SIGTERM, then stops reading and lets in-flight acks
   finish before exiting.

## Components

- `src/redis/client.ts` — Redis connection setup (`redis` npm package,
  v4 client), reading `REDIS_URL` from the environment.
- `src/redis/consumer.ts` — the read loop described above: group
  bootstrap, PEL drain, blocking `XREADGROUP`, ack after successful
  handling.
- `src/item.ts` — a zod schema for the full corrected `Item` field list,
  parsing and validating the `json` field rather than trusting it.
- `src/log.ts` — the stdout summary line per item: `item_id`,
  `source_id`, `trust_tier`, `event_type`, `headline` (rendered as
  `[synthetic] <headline>` when `provenance_gaps` includes
  `synthetic_headline`), and an explicit `REPLAY` tag when
  `replay: true`. Nothing is filtered or suppressed at this stage —
  this slice observes, it doesn't decide.
- `src/main.ts` — wiring and graceful shutdown handling.

## Data flow & error handling

```
XREADGROUP entry → zod-parse `json` field → log line → XACK
```

- **Parse failure:** log the raw entry and the error, then still ack.
  At this slice, a parse failure only loses a log line, not a trade —
  dead-lettering (a `deadletter` stream, poison-entry redelivery counts)
  becomes worth building once a later slice actually acts on items,
  per the sibling project's `executor/consume.py` pattern, which is the
  reference to return to at that point.
- **Redis connection drop:** rely on the `redis` client library's
  built-in reconnect/backoff. On reconnect, redrain the PEL before
  resuming new reads, same as startup.

## Testing

Per `HANDOFF.md` §4's lesson — a test must drive the real call site, not
just a function in isolation — the test suite for this slice:

1. Spins up a real Redis (or a Redis test container) rather than a mock.
2. `XADD`s fabricated entries covering the known edge cases:
   `provenance_gaps` containing `synthetic_headline`, `replay: true`,
   `event_type: "item_amended"` with `amends_item_id` set,
   `body_state: "absent"` with `body` unset, and a malformed `json`
   field.
3. Runs the actual consumer loop (not a hand-called parser function)
   against that Redis instance.
4. Asserts on what the process actually logs and which entries it
   actually acks — including confirming a restart correctly redrains an
   unacked pending entry rather than skipping it.

## Explicitly out of scope for this slice

- Keyphrase matching, the Haiku/Sonnet pipeline, and any Kalshi
  execution or credential-handling code — later slices, later specs.
- Persisting parsed items anywhere beyond stdout.
- Filtering out `replay: true` or synthetic-headline items — surfaced
  in the log, not acted on, because nothing here acts yet.
- Any change to `Internet_Info_Plug` code. Redeploying the existing `iip`
  daemon onto mini-mac is an operational step this slice depends on, not
  a code change to that repo.

## Follow-up noted during brainstorming, not part of this slice

An SSH password for `mini-mac` was shared in plaintext in chat while
scoping this work. It has not been written to any file or log by this
process. Recommend rotating that password and switching to SSH key auth
for `mini-mac` before it becomes a habit, given how central credential
hygiene is to this project's rules (`HANDOFF.md` §2, root `CLAUDE.md`).
