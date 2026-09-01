# Deployment to mini-mac — Design

## Goal

`executor_module` is fully built — Redis consumer, keyphrase match, the Haiku/Sonnet
decision pipeline, a real Kalshi execution client, and all four risk-control layers
(circuit breakers, alerting, P&L tracking, rate limiting) — but has never run anywhere
except this dev Mac's own test suite and dry-run rehearsals. This is item 9 from
`HANDOFF.md` §3, the last thing standing between this project and actually trading: get
it running unattended, durably, on real hardware, consuming the real `iip:items` stream
produced by `Internet_Info_Plug` on `ai1`.

This spec covers getting the process running continuously on `mini-mac` with
`KALSHI_DRY_RUN=true` (a full rehearsal against the real stream and real model calls,
but no real orders) as the state this deployment leaves the system in. Flipping to real
money is a separate, explicit, later decision — walking through `HANDOFF.md`'s own
already-written §5a.2 pre-go-live checklist — not something this deployment does on its
own.

## Decisions made during brainstorming

1. **Target host: `mini-mac`**, a local Ubuntu 26.04 LTS box (`emac@mini-mac.local`,
   192.168.1.49, 4 cores, 13 GiB RAM, 433 GiB free disk), not `ai1`. Despite the name,
   confirmed via SSH to be Linux, not macOS — the `ai1` systemd-user-unit deployment
   pattern applies directly, no `launchd` translation needed. Access is via a dedicated
   no-passphrase deploy key (`~/.ssh/mini_mac_deploy` on this Mac), matching the existing
   `ai1_deploy` key's pattern, installed via `ssh-copy-id`. `mini-mac` has no passwordless
   `sudo` — every `sudo`-gated step in this deployment needs a human at a real terminal,
   same constraint `ai1`'s own runbook already documents for the same reason.

2. **Redis relocates from `ai1` to `mini-mac`, bridged over Tailscale.** `iip` (the
   producer) stays on `ai1` and cannot move — it's `Internet_Info_Plug`'s deployment, out
   of scope here. `ai1`'s Redis was found bound to `127.0.0.1` only (protected-mode,
   no password) — unreachable from anywhere else on the network. Rather than bridge
   `mini-mac` to `ai1`'s existing Redis, the operator chose to relocate Redis itself to
   `mini-mac`, which requires `ai1` to reach `mini-mac` over the network. `ai1` has no LAN
   or public-IP path to `mini-mac` (it's only reachable at all via Tailscale, per
   `Internet_Info_Plug/deploy/ai1/README.md`), so `mini-mac` joins the same tailnet.
   **This is an explicit, operator-authorized exception to this project's standing "never
   modify `Internet_Info_Plug`" rule**, narrowly scoped to one line of `ai1`'s deployed
   configuration (`iip.service`'s `--redis-url` flag) — not its code, not its market-
   ignorance boundary, not `executor/`. Both the deployed unit on `ai1` and the git-
   tracked source (`Internet_Info_Plug/deploy/ai1/iip.service`) get the same one-line
   change, so the repo stays the source of truth rather than drifting from what's
   actually running.

3. **Redis gets `requirepass`, not just tailnet-membership as the access boundary.**
   This stream feeds live trading decisions directly — an unauthenticated Redis reachable
   by anything on the tailnet is a real integrity risk (a stray or malicious write could
   inject fabricated news items straight into the decision pipeline), not merely a
   convenience gap. A generated password, stored the same way every other credential in
   this project is (git-ignored, env-var only, never hardcoded, per `HANDOFF.md` §2),
   closes that gap at the DB layer rather than relying on network topology alone.

4. **`REDIS_URL` needs no code change.** `src/redis/client.ts:4` already reads
   `process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0'` — the standard `redis://` URL
   format carries an embedded password (`redis://:<password>@<host>:<port>/0`) natively.
   This deployment is pure configuration, zero application code changes.

5. **Deploy mechanism: git bundle + scp, matching `ai1`'s own precedent exactly.**
   `executor_module` is a private GitHub repo; `mini-mac` gets no GitHub credential for
   the same reason `ai1` didn't — a bundle carries full history over the SSH connection
   already established, leaving no credential behind on the box. Updates later use the
   same bundle-then-`git pull` two-step `ai1`'s runbook documents.

6. **Node 20 LTS via NodeSource's apt repo, not `nvm`.** `package.json` declares
   `"engines": {"node": ">=20"}`. A systemd unit's `ExecStart` needs a stable, sudo-
   installed binary path (`/usr/bin/node`); `nvm`'s per-user shell-sourced version
   selection doesn't resolve inside a unit file without extra indirection. (Aside, not
   fixed here: this dev Mac's own `direnv`-loaded environment currently runs Node
   18.18.2, below the stated floor — `mini-mac` is provisioned to the *stated*
   requirement, not the dev machine's actual, already-inconsistent version.)

7. **`executor_module`'s systemd unit is modeled directly on `iip.service`.** Same
   shape: `Type=simple`, `Restart=always` / `RestartSec=10`, the same
   `StartLimitIntervalSec=3600` / `StartLimitBurst=30` restart-storm circuit breaker
   (so a crash loop trips the unit into `failed` and stays visibly failed rather than
   restarting forever quietly), the same hardening block (`NoNewPrivileges`,
   `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths`
   scoped to just this project's `data/` and `logs/`, the rest of the same lockdown
   directives), unbuffered journald logging. A **user** unit (`~/.config/systemd/user/`),
   not a system unit — the process owns only its own files and needs no elevated
   capability to run, matching `iip.service`'s own reasoning for the same choice.
   Secrets live in a git-ignored `EnvironmentFile=` (mode 600), never inlined into the
   unit file itself — `main.ts` already fails loudly at startup naming any required
   variable that's absent (`HANDOFF.md` §5a.1), so a missing `EnvironmentFile` fails the
   same way a missing variable already does, not silently.

8. **Rollout stays in dry-run until an explicit, separate go-ahead.** The unit starts
   with `KALSHI_DRY_RUN=true` in its `EnvironmentFile`. This deployment's job is proving
   the whole pipeline runs unattended against the real stream and real model calls —
   `npm run smoke` plus the full `HANDOFF.md` §5a.2 pre-go-live checklist (already
   written, unchanged by this spec) get run from `mini-mac` itself once the unit is up.
   Flipping `KALSHI_DRY_RUN` off is a distinct, later, explicitly-confirmed step — not
   something "deployment complete" implies. Matches this project's own stated philosophy
   (`HANDOFF.md` §3.8): going live must be structurally hard to do by accident.

9. **Copying the Kalshi private key to `mini-mac` gets its own explicit confirmation,
   separate from this plan's overall approval.** The canonical key
   (`~/.kalshi-spine/kalshi_key.pem` on this Mac, mode 600) has never left this machine.
   Moving a real-money-capable signing credential to another box is exactly the kind of
   irreversible, security-sensitive action this project's own standing instructions say
   to stop and confirm before doing — asked for at the moment it actually happens, in the
   execution runbook, not folded into a blanket yes now.

## Architecture

**Network:** `mini-mac` joins the same Tailscale tailnet `ai1` is already on. Redis on
`mini-mac` binds to its tailscale interface plus `127.0.0.1`, `requirepass` set.
`ai1`'s `iip.service` `ExecStart` gains `--redis-url redis://:<password>@<mini-mac
tailscale IP>:6379/0`. `executor_module` on `mini-mac` connects to its own Redis via
`REDIS_URL=redis://:<password>@127.0.0.1:6379/0` — same box, no tailnet hop needed for
the consumer side.

**Files added to this repo:**
- `deploy/mini-mac/executor-module.service` — the systemd user unit, structured per
  decision 7 above.
- `deploy/mini-mac/README.md` — the provisioning + deploy + verify runbook, in the same
  style as `Internet_Info_Plug/deploy/ai1/README.md`: prerequisites table, numbered
  deploy steps (each copy-pasteable), a "what to check to confirm it's actually working"
  section, an update procedure.
- `HANDOFF.md` — §3's item 9 gets marked resolved with a pointer to the new runbook; a
  new operator-runbook subsection (`§5a.4`, alongside the existing `§5a.1`–`§5a.3`)
  documents the Redis-relocation topology and where secrets live on `mini-mac`, since an
  operator debugging a connectivity issue needs to know Redis no longer lives where
  `HANDOFF.md`'s Redis-stream section (§1.2) might otherwise imply.

**File changed outside this repo (explicitly authorized, decision 2):**
- `Internet_Info_Plug/deploy/ai1/iip.service` — one line (`ExecStart`'s `--redis-url`
  flag added), plus its deployed copy on `ai1` under `~/.config/systemd/user/`.

**No application code in `src/` changes** (decision 4).

## Data flow

```
ai1:  iip daemon (unchanged code, one new CLI flag)
        --redis-url redis://:<password>@<mini-mac-tailscale-ip>:6379/0
        --------------------------------------------------------------> (Tailscale)

mini-mac:
  redis-server (bound to tailscale0 + 127.0.0.1, requirepass)
        <---- XADD iip:items ---- (from ai1, over Tailscale)
        ----  XREADGROUP  ---->  executor_module (systemd user unit, KALSHI_DRY_RUN=true)
                                    -> keyphrase match -> Haiku synopsis -> Sonnet verify
                                    -> Sonnet decide -> sizing -> simulated order (dry run)
                                    -> data/decisions.db (SQLite, local to mini-mac)
```

## Execution approach (not a normal SDD task breakdown)

Unlike the prior four risk-control slices, most of this work is live, human-gated
infrastructure operation on real remote hardware — installing packages that need
interactive `sudo`, one-time interactive Tailscale browser auth, copying a real signing
credential — not isolated, locally-testable code changes a fresh subagent can execute
and a reviewer can verify against a diff. The repo-file deliverables (the unit file, the
README runbook, the `HANDOFF.md` update) are normal tracked changes and get written
directly with the same care as any other doc/config change in this project, but this
plan is executed by the controller directly, step by step, with the operator in the loop
for every `sudo`-gated and credential-gated step — not dispatched to implementer
subagents.

## Testing / verification plan

No new unit tests — this is infrastructure, not application logic, and `REDIS_URL`'s
parametrization is already covered by `src/redis/client.ts`'s existing tests. Verification
is operational, mirroring `Internet_Info_Plug`'s own "prove it before it runs
unattended" discipline:

- `ai1`'s `iip` daemon reconnects cleanly after its `iip.service` restart (check its
  journal for a successful Redis connection, no new `[DEBUG]`/error spam).
- `XLEN iip:items` on `mini-mac`'s Redis actually grows over a few minutes — proof the
  daemon is really writing to the new location, not silently falling back to its
  outbox.
- `executor_module`'s unit is `active (running)` on `mini-mac`, its journal shows items
  being consumed and decisions being recorded in `data/decisions.db` (`would_trade = 0`
  throughout, since `KALSHI_DRY_RUN=true`).
- `npm run smoke` passes from `mini-mac` (proves the Kalshi credentials, PEM, and RSA-PSS
  signing all work together against the live API, read-only, per `HANDOFF.md` §5a.2 step
  1 — this validates real-order readiness without placing one).
- The unit survives a reboot: `loginctl show-user emac` on `mini-mac` shows
  `Linger=yes` after the one-time `sudo loginctl enable-linger emac`.

Going live with real money (unsetting `KALSHI_DRY_RUN`) is explicitly out of scope for
"deployment done" — that's `HANDOFF.md` §5a.2's remaining checklist items (2–7),
walked through live, later, on the operator's own go-ahead.

## Credential hygiene / non-negotiables reaffirmed

- The Kalshi private key copy to `mini-mac` gets its own explicit confirmation at the
  point it happens (decision 9) — not assumed from this spec's approval.
- Every secret on `mini-mac` (`KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`,
  `ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`, the Redis password inside `REDIS_URL`) lives
  in a git-ignored, mode-600 `EnvironmentFile`, never in the unit file, never committed,
  never logged.
- No market-specific logic is introduced or touched by this deployment — it's pure
  infrastructure plumbing for code that already exists.
- The one deliberate exception to "never modify `Internet_Info_Plug`" is scoped to
  exactly one deployment-config line, explicitly authorized by the operator (decision
  2), and is not a precedent for touching that repo's code, its market-ignorance
  boundary, or `executor/`.
