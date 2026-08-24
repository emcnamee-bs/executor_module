# executor_module

**READ `HANDOFF.md` IN THIS DIRECTORY BEFORE DOING ANYTHING ELSE.** It is the entry
point: what this project is, the sibling project it depends on, the Redis stream
contract it consumes, what execution infrastructure may already exist elsewhere on this
machine, and the concrete build map. This file is only a pointer.

Note: the global `~/.claude/CLAUDE.md` on this machine is **BrightSign** context and has
**nothing to do with this project**. Ignore it here.

## What this is, in one line

The live AI-driven trading system for Kalshi market `KXAPRPOTUS-26AUG28` (and whatever
follows it) — news scan → keyphrase match → Haiku synopsis → Sonnet verify → Sonnet
decides the trade → real order execution. Real money from the point execution is wired
up. Nothing here is a simulation by default.

## Non-negotiables (full detail in HANDOFF.md §§1–2)

- **Do not modify anything under `/Users/eamonmcnamee/Downloads/Internet_Info_Plug`.**
  That project's `executor/` is deliberately, structurally incapable of live trading —
  it is not a starting point and must not be extended, imported from, or have its safety
  guards loosened. This repo is the separate place that capability belongs.
- **No market-specific keyword, rule, or resolution-condition logic goes anywhere except
  this repo.** `Internet_Info_Plug/iip/` enforces the opposite rule on purpose — keep it
  that way from this side too.
- **Credential hygiene is absolute from the first line of code:** never commit a
  `kalshi_key.pem` or anything containing `-----BEGIN`; never hardcode a key ID or path
  as a fallback default; read credentials from env vars or a git-ignored `.env`; add
  `.gitignore` entries for all of it before writing any credential-adjacent code, not
  after.
- **Before writing a Kalshi client from scratch**, check whether `Fast99Follower/`,
  `InsiderTradeFollower/`, `Personal_Fingerprinter/`, or `kalshi-spine/` (all siblings
  under `~/Downloads/`) already have a working, signed one worth reusing.
- **Confirm the target market's real resolution mechanics from Kalshi directly** before
  building signal or sizing logic around an assumption of how it settles.

## The one law worth internalising

Carried over from the sibling project's own hard-won experience: **a guard that fires
correctly and says something it never checked is the recurring defect to watch for.**
Here that failure mode is a real order placed on bad information, or a risk check that
looks wired but isn't — so for every value that travels from the news scanner through to
an order (a match, a synopsis, a verified fact, a decision, a size), have at least one
test that drives the real call site end-to-end, not just the function in isolation.
