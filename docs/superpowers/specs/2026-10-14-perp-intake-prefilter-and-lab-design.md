# Perp intake prefilter (A) and intake lab (C)

Date: 2026-10-14. Status: **draft for the user's review** (design sections 1-4 approved in conversation on 2026-10-14; no code
written). Scope: the US500 perp bot (`src/perp/`, paper mode) and a new shadow service that validates its filter.

## 1. Intent and evidence

**Intent.** Deterministic code, not a model, should be the primary gate on what the perp bot's news intake reads. Only items
that pass cheap rules reach Haiku; only Haiku results that look material reach Sonnet. Cost comes first (option A). Because a
tight filter can silently drop real news, a separate lab (option C) measures what the filter misses, for one week, with a
fixed audit budget, and shows the result on the Grafana wall.

**What the bot does today** (measured 2026-10-14 12:04-17:56 PDT from `data/perp/perp-paper.db` and the `iip:items` stream):

- No code filter. `NewsIntake.handleItem` (`src/perp/intake/newsIntake.ts`) applies only hygiene checks (replay, amended, stale, bad
  time, already seen, no context), then calls the Haiku gate (`runPerpGate`, `src/perp/model/gate.ts`) on every remaining item.
- 887 items arrived in 6 h; 661 reached Haiku (~2,640/day); 207 were escalated to Sonnet (`extractImpact`, ~830/day). Model spend
  was $0.92 in 6 h (Sonnet $0.85, Haiku $0.07), about $3.70/day, against a default `PERP_DAILY_USD_CAP` of $5.
- All 207 Sonnet assessments were bucket `minor`; 88% were `neutral`; 57% had credibility <= 0.3. Nothing moved the bot (238 holds, 0 trades).
- 473 of the 661 gated items (72%) came from one social source, `bluesky_geopolitics` (tier 4), which produced 170 of the 207 Sonnet calls.
- `story_key` is empty on every item, so the executor's corroboration-based rung (`computeRung`) cannot be reused: 99% of items are "rumor" by tier alone.
- 32 gate calls failed because the model's `reason` exceeded `z.string().max(300)`; those items were lost and their tokens spent.

**Prototype on the same 6 h** (headline + snippet, first lexicon, offline): dropping social removes 473 of 877 items; among the
other 404, a lexicon score >= 3 keeps 58 (14%), i.e. about 60 Haiku calls per 6 h instead of 661 (-91%). Kept items include real
macro news ("Inflation heats up as gas prices surge", "CPI report shows a 3.7% increase", "The Fed's going to take its time with
rate hikes"); some noise also passes (an economics Nobel item, Social Security payment news) and is Haiku's job.

## 2. Decisions (user, 2026-10-14)

1. Cost first (A): aggressive filter now; social source dropped outright to start (no allow-list); lexicon threshold 3.
2. Plus the lab (C): runs 7 days in shadow; ground truth = Sonnet label on audited dropped items, with the perp mark's later
   move as a free second signal; audit spend capped at **$0.50/day**; a miss = Sonnet bucket `moderate` or higher.
3. Architecture: shared pure `prefilter` module; the lab is a separate service in the bot's repo and checkout (same code, commit logged).
4. A Grafana wall tile for the project. The user said "tile 15" first and "tile 10" last; the slot is a setting
   (`LAB_WALL_SLOT`, default **10**); both slots are vacant (checked 2026-10-14).

## 3. Goals, non-goals, success criteria

Goals: cut Haiku and Sonnet calls sharply without changing any trading rule; measure the filter's misses; make the result visible.

Non-goals: changing the policy/engine, thresholds of the trading rules, the stop logic, or the model prompts' trading semantics;
the paper executor's pipeline (a later port at most); allow-listing social accounts (decided from the week's data).

Success criteria (measured by the lab, normalised per day against the baseline above):

1. Haiku calls down >= 80% and Sonnet escalations down >= 70%.
2. Audit of the random strata shows a 95% upper bound on the miss rate <= 2%, or every miss is listed for review.
3. No trading code changes; the 355 existing `test/perp` tests still pass.
4. The lab runs 7 days within $0.50/day of its own spend; its tile is live on the wall.

## 4. Part A: the prefilter (`src/perp/intake/prefilter.ts`)

A pure function `prefilter(item, ctx): Verdict` with no I/O. `ctx` carries config, a clock, and the dedup/cap state object the
caller owns. Rules run cheapest first; the first failing rule decides the drop reason.

```ts
type Verdict = {
  pass: boolean;
  reason: 'pass' | 'source_class_drop' | 'low_score' | 'duplicate' | 'cooldown' | 'haiku_cap';
  sourceClass: 'official_macro' | 'market_wire' | 'press' | 'social' | 'unknown';
  score: number;          // lexicon score after weights and cap
  hits: string[];         // distinct pattern ids that matched
  dupOf?: string;         // item_id of the earlier near-duplicate
};
```

1. **Hygiene** stays exactly where it is in `handleItem` (replay, amended, stale, bad time, seen, no context).
2. **Source class** from `config/perp-prefilter.json` (`sources: { "<source_id>": "<class>" }`; unlisted ids are `unknown`, treated as `press`).
   - `official_macro` (`federal_reserve_*`, `bls_releases` and similar): always pass (no lexicon, no dedup cooldown).
   - `market_wire` (`oilprice_main`, `rigzone_latest`): pass at score >= 1.
   - `press` (tier-3 news and unknown): pass at score >= `threshold` (**3**).
   - `social` (`bluesky_geopolitics`): dropped (`source_class_drop`).
3. **Lexicon score** over `headline` (weight x2) + `snippet` (weight x1), lowercase, regex per pattern. Each distinct pattern counts once.
   Strong patterns +3 (Fed, FOMC, rate cut/hike/decision, interest rates, Powell, CPI, inflation, payrolls, jobs report, unemployment, GDP,
   recession, tariff(s), debt ceiling, government shutdown, bank failure/run/collapse, credit crunch/crisis, default, Treasury yield, bond market/yields,
   S&P 500, Wall Street, stock market, Nasdaq, Dow Jones). Medium patterns +1 (oil/crude, OPEC, Strait of Hormuz, energy price/crisis/shock, natural gas,
   earnings, guidance, trade deal/war/talks, sanctions, China, semiconductor, mega-cap names, central bank/ECB/BoJ/BoE/BoC, dollar, supply chain, missile/attack/strike).
   Negative patterns -2 (opinion, celebrity, sports, recipe, horoscope). Total capped at 10 and floored at 0. All lists live in the config file, versioned.
4. **Own dedup and cooldown.** Headline normalised to a token set (lowercase, punctuation and stopwords removed). Jaccard >= 0.6 against any
   item that passed in the last `dedupWindowMs` (default 6 h) => `duplicate`. Cooldown (`cooldownMs`, default 2 h): an item that has at least one strong hit and whose strong hits are all contained in an earlier passed item's strong hits within `cooldownMs` is a `cooldown`.
5. **Hourly caps** `haikuPerHour` (default 30) and `sonnetPerHour` (default 6). Over the Haiku cap, only items whose score is >= the current
   hour's cap-admitting minimum pass (floor = min(scoreCap, threshold + passesInLastHour - haikuPerHour + 1); official_macro bypasses); the rest are `haiku_cap`.

Fail closed: if `prefilter` throws for an item, the intake drops it, journals `prefilter_error`, and counts it; five in one UTC day raise one alert.
Kill switch: `PERP_PREFILTER=off` restores today's behaviour exactly (every hygiene-passing item goes to Haiku).

### Gate and escalation

- Gate output becomes `{ impact: 'none'|'minor'|'moderate'|'major', reason }` (`reason` truncated to 300 characters in code, never a validation error;
  `relevant` is derived: `impact !== 'none'`). Prompt keeps its macro/market framing and asks for the estimate.
- `escalate(impact, calendarWindowOpen, sonnetBudget): boolean` is a pure function: true if `impact` is `moderate`/`major`, or (`impact === 'minor'`
  and a high-impact calendar event is within +-2 h per `config/perp-calendar.json`), and the `sonnetPerHour` cap allows. Everything else is journaled and stops.
- `official_macro` items escalate on `impact >= minor` (they are rare and always worth Sonnet).

### Journal

The journal gets one `intake_item` row per item that reaches the prefilter (including drops), and one `intake_outcome` row per item the gate decided on.
`intake_item` payload: `{ itemId, sourceId, tier, pass, reason, sourceClass, score, hits, strongHits, dupOf?, commit }`;
`intake_outcome` payload: `{ itemId, impact, escalated, reason, haikuReason }`. The lab joins on `itemId`.

## 5. Part C: the intake lab (`src/perp/lab/`, service `intake-lab`)

A separate systemd user unit (`intake-lab.service`, paper-pinned like the bot, never reads live keys). It runs from the bot's checkout, imports the
same `prefilter` and `escalate`, and records the git commit on every row.

- **Input.** Its own Redis consumer group `perp-lab` on `iip:items` (start `$`), so it sees every item the bot sees.
- **Read-only access to the bot's data.** `perp-paper.db` opened `mode=ro` for: `marks` (price), `snapshots` (latest market context), `journal` (the bot's own
  `intake_item` rows), `assessments`.
- **Own store** `data/perp/lab.db`:

```sql
items(item_id TEXT PRIMARY KEY, received_ms INTEGER, source_id TEXT, tier INTEGER, headline TEXT, snippet_len INTEGER,
      commit_sha TEXT, class TEXT, score INTEGER, hits TEXT, prod_pass INTEGER, prod_reason TEXT, dup_of TEXT,
      variants TEXT,            -- JSON {"strict3":bool,"loose1":bool,"social_ok":bool}
      mark_at_ms INTEGER, mark REAL, ret_1h REAL, ret_4h REAL);
audits(item_id TEXT PRIMARY KEY, at_ms INTEGER, stratum TEXT, kind TEXT CHECK(kind IN ('random','boundary')),
       bucket TEXT, direction TEXT, credibility REAL, novelty TEXT, already_priced TEXT, confidence REAL, rationale TEXT,
       miss INTEGER, cost_usd REAL, model TEXT, ok INTEGER, error TEXT);
spend(day TEXT PRIMARY KEY, usd REAL, calls INTEGER);
heartbeat(ts_ms INTEGER, last_item_ms INTEGER, stream_ok INTEGER, bot_db_ok INTEGER, marks_fresh INTEGER);
```

- **Per item.** Same hygiene as the bot, then `prefilter` with the production config -> `items` row; the same item is also evaluated by the variants
  `strict3` (production), `loose1` (press threshold 1) and `social_ok` (social treated as press); booleans stored. Marks: `mark_at_ms`/`mark` = nearest mark at or before the
  item time; `ret_1h` / `ret_4h` filled later by a periodic job from `marks`.
- **Audit sampling.** Budget `LAB_DAILY_USD_CAP` (default **0.50**, UTC day, own `spend` table, hard stop), paced by an hourly slice of cap/24 with at most 2x carry-over.
  About 70% random, 30% boundary:
  - *random*: stratified over dropped items by stratum (`social`, `low_score`, `duplicate`, `cooldown`, `haiku_cap`), equal allocation across non-empty strata,
    seeded RNG (`LAB_SEED`); the overall miss-rate estimate weights each stratum by its volume.
  - *boundary*: non-social items with `score == threshold-1`, and social items with `score >= threshold` (where misses are most likely). Reported separately, never mixed into the random estimate.
  - The audit calls the bot's own `extractImpact` (Sonnet) with a context text built from the newest `snapshots` row by the same helper `model/context.ts`; if there is no snapshot
    newer than 10 minutes, that item is skipped (not counted). Items the bot already sent to Sonnet are joined from `assessments`, never re-paid.
  - **Miss** = audited bucket in {`moderate`,`major`,`shock`}. A model error skips the audit (no retries, no storm).
- **Second signal.** A dropped item with `|ret_4h|` >= 2 sigma of non-overlapping 4 h returns over the available prior history (>= 24 h) is flagged `moved` for manual review in the report.
- **Day 7.** After `LAB_DAYS` (default 7) days since the first row the lab stops all model spend and keeps logging features (free); the tile says "audit complete"; the report is generated once.
- **Failure handling.** Redis outage: reconnect with backoff. Bot DB unreadable: mark the light red, keep logging features. No stream entry for 30 min: one alert (reuse `sendAlert`, `[PERP-LAB]` prefix).
- **Statistics shown.** `misses k / n audited` with the 95% upper bound (exact Clopper-Pearson; 3/n when k = 0).

## 6. Wall tile and report

**Tile.** Project `intake-lab`, pinned to `LAB_WALL_SLOT` (default **10**), v2 template (`Grafana-Dashboard-Skill-Creator-/skills/grafana-wall/references/tile-spec.md`),
published by `~/wall/intake-lab-publish.py` (read-only; wall key read from the slot-writer's own `.env`, never printed) on a 2-minute user timer, same pattern as
`executor-wall-publish.py`. Status pill "Day n/7 · auditing" then "audit complete"; chips: branch, last-item age; six stat chips: Items 24h, To Haiku %, Audited, Misses (+95% bound),
Lab spend vs $0.50, Est. saved; health lights: lab service, news stream, perp bot service, audit budget, bot ledger readable, marks fresh; three charts (12 h, hourly): funnel
(seen / passed / escalated), audit (cumulative audited and misses), spend (lab spend vs cap pace, estimated saved). No headlines on the tile.
Until the lab exists the publisher shows a baseline from `perp-paper.db` (gate calls, Sonnet calls and spend per hour) with status "Design phase", so the tile is useful immediately.

**Report.** `scripts/intake-lab-report.ts` writes `docs/perp/intake-lab-week1.md` (uncommitted) from `lab.db`; runs automatically on day 7 (Slack summary + path), and is re-runnable. Contents: funnel by
source / class / reason; miss rate and bound per random stratum, boundary results separately; every miss with source, headline, bucket and rationale; `moved` list; variant table
(production vs `loose1` vs `social_ok`: extra Haiku/Sonnet calls vs misses caught); estimated savings from the bot's actual per-call costs; a concrete proposed config change. Applying it is the user's call.

## 7. Testing

- `prefilter`: table-driven tests from real 2026-10-14 headlines (the macro items above pass; the Bluesky rants drop; long snippets cannot inflate a score past the cap); dedup, cooldown, hourly caps, fail-closed, kill switch.
- Gate/escalation: a 400-character reason is truncated, not rejected; `escalate` boundaries incl. calendar window and cap.
- Lab: fake model client and clock, seeded sampler, hard-cap and pacing tests, stratum weighting, read-only proof (opening `perp-paper.db` `mode=ro`; a write attempt throws), snapshot-too-old skip, day-7 lifecycle.
- Tile/report: pure spec-builder and report tests against a fixture `lab.db`.
- Existing 355 perp tests and `tsc --noEmit` stay green; baseline of unrelated failures is unchanged.

## 8. Rollout

1. Build on a fresh worktree off `main` (the bot's checkout stays on `main`, untouched until deploy).
2. One deploy step restarts the bot and the lab together (same commit). A runs in paper mode first; the lab starts at once; the 7-day clock and the tile start.
3. Day 7: report; the user decides whether to apply the recommended config changes.
4. Merging to GitHub follows the user's explicit approval (PR from the worktree branch).
Note for the runbook: the bot's 4-week paper phase began 2026-10-14; this changes its intake behaviour mid-phase (trading rules unchanged), so the change date is recorded.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Lexicon drops real news | Lab measures it; `PERP_PREFILTER=off` reverts; exchange-side stops protect any open position; bot is paper-only |
| Lab overspend | Own hard cap, own table, hourly pacing |
| Lab affects the bot | Separate process, DB and consumer group; bot data opened read-only |
| Lab and bot drift apart | Same checkout; commit sha on every row; deployed together |
| Stale tile | Health light; same timer pattern as the other tiles |
| Sampling bias | Random and boundary samples reported separately; strata weighted by volume |
| Quiet week hides misses | The bound is reported honestly (3/n); `loose1`/`social_ok` variants and the `moved` list give extra evidence |
