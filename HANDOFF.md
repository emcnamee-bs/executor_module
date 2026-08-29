# HANDOFF — executor_module

**Written 2026-08-24 for an agent with ZERO prior context.** This repo is brand new —
empty except for this file and `CLAUDE.md`. Do not assume any earlier conversation, and do
not assume any code exists yet. It doesn't. This is a from-scratch build.

---

## 0. What this project is FOR

A live, AI-driven trading system for one Kalshi market to start:
`https://kalshi.com/markets/kxaprpotus/president-rcp-approval-rating-this-week/kxaprpotus-26aug28`
— a weekly presidential approval-rating market. **Do not assume you know its exact
resolution mechanics (what "RCP approval rating" means, how the strike/settlement is
computed, when it closes).** Pull the live market spec from Kalshi's API before designing
any signal or sizing logic around it. Treat every assumption about this market the same
way its sibling project treats every assumption about a data source: verify before you
build on it.

The intended pipeline, as specified by the operator (not yet built, any part of it):

1. A scanner watches news-outlet output for a curated list of AI-generated keyphrases —
   matched against an article's **title and first paragraph**.
2. A match dispatches a cheap/fast model (**Haiku**) to read the article and produce a
   synopsis of what it's actually about.
3. **Sonnet** does a light, fast pass to verify the synopsis against the article (a
   cross-check, not a rebuild).
4. **Sonnet** decides the trade: direction (for/against), and whether to buy, sell, or
   hold — using a sizing/decision method still to be designed.
5. The decision is executed as a **real order against a real Kalshi market.** This is
   live money from the point execution is wired up. There is no simulation mode implied
   by this repo's existence — if a dry-run/paper mode is wanted, it must be built and
   explicitly chosen, not assumed to exist by default.

**Nothing above exists yet.** No scanner, no model calls, no decision code, no Kalshi
client, in this repo. Building all of it is the job.

---

## 1. The sibling project this depends on: Internet_Info_Plug

Path: `/Users/eamonmcnamee/Downloads/Internet_Info_Plug` (also reachable at
`/Users/eamonmcnamee/downloads/Internet_Info_Plug` — case-insensitive alias on this Mac).

**Read its own `HANDOFF.md` and `CLAUDE.md` if you need more depth than this section
gives you** — but you should not need to modify anything in that repo to build this one.
Treat it as a read-only upstream dependency: a news-ingestion daemon called `iip/` that
polls government feeds, wire services, and social sources, and publishes normalized items
to a Redis stream. This project (`executor_module`) is meant to be **a new consumer of
that stream**, not a fork or extension of anything inside it.

### 1.1 Two hard boundaries that belong to that repo, not this one — respect them anyway

`Internet_Info_Plug` has a component called `executor/` that looks superficially like
what you're building here — it's a decision/sizing engine that reads the same kind of
stream data and computes simulated trades. **It is not a starting point, and it is not
extendable into this.** It's a measurement harness for a research question ("does latency
buy trading edge?") and is *deliberately, permanently* incapable of live trading — locked
venv (13 pinned dependencies, no HTTP client, no signing library), a network guard armed
at import, no live-mode flag anywhere, and a test suite that fails on purpose if any of
that is loosened. **Do not import from it, do not vendor its code by copying files, and
do not ask an agent working in that repo to weaken any of those guards.** Its `decide/`
module (rung-based stake ladder, Kelly sizing, notional ceilings — see §3 below) is worth
reading as **design inspiration only**, the way you'd read a paper, not a library.

The other boundary: `Internet_Info_Plug`'s ingestion layer (`iip/`) enforces "market
ignorance" — no keyword or rule encoding a specific market's resolution condition is
allowed to enter that codebase. That's their rule to keep the daemon a generic
news-listener rather than a piece of trading infrastructure. **This project is exactly
the trading infrastructure that rule is designed to keep separate** — which is the whole
reason it lives in its own repo. Your market-specific keyphrases, your `KXAPRPOTUS`
logic, your RCP-approval-rating-specific rules: all of it belongs here, never in
`iip/`. If you find yourself wanting to add a market-specific keyword to
`Internet_Info_Plug/config/sources.yaml` or anywhere under `Internet_Info_Plug/iip/`,
stop — that's a sign the thing you're building belongs in this repo instead.

### 1.2 The interface you actually consume: the Redis stream

`iip/emit.py` publishes to a Redis stream named **`iip:items`** (there is also
`iip:alerts` for daemon health alerts, likely less relevant here) via `XADD`. Each stream
entry has these fields:

| Field | Contents |
|---|---|
| `item_id` | time-sortable id, e.g. `1755999999999-a1b2c3d4e5f6` |
| `source_id` | which configured source emitted this (e.g. `bbc_world`, `reddit_geopolitics`) |
| `adapter` | adapter type: `feed`, `primary`, `bluesky`, etc. |
| `trust_tier` | `1` (official/government) through `5` (unverified); **in the current archive only 1 and 3 are ever used** |
| `event_type` | `item` (new item) or `item_amended` (a correction/retraction/headline change to a prior item) |
| `headline` | the headline text — **check `provenance_gaps` in the JSON payload before trusting this is real editorial text**; some adapters synthesize it |
| `json` | the full item, as JSON. This is where everything else lives — parse this. |

The full `json` payload (Pydantic model `Item` in `Internet_Info_Plug/iip/schema.py`) has
these fields worth knowing about before you build a consumer:

- `headline`, `snippet`, `url`, `raw_url`, `enrich_url`, `author`, `lang`
- `body_state` (`absent` / `fetching` / `present` / `paywalled` / `failed`) and `body` —
  full article text is fetched **on demand**, not always populated. Check `body_state`
  before assuming `body` is there.
- `source_publish_ts`, `first_seen_ts`, `emitted_ts`, `latency_ms` — timing. Note
  `event_time` is **reserved and always None** — there is no true event timestamp, only
  sighting timestamps.
- `story_key` — a clustering id across sources reporting the same story, and
  `corroborations` — how many other sources hit the same story. **Currently `story_key`
  is `None` on essentially all historical items** (it was only recently wired up at emit
  time), so don't design a decision step that hard-depends on corroboration being
  populated without checking it's actually there for a given item.
- `provenance_gaps` — a tuple that may contain `synthetic_headline` (the headline was
  invented by the adapter, not written by a human — matching rules against it is matching
  against nobody's words), `no_article_url`, `title_not_headline`. **Check this before
  running your keyphrase match or handing the item to Haiku** — a synthetic headline
  should probably be treated differently (or skipped) rather than analyzed as if a
  journalist wrote it.
- `replay: bool` — `True` on items republished by that project's replay/backtest harness.
  **A real trading consumer must never act on a replayed item.** If you ever run their
  replay tooling against a shared Redis instance, filter this field or use an isolated
  Redis for testing.
- `amends_item_id` / `amendment_kind` (`headline_changed` / `removed`) — set together when
  `event_type == item_amended`. This is the daemon's retraction/correction mechanism. A
  trading system built on news should have an opinion about what happens to an open
  position when the story it was based on gets amended or removed — that's currently
  undesigned here.

Consume with a Redis consumer group (`XREADGROUP`) rather than a bare read, so you get
at-least-once delivery and can track your own offset independent of the daemon's own
process.

### 1.3 Prior art worth reading, not reusing: `executor/decide/` and `executor/rules.d/`

Even though you can't import this code, the *concepts* it encodes are a reasonable
starting point for your own decision design, refined over real iteration on real (if
synthetic) data:

- **A keyword-rule format** (`executor/rules.d/example.json`): each rule has an
  `all_of`/`any_of`/`none_of` token match (prefix, word-anchored — not substring, not
  exact — see that file's `_prefix_matching_evidence` block for why), a `market_id`, a
  `side`, a `min_rung` gate, and a `base_move_pts` estimate of how much the market should
  move if the rule fires. Worth adapting for your keyphrase list, but your matching will
  presumably be softer/AI-driven rather than pure token rules.
- **A rung ladder** (`executor/decide/sizing.py`): stake scales with evidentiary
  confidence — `rumor` (0%), `reported` (25%), `corroborated` (50%), `confirmed` (100%) —
  kept deliberately separate from trust tier, because "this outlet is usually right" and
  "this story is well-established" are different facts and conflating them was an
  identified design mistake in that project.
- **Kelly-fraction sizing against a fair-value estimate** (same file): `(100·p − c)/(100 −
  c)` for a binary contract priced in cents, floored at 0 rather than flipping direction
  on a negative result.
- **A notional/contract ceiling enforced redundantly at multiple layers**
  (`executor/models.py`, `executor/decide/gates.py`) — the lesson recorded there is that a
  single risk cap checked in only one place is fragile; check it at construction, at
  sizing, and at persistence (DB constraint), and pin all of them with tests.
- **`confirmed_sources` as a privileged, dangerous shortcut** — a hand-edited allowlist
  that changes both size limits and gate behavior was flagged as "an unprotected
  privileged surface" in that project because editing it doesn't look like a risk
  decision. Worth deciding deliberately here whether you want anything like it, and if so,
  protecting it with tests from day one rather than by convention.
- **Provenance-of-decisions as code, not prose** (`executor/decide/provenance.py`) — that
  project ships a machine-checked declaration of which of its functions model something
  real versus which are stand-ins, printed above every report. Given this project touches
  real money, an equivalent discipline — a report that states plainly what each number is
  and isn't — seems directly worth carrying over.

None of the above is load-bearing design guidance — brainstorm the actual decision method
with the operator rather than porting this wholesale. It's here so you don't have to
rediscover the vocabulary from zero.

---

## 2. What else exists on this machine relevant to live Kalshi execution

Four other repos in `/Users/eamonmcnamee/Downloads/` reference real Kalshi API
credentials and (per `Internet_Info_Plug/HANDOFF.md`'s credential-hygiene notes) may
already contain working, signed Kalshi clients:

- `Fast99Follower/` — `src/kalshiClient.js`
- `InsiderTradeFollower/`
- `Personal_Fingerprinter/` — `helpers/kalshi_client.py`, `tools/fetch_kalshi_history.py`
- `kalshi-spine/` — `poller.js`

**None of this has been inspected as part of writing this doc.** The operator was
explicit, in the sibling project, that its executor must never execute, import, or
subprocess those specific files — but that restriction belongs to that project's charter
(it must stay structurally incapable of trading). **This project is different: it is
*supposed* to authenticate to Kalshi and place real orders.** So the right first move is
almost certainly to **look at what execution capability already exists in those four
repos** before writing a Kalshi client from scratch — there is no reason to reinvent
RSA-PSS request signing if a working implementation already exists two folders over.

The canonical private key, per that same handoff, lives at `~/.kalshi-spine/kalshi_key.pem`,
**mode 600**, with `Fast99Follower/` and `InsiderTradeFollower/` holding their own copies
(also mode 600) — the file(s) an execution client here would need to read. That key ID and
its bytes have never been committed anywhere on this machine, and that discipline should
continue here without exception:

- **Never commit `kalshi_key.pem` or any file containing `-----BEGIN`** to this repo.
- **Never hardcode a key ID or path as a fallback default** in tracked code — read
  `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY_PATH` from the environment or a git-ignored
  `.env`, and fail loudly naming the missing variable if absent (this is the pattern the
  other repos were fixed to use, per that handoff).
- **Never log, print, or write the key's bytes anywhere** — not to a commit, not to this
  or any other markdown file, not to a debug log.
- Add `.env`, `*.pem`, and any credentials directory to `.gitignore` **before** the first
  time any credential-adjacent code is written, not after.

---

## 3. What "everything needed to build the rest of the project" means concretely

In rough dependency order — not a mandate, a starting map to brainstorm from:

1. **Confirm the market's real mechanics.** Fetch `KXAPRPOTUS-26AUG28`'s spec from
   Kalshi's API (or docs) — settlement source, timing, tick size, how "RCP approval
   rating" is actually computed and by whom. Do not design the signal or the decision
   logic around an assumption about this.
2. **Decide language/venv.** This repo is empty — no constraint carried over from the
   sibling project's Python choice or its locked venv. Pick what's right for this job.
3. **Wire up the Redis consumer** against `iip:items` (§1.2) — this is the cheapest,
   most concrete first slice, and it's fully specified above.
4. **Design and build the keyphrase list + match step.** AI-generated, per the operator's
   description — likely an offline/periodic step (an LLM proposes/refines phrases) feeding
   a fast runtime match against title + first paragraph. `Internet_Info_Plug/discovery/propose.py`
   is a real (if different-purpose) example of using the Anthropic SDK offline to generate
   candidate lists, worth a skim for the API-call pattern, not the content.
5. **Build the Haiku synopsis step, the Sonnet verify step, and the Sonnet decision
   step.** No existing code for any of the three. Needs: prompt design, structured
   output (a decision needs a machine-parseable direction/size, not prose), and a
   provenance record of what each model was actually asked and told (see §1.3's
   provenance point — worth having from day one so a bad trade can be traced to a
   specific model output rather than "the AI decided").
6. **Build or reuse a Kalshi execution client** — see §2. Needs real authentication
   (RSA-PSS request signing), order placement, fill/rejection handling, and position
   tracking against the account's actual state (not an internal ledger that can drift
   from reality — reconcile against Kalshi's own position/order endpoints, not just your
   own database).
7. **Build risk controls before the first real order, not after:** a hard position/
   notional cap (redundant, per §1.3's lesson), a kill switch, and a plan for what happens
   on a partial fill, a rejected order, or the model pipeline throwing partway through.
   Given the stated goal is fast, automated, real-money trades, an unhandled exception
   mid-pipeline is a live-money incident, not a test failure.
8. **Decide whether a dry-run/paper mode is wanted for this project.** Unlike the sibling
   repo, nothing here defaults to simulation-only — if you want a safe rehearsal mode, it
   has to be explicitly designed, and (learning from the sibling project's own experience)
   probably needs to be structurally hard to accidentally leave off, e.g. a required
   explicit flag to go live rather than a flag to simulate.
9. **Decide where this runs.** The operator is setting up an Ubuntu box now
   (`Internet_Info_Plug/deploy/ai1/README.md` documents deploying the *news daemon* to a
   Tailscale-reachable box called `ai1`, `Ubuntu 24.04.4`, already running as a systemd
   user service). This new component could run there too, as a second systemd service —
   the deploy pattern (git bundle transfer, `.venv`, systemd user unit, Tailscale tunnel for
   any local status endpoint) transfers directly. Confirm with the operator whether this
   shares that box or gets its own.

---

## 4. Method lessons from the sibling project worth carrying over verbatim

`Internet_Info_Plug`'s `HANDOFF.md` §6 documents a recurring defect class found across
its own build, expensively, more than once: **a guard that fires correctly and says
something it never checked** — a true mechanism with a false sentence attached, with no
test pinning the sentence. Examples there: a health check claiming "producing normally"
for a source producing nothing; a value silently dropped between producer and consumer
that every unit test missed because unit tests construct their own arguments instead of
going through the real call site.

This matters more here, not less, because the failure mode in this project isn't a
misleading health check — it's a real order placed on bad information, or a real position
left unmanaged because a wiring bug made a risk check unreachable. Two habits worth
adopting from day one, stated there as load-bearing:

1. **For every value that travels producer → consumer (a price, a decision, a size),
   write at least one test that drives the REAL call site** — not the sizing function in
   isolation, but the full path from "item arrived" to "order request constructed" — so a
   caller that silently stops passing an argument gets caught.
2. **Treat "the suite is green" as evidence about the tests, never about the code.**
   Mutate the code (delete an argument at a call site, not inside a function body) and
   confirm the relevant test actually goes red before trusting it protects anything.

---

## 5. Current state of the sibling project, so you don't have to re-derive it

Measured 2026-08-24, on `Internet_Info_Plug`'s `main` branch:

- `iip/` (the news daemon) is mature: dedup, silence/gap detection, amendment/retraction
  handling, rate limiting, 7 configured sources (BLS, Federal Register, State Department,
  IAEA, Al Jazeera, BBC, Reddit r/geopolitics, plus OFAC via a generic page-watcher
  adapter). **None of its sources are polling-data or approval-rating specific** — nothing
  upstream already tracks anything related to `KXAPRPOTUS`.
- It's actively being deployed to `ai1` (the Ubuntu box the operator is setting up) for a
  28-day passive baseline-observation run — **not** a trading run. That run existing
  doesn't block or conflict with this project consuming the same stream.
- `executor/` (the sibling's own simulation harness) has run one internal end-to-end proof
  — 81 archived items → 106 stream entries → 45 simulated decisions → 27 simulated fills,
  zero network, zero credentials — and its own finding was that **latency imposes a real,
  measurable floor on how much edge is worth having** (a 5-second decision delay already
  costs 0.16–0.32 points of edge on their model; by 60 seconds most simulated positions
  no longer clear that floor). Worth treating as a hypothesis to re-test on this market's
  actual liquidity and spread, not an assumed constant.
- No AI-driven classification, verification, or decision pipeline exists anywhere on this
  machine yet, in any repo. The Haiku → Sonnet → Sonnet pipeline described in §0 is a
  genuinely new build.

---

## 5a. Operator runbook: going live with real money

**Added 2026-08-28, with the Kalshi execution client (slice 4).** From the moment
`KALSHI_DRY_RUN` is unset, this process places real orders with real money. Everything
below is a pre-go-live gate, not a suggestion. Each checklist item exists because it
**cannot be verified by an automated test** — every one of them needs live credentials
and the real exchange, which the test suite deliberately never has.

### 5a.1 Environment variables

| Variable | Required? | What it does |
|---|---|---|
| `KALSHI_API_KEY_ID` | **Yes** | Kalshi API key id, used as the `KALSHI-ACCESS-KEY` header. `main()` fails loudly at startup naming it if absent. Never hardcoded, never defaulted (§2). |
| `KALSHI_PRIVATE_KEY_PATH` | **Yes** | Path to the RSA private key PEM used for RSA-PSS request signing (canonically `~/.kalshi-spine/kalshi_key.pem`, mode 600). The file itself is never committed, logged, or printed. |
| `KALSHI_DRY_RUN` | No | Set to the exact string `'true'` to block every real exchange call. See below for exactly what it does and does not do. |
| `EXECUTOR_TRADING_HALTED` | No | Kill switch. `'true'` makes every item record a skip row before any model call. Independent of `KALSHI_DRY_RUN` — use this to stop trading without stopping the process. |
| `ANTHROPIC_API_KEY` | **Yes** | The Haiku synopsis / Sonnet verify / Sonnet decide calls. |
| `SLACK_WEBHOOK_URL` | No | Slack incoming-webhook URL that powers the three alert events (§5a.2b). If unset, `sendAlert` logs a warning and no-ops — every event still happens and is still recorded in the ledger, but no human is paged. Bearer-equivalent secret: never hardcoded, never defaulted, never logged (§2). |

**What `KALSHI_DRY_RUN=true` actually guarantees:** `KalshiClient.createOrder` never
issues an HTTP request at all — it returns a synthetic `DRYRUN-<client_order_id>` order
locally. `placeOrder` then returns a *simulated* full fill flagged `dryRun: true`, and
the pipeline records that simulation in the `decisions` table as a **skip**
(`would_trade = 0`, contracts 0, notional 0, with a `[DRY_RUN simulated] …` reason). This
matters: `decisions` is the table every exposure-cap and dedup query reads, so a dry run
consumes none of the real $40 per-event cap and creates no phantom open position. The
`orders` row still records the simulation for audit, unmistakably marked by the
`DRYRUN-` prefix on `kalshi_order_id`.

Note that `KALSHI_DRY_RUN` gates only the **order** path. The read-only Kalshi calls
(`getPositions`, `getOrders`, `getBalance`, the ladder fetch) and all three model calls
are made for real in dry-run mode, which is the point: it is a rehearsal of the whole
pipeline, not an offline simulation.

### 5a.2 Pre-go-live checklist

Do these in order. Do not skip one because the suite is green — the suite proves things
about the code, never about the exchange (§4, lesson 2).

1. **Run `npm run smoke` first.** Read-only: `getBalance`, `getPositions`, and the
   `getOrders` probe below. Nothing is ordered. This is the only end-to-end check that
   the API key id, the PEM on disk, and the RSA-PSS signing all actually work together
   against the live API — a signing bug is otherwise indistinguishable from a
   credentials bug at 3am, and neither is reachable from a test that injects its own
   `fetch`.
2. **Confirm the `client_order_id` query filter really works.** `scripts/smoke.ts` calls
   `getOrders({ client_order_id: <a made-up uuid> })` and prints the raw response.
   *Why this is here:* the response FIELDS this branch reads
   (`orders[].client_order_id`, `.ticker`) are confirmed from real production code in
   `Fast99Follower`/`kalshi-spine`, but the **query parameter is not** — neither sibling
   repo has ever called `getOrders` with that filter. Expect an empty `orders` list. If
   Kalshi instead returns unrelated orders, it is ignoring the filter; reconciliation
   still only counts an exact `client_order_id` match so it degrades to a broader scan
   rather than a false positive, but you should know that before relying on it.
3. **Confirm positions read back SIGNED, as `position` (not only `position_fp`).** In the
   same smoke output, check that any NO holding shows as a **negative** `position`. All
   fill detection is a signed position diff (a NO fill moves `position` down); if the live
   API ever returned an unsigned magnitude instead, every NO fill would be recorded as
   zero contracts and zero exposure. This is exactly the defect the final whole-branch
   review caught in code — verify the premise it now rests on. Separately: `kalshi-spine`
   and `Fast99Follower`'s own `normalize.js` both fall back to a fixed-point `position_fp`
   field when `position` is absent — this branch deliberately does NOT implement that
   fallback (no confirmed evidence it's what a live response actually sends), and instead
   throws loudly if a matching position entry's `position` field is missing or
   non-numeric. Confirm the live response really does carry a numeric `position` field
   directly; if it doesn't, `positionForTicker` needs the `position_fp` fallback added
   before this is safe to run unattended.
4. **Place one real, small, deliberate order on EACH side — one YES and one NO — with
   `KALSHI_DRY_RUN` unset.** Then inspect `data/decisions.db` by hand and confirm:
   - the `orders` row has the right `side`, and `filled_contracts` matches what actually
     executed — **especially for the NO order**, which is the case mocked tests can only
     ever prove against a mock;
   - the `decisions` row shows `would_trade = 1` with `notional_cents = contracts ×
     entry_price_cents` for a real fill;
   - the `getPositions` read taken immediately after placement already reflected the
     fill. **`placeOrder` assumes Kalshi's portfolio-positions endpoint is
     read-your-writes consistent with order execution on that timescale, and nothing
     establishes that.** (`Fast99Follower`, this design's precedent, reads positions on a
     *later* reconcile pass, not inline.) If the position read lags, a real fill lands as
     `unfilled` until the next startup reconciliation catches it. Verify before trusting
     it; if it lags, the fix is to move fill determination to a delayed reconcile pass.
5. **Confirm whether `GET /portfolio/positions` really paginates, and with what default
   page size.** `npm run smoke` now logs a raw, single-page, unmerged call
   (`getPositionsRawPage()`) alongside the normal merged `getPositions()` call
   specifically so this is checkable — the merged call alone drops `cursor` entirely and
   can't show it. Check whether that raw response carries a `cursor` field and whether
   `market_positions` on the merged log line is ever longer than on the raw one.
   *Why this is here:* `getPositions()` follows `cursor` to completion and asks for
   `limit=1000`, because a ticker that falls off an unfetched page reads back as absent
   — and absent means position 0, which is indistinguishable from "really flat" and
   fires a spurious permanent market block (or masks a real divergence). This also rides
   on every live positions read, not just reconciliation's — including the pre-order
   snapshot inside `placeOrder` — so if Kalshi rejects `limit=1000` outright, `npm run
   smoke` fails loudly rather than this surfacing later as a live order failure. But the
   pagination was built **without live API access**: the `cursor` field name and the
   `limit` parameter are the documented/sibling-repo pattern (`kalshi-spine`'s
   `getTrades`), not something confirmed against this endpoint, exactly as the
   `finalized`/`settled` vocabulary was confirmed live before slice 5 relied on it. If
   the real response names its paging token something else, the loop silently reads only
   the first page again — verify before relying on it. Note also that the client now
   throws rather than returning a truncated list if the cursor never terminates after 50
   pages.
6. **Start with the kill switch reachable.** Know how to set `EXECUTOR_TRADING_HALTED=true`
   and restart before the first live item arrives, not after.
7. **Confirm `SLACK_WEBHOOK_URL` is set before trading with real money.**
   Without it, `sendAlert` silently no-ops (logged as a warning) — every
   circuit-breaker trip, market-block, and unclean-exit restart still happens
   and is still recorded in the ledger, but no human gets paged. Verify with a
   real (throwaway) webhook URL that a test message actually lands in the
   right Slack channel before relying on this in production.

### 5a.2a Automatic circuit breakers (added in slice 6)

Three independent automatic triggers halt ALL new order placement, the same global
effect as `EXECUTOR_TRADING_HALTED`, when recent history crosses a fixed threshold:

- **Failed/ambiguous orders**: 3 orders resolving to `rejected`/`unknown`/`error`
  within 30 minutes.
- **Reconciliation divergences**: 2 distinct markets blocked by slice 5's
  reconciliation within 60 minutes.
- **Kalshi API errors**: 5 errors from any Kalshi API call (order placement,
  position/status reads, market data) within 15 minutes.

A trip is visible in the `circuit_breaker_trips` table and logged loudly as
`[CIRCUIT-BREAKER-TRIPPED]`. It halts only NEW decisions (matching this system's
entry-only scope) — nothing already in flight is affected, and slice 5's per-market
`market_blocks` mechanism is completely independent of this.

**Recovery is manual only** — there is no auto-expiry. Investigate the real cause
(check `circuit_breaker_trips.reason`, and the underlying `orders`/`market_blocks`/
`kalshi_errors` rows it references) before clearing. To clear:

```
direnv exec . npm run clear-breaker
```

This clears every currently-open trip, not just one — if more than one signal
tripped, clearing is a statement that the whole situation is resolved, not just one
signal among several. **Clearing the breaker does not fix whatever tripped it.** If
the root cause is still live (Kalshi is still erroring, or a market blocked by
slice 5's reconciliation is still genuinely diverged), the breaker can trip again
shortly after clearing — treat a second trip shortly after a clear as evidence the
cause was not actually resolved, not as a flapping breaker. Note specifically for
divergences: a still-blocked market from BEFORE the clear does not by itself
re-trip the signal (only a genuinely new block does), but it still counts toward
the 60-minute window, so any single new divergence elsewhere completes the
threshold sooner than the trip reason's raw count might suggest — read
`market_blocks.blocked_at` alongside `circuit_breaker_trips.reason`, not the
reason string alone.

**Reading a `kalshi-errors` trip: 5 errors is often fewer than 5 incidents.**
`placeOrder` retries a transient failure up to 3 times, and each attempt logs its
own `kalshi_errors` row; an exhausted retry's follow-up `reconcileOrder` call can
log a 4th. So a SINGLE order attempt during one Kalshi blip can produce most of the
5-error threshold on its own, and the next unrelated API call (the next item's
`getPositions`, or the reconciliation timer's `fetchMarketStatus`) completes the
trip. This is deliberate — fail-closed is the right default when a real-money system
hits unexplained API trouble — but it means an operator investigating a
`kalshi-errors` trip should read the `kalshi_errors` rows' `call_site`/`occurred_at`
and check whether it was one retry storm rather than assume five independent
failures occurred.

### 5a.2b Slack alerting (added in slice 7)

Three events post to Slack via `SLACK_WEBHOOK_URL` (a plain incoming-webhook
POST, no other configuration): any circuit breaker trip — all three signals
(`failed-orders`, `divergences`, and `kalshi-errors`, all from slice 6) — any
genuinely NEW market block from slice 5's reconciliation (not a re-block of an
already-blocked ticker), and a process restart following an unclean exit
(detected via the `process_lifecycle` table at the NEXT startup — a real
crash cannot reliably alert from inside itself).

Each alert names the specific condition and the exact recovery command
(`npm run clear-breaker` / `npm run clear-block -- <ticker>`), runnable exactly
as pasted. The market-block alert carries the full divergence `reason` verbatim,
matching its own console log line; the breaker-trip alert carries the signal
name and its own `reason` text directly (the same string written to
`circuit_breaker_trips.reason`) — read that table (and `market_blocks`) for
full detail regardless.

**Breaker-trip alerting fires from inside `tripBreaker` itself** (`ledger.ts`),
not from each caller — this closes two problems a caller-side approach had
when this was first built: it makes `kalshi-errors` alert at all (previously no
caller ever did), and it fixes a real cross-signal suppression bug (an
already-open, unrelated signal used to make the callers' shared
`isTradingHalted` snapshot already `true`, silently swallowing a genuinely new
trip on a different signal). `tripBreaker`'s own per-signal `alreadyOpen` check
is what decides whether to alert now, so each signal alerts independently of
whatever else may already be open.

Delivery is fire-and-forget with one retry: a Slack outage or network blip
never delays or crashes the trading code path that triggered the alert, but it
does mean an alert can occasionally be lost entirely (both the original
attempt and the retry failing) with nothing else surfacing that specific
failure beyond a log line. Treat Slack alerting as a convenience layer on top
of the ledger's own durable state (`circuit_breaker_trips`, `market_blocks`,
`process_lifecycle`), never as the sole source of truth for whether something
happened. Each POST is bounded by a 5-second timeout per attempt (~12 seconds
across both attempts and the retry delay, worst case), so a hung Slack
connection cannot hold the process open past a clean shutdown for long.

The one exception to fire-and-forget is the unclean-exit alert at startup, which
IS awaited: it runs before the consumer loop has accepted any work (so there is
no trading path to delay), and awaiting it stops a later startup failure from
abandoning the in-flight POST. With Slack unreachable this can add up to ~12
seconds to boot (two attempts plus the retry delay) and no more — it can never
fail the boot.

One limitation of that durable state itself: `process_lifecycle` is a single
global row with no per-instance identity, so unclean-exit detection assumes ONE
process instance per `data/decisions.db` — an assumption nothing currently
enforces (`EXECMOD_CONSUMER_NAME` exists precisely because a second consumer is
at least contemplated). If two processes ever share one ledger file, one
process's clean shutdown can mask the other's crash, and one process's crash can
fire a false unclean-exit alert on an unrelated instance's next boot.

### 5a.2c Trade pacing limit (added in slice 9)

At most `MAX_TRADES_PER_WINDOW` (1) real trades (`would_trade = 1` rows only —
a rejected order, or any declined decision including one declined by this
same limit, never counts) within a rolling `RATE_LIMIT_WINDOW_MINUTES` (15)
window, checked by `recentTradeCount` (`ledger.ts`) and enforced in
`pipeline.ts` immediately after the kill-switch/circuit-breaker and
rumor-rung checks — before any Haiku/Sonnet call, so a rate-limited item
never spends real API cost. Global scope, not per-event: this is a pacing
question ("is the system trading too fast right now?"), independent of which
market a decision happens to land on.

This caps how FAST the exposure budget in `MAX_TOTAL_EXPOSURE_CENTS` can be
deployed, not how much can ever be at risk — that is still the exposure
cap's own job.

A rate-limited decision resolves exactly like any other decline
(`would_trade: false`, reason `rate limit: 1 trade(s) per 15 minutes already
reached`) — it is NOT a circuit breaker. There is no halt, no
`[CIRCUIT-BREAKER-TRIPPED]` log line, and no clear script: the limit
self-expires as soon as the window rolls past the last real trade, the same
way `MAX_TOTAL_EXPOSURE_CENTS` already does. A burst of several correlated
signals in the same few minutes does NOT queue or spread out over time —
everything after the first real trade in a window is declined outright (a
permanent, already-resolved skip row, never redelivered), so if only one
item in a burst ever recurs, the rest of that burst's budget is never
deployed at all.

**Dry run never exercises this limit.** A dry run always resolves
`would_trade: false`, so a rehearsal shows unlimited pace; the first time
this limit can actually fire is with a real order in flight.

**This assumes one process per `data/decisions.db`, the same premise
§5a.2b's unclean-exit detection already depends on** — nothing currently
enforces it. Two consumer processes sharing one ledger could each read the
same recent-trade count before either one's fill is durably recorded, and
each place a real trade in the same window. `MAX_TOTAL_EXPOSURE_CENTS`
survives that scenario because of its own DB-level CHECK/trigger; this limit
has no equivalent, so if a second consumer is ever added, this is the first
thing to revisit.

**Shares `MAX_TOTAL_EXPOSURE_CENTS`'s one blind spot**: a `pending` row stuck
retrying at startup (see §5a.3's note on rows that keep appearing in the
reconcile logs) represents a real live position that neither this limit, the
exposure cap, nor `reconcileOpenPositions` can see until it resolves to
`would_trade = 1` — inherited from slice 4, not introduced here.

### 5a.3 Operational notes

- **Startup reconciliation runs before the Redis consumer starts.**
  `reconcilePendingOrders(db, kalshiClient)` resolves any order left `pending` by a crash,
  determining the real outcome from Kalshi's own records, and then sweeps `decisions` rows
  stuck at `order_status = 'pending'` that no `orders`-row scan could reach. Per-row
  failures are logged (`[startup-reconcile] …`) and skipped, never fatal — one transient
  exchange error must not become a boot loop. **A row that keeps appearing in those logs
  across restarts needs a human**, because it is being retried identically every time.
- **The ledger schema changed in this slice** (`orders` gained `side` and
  `kalshi_order_status`). `openLedger` runs `CREATE TABLE IF NOT EXISTS`, which does NOT
  add columns to a table that already exists in a pre-existing `data/decisions.db`. If
  one exists from before this branch, migrate or recreate it before starting — a missing
  `side` column will fail at the first order, loudly, which is the correct direction to
  fail. The exceptions are the TWO auto-migrated columns —
  `decisions.settled_at` (added in slice 5) and `decisions.realized_pnl_cents` (added
  in slice 8): `openLedger` explicitly ALTERs each of them in when absent, so neither
  needs a manual migration. Both are auto-migrated for the same reason — their absence
  fails *silently* rather than loudly (without `settled_at`, reconciliation throws on
  every pass while trading continues unguarded; without `realized_pnl_cents`, every
  settlement throws, so a real settled position's P&L is never recorded).
  `realized_pnl_cents`' ALTER carries the same cross-column CHECK as a freshly-created
  table, so a migrated database gets identical DB-level enforcement. Every other column
  drift still needs a manual migration.

---

## 6. Instructions for whoever picks this up

1. Read this whole file before writing code.
2. Re-verify anything in §5 that a decision depends on — it's a snapshot, not a
   standing guarantee, and the sibling project's own experience is that a claim about
   another system, even one made honestly, should be re-measured before being built on.
3. Brainstorm the open design questions with the operator before locking in an
   architecture — §3 is a dependency map, not a spec. In particular: the exact decision
   method (step 4 of §0's pipeline), whether/how to add a dry-run mode, and where this
   runs are all explicitly open.
4. Treat §2's credential-hygiene rules as non-negotiable from the first line of code,
   not something to clean up later — that is exactly how the exposure this machine
   already has one history of happened.
