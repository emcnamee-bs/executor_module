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
- Cadence: `PERP_TICK_MS` (default 15000, min 5000) is the tick: every tick collects a fresh perp quote, polls the broker and runs every exit rule. `PERP_FULL_SNAPSHOT_MS` (default 300000, must be >= the tick) is the full snapshot: only then is the 8-day price history re-read from the database and a snapshot row stored; light ticks reuse the cached history and write no row. Macro (FRED) refreshes every 15 min and Kalshi event markets every 5 min regardless. Model (token) spend does not depend on either: it is driven by IIP news volume and capped by `PERP_DAILY_USD_CAP`.
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

## Phase 0 (before any order): run `npm run perp-verify` and record the answers here
- [ ] Trading hours and any daily break confirmed (next close seen: Fri 5 pm ET).
- [ ] Each collector (Kalshi margin API, FRED, news/IIP stream, calendar file) confirmed available, with its latency noted.
- [ ] Perp price tracks the S&P 500 (ratio to FRED SP500 is ~constant); contract price mapping understood.
- [ ] Funding payer confirmed on the demo exchange (set `fundingLongPays` accordingly in `src/perp/broker/paper.ts` if it is the opposite).
- [ ] Liquidation margin ratio definition confirmed with `/margin/risk` on a demo position.
- [ ] Isolated vs cross exit-trigger path confirmed (`PERP_TRIGGER_MODE`).
- [ ] Subaccount isolation confirmed (two subaccounts do not net).
- [ ] Demo account + API key created; `perp-bot-demo.service` rehearsal run: open, trailing stop fires, forced margin-guard exit, restart with an open position.
- [ ] Price-rule backtest recorded (`docs/perp-backtest-2026-10-14.txt`).

## Phase 1 gates (paper, at least 4 weeks) — correctness, not profit
- [ ] Zero accounting or state bugs (equity in `perp-report` reconciles with the exit rows).
- [ ] Every exit traceable to a rule in the journal (`close`/`broker_event` rows with reasons).
- [ ] Restart with an open paper position tested at least once; stale-data and Redis-outage behavior observed.
- [ ] Calibration table reviewed; `bucketMove` and thresholds in `PERP_CONFIG_JSON` updated from measured values if the data supports it.
- [ ] The first spend-cap and calendar alerts were seen to work.
The 41-day IIP archive and the perp's short history cannot prove an edge; the paper run is the evaluation.

## Going live (needs the user's explicit approval each time)
1. Fund a dedicated subaccount with about $3.50 for one contract at ~4x (the bot never moves money; $5 realizes ~2.75x).
2. Only once every Phase 0 and Phase 1 box above is ticked (do not start this step with any box open): create `~/.config/systemd/user/perp-bot-live.service` by copying `perp-bot.service` and changing: the ExecStart pin from `/usr/bin/env -u PERP_LIVE -u NODE_OPTIONS PERP_MODE=paper` to `/usr/bin/env -u NODE_OPTIONS PERP_MODE=live` (DROP `-u PERP_LIVE`: live mode needs `PERP_LIVE` from the env file; keep `-u NODE_OPTIONS`), `EnvironmentFile=%h/executor_module/.env.perp-live` (required, no `-`), `SyslogIdentifier=perp-bot-live`. In `.env.perp-live` set `PERP_SUBACCOUNT=<n>` and `PERP_LIVE=KXUS500PERP:<n>`. The first live order requires the user's approval at that moment.
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
