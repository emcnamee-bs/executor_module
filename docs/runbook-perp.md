# US500 perp bot — runbook

Spec: `docs/superpowers/specs/2026-10-14-us500-perp-bot-design.md`. Code: `src/perp/`. Host: mini-mac, user systemd.

## What runs
- `perp-bot.service`: PAPER mode (pinned). Reads Kalshi prices (GET only), simulates fills, applies the real decision logic. Spends Anthropic budget (cap `PERP_DAILY_USD_CAP`, default $5/UTC day).
- `perp-bot-demo.service`: DEMO-exchange rehearsal (pinned). Real order/stop/liquidation mechanics with play money. Needs `~/executor_module/.env.perp-demo` with `KALSHI_DEMO_API_KEY_ID`, `KALSHI_DEMO_PRIVATE_KEY_PATH`, `PERP_SUBACCOUNT`.
- No live unit ships. See "Going live".

## Install / start (paper)
    mkdir -p ~/executor_module-perp/data   # the units' ReadWritePaths needs it to exist (else 226/NAMESPACE); a fresh clone may lack it
    mkdir -p ~/.config/systemd/user
    cp ~/executor_module-perp/deploy/mini-mac/perp-bot.service ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now perp-bot
    journalctl --user -u perp-bot -f

Needs `config/perp-calendar.json` filled (below), `~/executor_module/.env` with `ANTHROPIC_API_KEY`, `REDIS_URL`, `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, optional `SLACK_WEBHOOK_URL`.

## Daily operation
- Cadence: `PERP_TICK_MS` (default 15000, min 5000) is the tick: every tick collects a fresh perp quote, polls the broker and runs every exit rule. `PERP_FULL_SNAPSHOT_MS` (default 300000, must be >= the tick) is the full snapshot: only then is the 8-day price history re-read from the database and a snapshot row stored; light ticks reuse the cached history and write no row. Macro (FRED) refreshes every 15 min and Kalshi event markets every 5 min regardless. `PERP_READ_TIMEOUT_MS` (default 5000, 1000-30000) is how long a Kalshi GET may take before the tick gives up and tries again on the next one; orders and stop writes keep a fixed 10 s because a timed-out write has an unknown outcome. Model (token) spend does not depend on either: it is driven by IIP news volume and capped by `PERP_DAILY_USD_CAP`.
- Price history: every tick records the perp mark in the `marks` table (16 bytes a row), so the full-snapshot step reads about 200 rows (last mark of each hour plus the marks nearest 1 and 5 days ago) instead of every stored row of 8 days, and the weekly high/low is one SQL max/min. For an investigation, `cd ~/executor_module-perp && npm run perp-history -- --db data/perp/perp-paper.db --from 24h --max-rows 200` prints a one-line summary (count, first/last, high and low with times) and at most N rows (last mark of each time bucket); narrow `--from`/`--to` (ISO, epoch ms or `<N>m|h|d`) to zoom in. Read-only; works on a database copy.
- Report: `cd ~/executor_module-perp && npm run perp-report -- --db data/perp/perp-paper.db --days 7`
- Slack alerts are tagged `[trade=perp-paper]`. Alerts to act on (grep for these exact fragments): "HALTED", "LIQUIDATED", "URGENT", "closed outside the bot", "found an orphan" (full text "found an orphan <side> position at the broker"), "side mismatch", "could not confirm the exchange position", "vanished while the bot was down", "consecutive tick failures", "model daily spend cap reached", "consecutive model/engine errors", "no IIP items for", "holding <side> across the weekly close", "economic calendar file".
- Clear a halt after reviewing why it halted: `npm run perp-clear-halt -- --db data/perp/perp-paper.db`. Clearing starts a new kill-switch epoch: exits and the equity peak from before the clear stop counting, so the kill-switch lookback (stop-outs in 30 days, drawdown from peak, exits in 24 h) starts again from zero. The script refuses (exit 1) when the bot is not halted; `--force` records a fresh epoch anyway (only do that deliberately: it forgets recent losses). It never creates a database: a wrong `--db` path is an error.
- Stop: `systemctl --user stop perp-bot`. A stopped bot with an open real position is protected only by its exchange-side trailing stop.

## Paper top-up (after losses)
Why: the entry guard refuses any entry whose realized leverage (mark / equity, one contract) exceeds 1.05 x the governed leverage (about 4x at VIX 16). With $3.50 of paper equity and a ~$13.75 contract, a loss of only ~$0.22 leaves the bot flat for good; the decision rows then say "realized leverage ... exceeds governed ... (fund more collateral)". `PERP_PAPER_EQUITY_USD` cannot fix it: it only seeds the first start, and the saved paper state wins on every restart.

    systemctl --user stop perp-bot
    cd ~/executor_module-perp && npm run perp-paper-fund -- --db data/perp/perp-paper.db --usd 1
    systemctl --user start perp-bot

The script refuses while the bot holds the database lock ("stop the perp-bot unit first"), refuses a database that does not exist or has no saved paper state yet, and accepts 0 < usd <= 1000. Each top-up is journaled (`paper_funded`) and `perp-report` prints the total: P&L = equity change minus top-ups.

## Economic calendar (operator-maintained)
`config/perp-calendar.json` is a JSON array of `{"at": "2026-11-05T19:00:00Z", "name": "FOMC rate decision", "impact": "high"}`. `impact` is `"high"` or `"medium"`; only `"high"` events drive the no-trade window and the stop tightening, `"medium"` ones are context for the model. Every `at` must carry an explicit UTC offset, either `Z` or `+hh:mm` / `-hh:mm` (for example `2026-11-05T14:00:00-05:00`). A timestamp without one (`2026-11-05T19:00:00`) is rejected by the loader, because it would be read in the machine's local zone. Fill it from federalreserve.gov (FOMC) and bls.gov (CPI, jobs report). A missing/invalid file stops the bot from starting and makes every tick fail; a file covering fewer than 7 days raises a daily alert. Re-check monthly.

## News prefilter (PERP_PREFILTER)
What it does: a code-only filter in front of the Haiku news gate, so most items never cost a model call. Per item: source class (`official_macro` always passes; `market_wire` passes at lexicon score >= 1; `press` and unlisted sources pass at score >= 3; `social` is dropped), then dedup (headline token sets with Jaccard >= 0.6, both sides at least 4 tokens, against an item that passed in the last 6 h) and cooldown (the item has at least one strong hit and all its strong hits were already seen in an item that passed in the last 2 h; a cooldown verdict also records `dupOf`), then the hourly caps (30 Haiku passes, 6 Sonnet escalations; `official_macro` bypasses the Haiku cap). Haiku no longer decides escalation: it returns an impact estimate (`none`/`minor`/`moderate`/`major` plus a reason) and code (`escalate`) decides whether Sonnet runs. `moderate`/`major` escalate; `minor` escalates only within +-2 h of a high-impact calendar event; `official_macro` escalates at `minor` or more; `major` and `official_macro` bypass the Sonnet cap. A prefilter exception fails closed (item dropped, journaled `prefilter_error`; five in one UTC day send one alert).

Files: `config/perp-prefilter.json` (source classes, lexicon, threshold, caps, windows; an invalid file stops the bot from starting when the prefilter is on), `src/perp/intake/prefilter.ts` (scoring, dedup, caps), `src/perp/intake/escalate.ts` (escalation rule). `PERP_PREFILTER_FILE` overrides the config path.

Kill switch: set `PERP_PREFILTER=off` in `~/executor_module/.env.perp` (the bot unit loads it: `EnvironmentFile=-%h/executor_module/.env.perp`), then `systemctl --user restart perp-bot`. Off restores the old FLOW, not the old cost: every item that passes hygiene goes to the Haiku gate and `relevant` alone decides extraction, and no `intake_item`/`intake_outcome` rows are journaled. The gate prompt is NOT reverted: Haiku now returns an impact rating (`relevant = impact !== 'none'`), so in off mode every `minor` also goes to Sonnet and the cost can be higher than the 2026-10-14 baseline, bounded by `PERP_DAILY_USD_CAP`. The start line shows `prefilter=on|off commit=<sha>`; after the restart it must show `prefilter=off` (and `prefilter=on` after you remove the setting and restart again).

Reading the journal: every item that reaches the prefilter gets an `intake_item` row (item id, source, source class, score, pass/drop and the reason `source_class_drop`/`low_score`/`duplicate`/`cooldown`/`haiku_cap`, hits, commit), and every item the gate decided on gets an `intake_outcome` row (impact, whether it escalated, reasons). mini-mac has no sqlite3 CLI, so use python read-only:

    python3 -c "import sqlite3; c=sqlite3.connect('file:data/perp/perp-paper.db?mode=ro', uri=True); [print(r[0]) for r in c.execute(\"SELECT payload FROM journal WHERE kind='intake_item' ORDER BY id DESC LIMIT 20\")]"

Replay (read-only, writes nothing): `cd ~/executor_module-perp && npm run perp-prefilter-replay -- --hours 6` replays the last N hours of `iip:items` through the current config and prints the funnel. Use it before changing `config/perp-prefilter.json`. Reference run before the change (6 h, 2026-10-14, config version 1 as shipped): 738 items, 730 evaluated after hygiene, 38 passed (5.2%); dropped: `source_class_drop` 371, `low_score` 303, `cooldown` 18, `duplicate` 0; social passes 0.

Change date: the bot's 4-week paper phase began 2026-10-14. The prefilter changes intake behaviour mid-phase (which news reaches the models and how Sonnet is triggered); trading rules, thresholds, policy and stops are unchanged. Deployed on: **2026-10-15 10:10 PDT** (perp-bot restarted with `prefilter=on commit=d11a073`; intake-lab started the same minute and restarted at 10:20 PDT on `0bbbc58` after the network fix below). Treat paper results before and after that date as two intake regimes when reviewing Phase 1.

## Intake lab (7-day prefilter audit)
What it is: a shadow process (`intake-lab`) that measures what the news prefilter drops. It never trades, places no orders and reads no live keys. For every IIP item it logs the production prefilter verdict plus three rule variants (`strict3`, `loose1`, `social_ok`) to its own database, then audits a small sample of the dropped items with Sonnet (the bot's own impact extraction, with the bot's newest snapshot as context) and counts a miss when Sonnet rates a dropped item `moderate`, `major` or `shock`. After `LAB_DAYS` days it stops all model spend, keeps logging features, writes the report once and sends one `[PERP-LAB]` Slack alert. It reads the bot's ledger `data/perp/perp-paper.db` read-only (prices for the second signal, snapshots for the audit context) and never writes to it.

Unit: `deploy/mini-mac/intake-lab.service` (paper-pinned on the ExecStart line like `perp-bot.service`; sandboxed; writes only under `data/`). Install and start:

    cp deploy/mini-mac/intake-lab.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now intake-lab

Deploy it together with the bot: restart `perp-bot` and `intake-lab` in the same step so both run the same commit (the start line `[perp-lab] starting ... commit=<sha>` and every `items` row carry it). The lab refuses to start unless `PERP_MODE=paper` is pinned and `PERP_LIVE` is unset. A restart is harmless but the prefilter's dedup/cap state is in memory and cold after it; each start is recorded and listed in the report ("Lab process starts"), and `prod_*` columns may under-report duplicates for a few hours after one.

Tunables (optional, `~/executor_module/.env.perp`): `LAB_DAILY_USD_CAP` (default 0.50, at most 2; UTC day, paced to `min(cap, cap/24 x (h+2))` on UTC hour `h`), `LAB_DAYS` (default 7), `LAB_SEED` (sampler seed), `LAB_BOT_DB` (bot ledger path; default `data/perp/perp-paper.db`), `LAB_DATA_DIR`, `PERP_PREFILTER_FILE`, `LAB_WALL_SLOT` (the tile's slot, default 10).

Data: `data/perp/lab.db` (SQLite, WAL) with tables `items` (one row per logged item: source, class, lexicon score, production verdict and reason, variant verdicts, price mark, `ret_1h`/`ret_4h`), `audits` (one row per Sonnet audit: stratum, random/boundary, bucket, miss, cost, ok), `heartbeat`, `meta` (`report_done`, `start_<ms>` rows) and `model_calls` (the audit spend, which `callJson`'s daily cap reads). Query it read-only with python (mini-mac has no sqlite3 CLI):

    python3 -c "import sqlite3; c=sqlite3.connect('file:data/perp/lab.db?mode=ro', uri=True); [print(r) for r in c.execute('SELECT prod_reason, COUNT(*), SUM(prod_pass) FROM items GROUP BY prod_reason')]"
    python3 -c "import sqlite3; c=sqlite3.connect('file:data/perp/lab.db?mode=ro', uri=True); [print(r) for r in c.execute('SELECT stratum, kind, COUNT(*), SUM(miss) FROM audits WHERE ok=1 GROUP BY stratum, kind')]"

Report: written automatically on day 7 to `data/perp/intake-lab-week1.md` (the only writable directory under the unit's sandbox); regenerate it any time, read-only on both databases:

    cd ~/executor_module-perp && npm run intake-lab-report -- --lab data/perp/lab.db --bot data/perp/perp-paper.db --out data/perp/intake-lab-week1.md

Scope: the lab audits prefilter drops only. Items the prefilter passes and Haiku rates `minor` that the code does not escalate (`not_escalated`) are journaled by the bot (`intake_outcome`, `escalated:false`) but not audited by the lab.

### Deploy checklist
1. Switch or fast-forward the checkout (`~/executor_module-perp`) to the branch commit to deploy.
2. `systemctl --user restart perp-bot`
3. `cp deploy/mini-mac/intake-lab.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now intake-lab`
4. Confirm both start lines show the SAME `commit=`, and the bot line shows `prefilter=on`: `journalctl --user -u perp-bot -n 20 --no-pager` and `journalctl --user -u intake-lab -n 20 --no-pager`.
5. After 1-2 hours verify the audit chain actually works. With python `mode=ro` on `data/perp/lab.db`:

       python3 -c "import sqlite3; c=sqlite3.connect('file:data/perp/lab.db?mode=ro', uri=True); print(c.execute('SELECT COUNT(*), COALESCE(SUM(ok),0) FROM audits').fetchone())"

   The count must be > 0 with ok rows. If the count of `ok=1` stays 0, look at `SELECT error FROM audits WHERE ok=0 LIMIT 3` and at the age of the newest `snapshots` row in `data/perp/perp-paper.db` (the lab needs one younger than 10 minutes; the bot saves one every `PERP_FULL_SNAPSHOT_MS`, default 5 min).
6. The tile's Audited chip moves.
7. Fill in the "Deployed on" date in the prefilter section above.

**Network note (found at the first deploy, 2026-10-15).** From mini-mac, Node's default connection setup failed every request to `api.anthropic.com` with `fetch failed | ETIMEDOUT` ("Connection error."): the API's IPv6 address is unreachable from this host and IPv4 connects take 1-5 s, longer than Node's 250 ms per-attempt window (curl, which retries differently, got through about 80% of the time). The lab therefore calls `preferIpv4()` (`src/perp/ops/network.ts`: IPv4 first, 5 s per attempt) at startup; with it all test calls succeeded in about 1 s. The first 13 audits (made before this fix) are recorded with `ok=0` and the error `Connection error.`; they are excluded from every estimate. The bot itself (`src/perp/main.ts`) does not call `preferIpv4()` yet and shows the same errors at a lower rate (`intake_error` and `tick_error` journal rows): if you see them, apply the same one-line call at the top of the bot's `main()`. Diagnosis: a 4-call script with `maxRetries: 0` run under default settings versus after `preferIpv4()`.

If the tile's Bot DB light is red, `systemctl --user restart intake-lab`: the lab opens the bot ledger once at start.

Tile: wall slot 10 (`LAB_WALL_SLOT`), published by `~/wall/intake-lab-publish.py` (outside git, read-only). Stop the lab: `systemctl --user disable --now intake-lab` (the data stays; the report script still works on it).

## Phase 0 (before any order): run `npm run perp-verify` and record the answers here
- [ ] Trading hours and any daily break confirmed (next close seen: Fri 5 pm ET).
  - 2026-10-14: next close confirmed Fri 2026-10-16 21:00 UTC (5 pm EDT). `next_open_ts` is null while open, so the reopen time and any daily break are NOT known; observe the first Friday close/reopen (prod and demo).
- [x] Each collector (Kalshi margin API, FRED, news/IIP stream, calendar file) confirmed available, with its latency noted.
  - 2026-10-14: Kalshi margin API ok (~0.3 s); FRED CSV ok (~0.2 s, no key, data lags ~1 day: last SP500/VIX row 2026-10-13); IIP `iip:items` fresh (newest item <1 min old, 83k items); Stooq NOT usable; calendar file filled (8 events through 2027-01-13, coverage 90.8 days).
- [ ] Perp price tracks the S&P 500 (ratio to FRED SP500 is ~constant); contract price mapping understood.
  - 2026-10-14: ratio perp/SP500 ~0.001756-0.001768 (about SPX/566), ~0.7% spread under both same-date and previous-date alignment. WEAK evidence: SPX was nearly flat over the window. Re-check after a larger move. Mapping unexplained: `contract_size` 0.001 x index is ~7.8, not the ~13.7 price.
- [ ] Funding payer confirmed on the demo exchange (set `fundingLongPays` accordingly in `src/perp/broker/paper.ts` if it is the opposite).
  - 2026-10-14 21:02 UTC: demo holds 1 long (subaccount 1) and 1 short (primary) of KXUS500PERP1 to be read after the next settlement (2026-10-15 20:00 UTC) with `GET /margin/funding_history` (`funding_amount`: positive = received, negative = paid, with `quantity` signed). The current estimate is 0 (inside the deadband); if the settlement rate is 0, keep holding until a nonzero one. Close both demo positions afterwards.
- [ ] Liquidation margin ratio definition confirmed with `/margin/risk` on a demo position.
  - 2026-10-14: 1 long at 13.49 in a $4.95 subaccount: maintenance 0.6771 (5.02% of notional), initial 0.8594 (1.27x maintenance), reported liquidation 9.0168. Back-solving that price gives a threshold factor of ~1.055 on maintenance/equity: consistent with liquidation near maintenance = equity, not exact (fees, rounding, mark vs liquidation mark). `account_leverage`/`position_leverage` (19.9) are notional / maintenance-based, NOT realized leverage (13.49 / 4.95 = 2.7x). Not ticked until the bot's liquidation-distance math is checked against a second reading.
- [x] Isolated vs cross exit-trigger path confirmed (`PERP_TRIGGER_MODE`).
  - 2026-10-14 (demo): for a position in a numbered subaccount the trailing stop works ONLY on the cross path (`PUT /margin/cross/positions/{ticker}/exit_trigger?subaccount=1`; `trail_bps` and `trail_amount` both accepted, readback via GET). The isolated path returns 400 "no open position on this slot" (also for the primary account). `PERP_TRIGGER_MODE` defaults to `isolated` (`src/perp/startup.ts:58`), so demo/live REQUIRE `PERP_TRIGGER_MODE=cross`; with the default every entry would fail to set its stop and be closed again (the fail-safe worked in the probe). Set in `.env.perp-demo`; add to `.env.perp-live`.
- [x] Subaccount isolation confirmed (two subaccounts do not net).
  - 2026-10-14 (demo): long 1 in subaccount 1 and short 1 in the primary account coexist as two separate positions with their own margin and liquidation prices.
- [ ] Demo account + API key created; `perp-bot-demo.service` rehearsal run: open, trailing stop fires, forced margin-guard exit, restart with an open position.
- [x] Price-rule backtest recorded (`docs/perp-backtest-2026-10-14.txt`).
  - Caveats: ~10 years (FRED limit, not 15); close-to-close, so stop-out/liquidation rates are understated.

Phase 0 status 2026-10-14 (updated 21:05 UTC): prod subaccount 1 created (unfunded); demo RSA key + ID stored on mini-mac (`~/.kalshi-demo-key.pem`, `~/executor_module/.env.perp-demo`). Margin trading is now enabled on the demo account; demo subaccount 1 exists with $5 of play money (`PERP_SUBACCOUNT=1`, `PERP_TRIGGER_MODE=cross` in `.env.perp-demo`). Demo mechanics probed with the real broker calls: orders, positions, `/margin/risk`, cross trailing stop, subaccount isolation. Open: funding payer (waiting for the 2026-10-15 20:00 UTC settlement), hours/daily break, S&P tracking, and the `perp-bot-demo.service` rehearsal (trailing stop fires, forced margin-guard exit, restart with a position).

## Phase 1 gates (paper, at least 4 weeks) — correctness, not profit
- [ ] Zero accounting or state bugs (equity in `perp-report` reconciles with the exit rows).
- [ ] Every exit traceable to a rule in the journal (`close`/`broker_event` rows with reasons).
- [ ] Restart with an open paper position tested at least once; stale-data and Redis-outage behavior observed.
- [ ] Calibration table reviewed; `bucketMove` and thresholds in `PERP_CONFIG_JSON` updated from measured values if the data supports it.
- [ ] The first spend-cap and calendar alerts were seen to work.
The 41-day IIP archive and the perp's short history cannot prove an edge; the paper run is the evaluation.

## Going live (needs the user's explicit approval each time)
1. Fund a dedicated subaccount with about $3.50 for one contract at ~4x (the bot never moves money; $5 realizes ~2.75x).
2. Only once every Phase 0 and Phase 1 box above is ticked (do not start this step with any box open): create `~/.config/systemd/user/perp-bot-live.service` by copying `perp-bot.service` and changing: the ExecStart pin from `/usr/bin/env -u PERP_LIVE -u NODE_OPTIONS PERP_MODE=paper` to `/usr/bin/env -u NODE_OPTIONS PERP_MODE=live` (DROP `-u PERP_LIVE`: live mode needs `PERP_LIVE` from the env file; keep `-u NODE_OPTIONS`), `EnvironmentFile=%h/executor_module/.env.perp-live` (required, no `-`), `SyslogIdentifier=perp-bot-live`. In `.env.perp-live` set `PERP_SUBACCOUNT=<n>`, `PERP_TRIGGER_MODE=cross` (the default `isolated` cannot protect a subaccount position) and `PERP_LIVE=KXUS500PERP:<n>`. The first live order requires the user's approval at that moment.
3. Watch the first trade by hand; confirm the trailing stop exists on Kalshi right after the fill.

## Off switch
`systemctl --user disable --now perp-bot` (and the demo/live units). For a real position, close it in the Kalshi UI first, or leave the exchange-side trailing stop in place.

## Known gaps before demo/live
Deferred from the final review; each needs fixing or an explicit decision before the demo rehearsal or live money:
- Broker internals (`kalshiMarginBroker.ts`): a pending `expected` exit classification is overwritten by a reopen; the fills window can mix a previous trade's fills into the next classification; `closeBestEffort` counts a later "no open position" (already flat) as a failure; `close()` throws after really closing when no P&L can be derived; an unknown-outcome open that finds an opposite-side position is only reported, not handled.
- `summarizeContext` (model context) omits funding, realized volatility, the VIX change, the position's high-water mark and the liquidation distance.
- Model rationale text is not sanitized before it goes into Slack alerts.
- The funding estimate is not persisted across restarts: a paper settlement right after a restart may be charged with the new period's estimate instead of the last pre-settlement one.
- No snapshot retention: the `snapshots` table grows without bound.
- The response of the trigger PUT (trailing stop) is not inspected; a 2xx with an unexpected body counts as success.
- No reopen-gap log (the price gap between the weekly close and the reopen is not recorded).
- Halt-clear race: a tick already in flight when `perp-clear-halt` runs may still act on the old risk state once.
- Remaining test gaps: no end-to-end test of `main.ts` wiring (heartbeat, silence alert, collector caching), and the paper quote used by paper open/close/poll still throws when a closed market publishes no bid/ask.

## Known limits
- Paper liquidation fills at the mark with no penalty (optimistic). Paper funding sign is assumed (longs pay) until verified.
- FRED macro series (VIX, yields, spreads) lag by about a day; the bot uses VIX only to size volatility. Fresher VIX/S&P data is a possible later addition.
- Free-text news is a noisy edge: shocks are rare, model confidence is uncalibrated until measured.
- Short parameters (higher bar, weekend rule) are reasoned defaults, not measured.
