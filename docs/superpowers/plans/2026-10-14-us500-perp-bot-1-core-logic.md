# US500 Perp Bot — Plan 1: Core Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, fully unit-tested decision core of the US500 long/short perp bot: config, quant formulas, decayed news pressure, volatility/leverage governor, cooldown and kill-switch rules, time windows, the entry/exit policy, and the SQLite store.

**Architecture:** A new `src/perp/` module in the executor repo. Everything in this plan is a pure function or a small class with no network or model calls, so every rule from the spec has a deterministic test. Plans 2 and 3 add the data/brokers and the engine around it.

**Tech Stack:** TypeScript (ESM, `NodeNext`, imports end in `.js`), zod 3, better-sqlite3, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-us500-perp-bot-design.md` (copy into the worktree in Task 1). Series: this is plan 1 of 3; plan 2 = `2026-10-14-us500-perp-bot-2-data-and-brokers.md`, plan 3 = `2026-10-14-us500-perp-bot-3-engine-and-ops.md`.

## Global Constraints

- Work only in the git worktree `~/executor_module-perp` (branch `feat/perp-bot`) on **mini-mac** (`ssh emac@mini-mac.local`). Do not edit `~/executor_module` main checkout, `~/Internet_Info_Plug`, the live `executor-module.service`, or any existing file under `src/` outside `src/perp/`.
- Never push or merge to `main`; never push anywhere without the user's explicit OK (the GitHub repo is public).
- Commits need explicit identity (mini-mac has none configured): `git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit ...` and end each message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Instrument `KXUS500PERP`; one contract; default leverage target 4; margin loss budget `B` = 20%; stop floor 3% / cap 5%; `sigmaK` 1.75; `s_soft` 3%; pressure decay `tau` 2 days; `P_entry_long` 1.5%; short bar 1.25x; `P_exit` 2%; weekend flat 30 minutes before the weekly close; no-trade window 5 minutes around scheduled high-impact events (all from the spec, sections 5.1-5.7 and 6).
- Maintenance margin used for liquidation math: long 0.0502, short 0.056 (spec section 2: initial margin = 1.3 x maintenance; max leverage 15.32 long / 13.74 short).
- No new runtime dependencies. Node >= 20, ESM, zod, better-sqlite3, vitest only.
- Money/price numbers are plain JS numbers (USD, fractions). Percent values are fractions (0.05 = 5%).
- Run tests on mini-mac from `~/executor_module-perp`: `npx vitest run test/perp/<file>`. The repo-wide baseline has 30 unrelated failing tests (Redis NOAUTH, API key, tsx loader); only `test/perp/**` must pass.

## Review Focus

Failure modes the spec implies but a straight reading of the rules would not exercise (each has a test in the named task):

1. VIX missing, zero or NaN: the governor must fall back and the policy must refuse new entries rather than size a stop from garbage (Task 4, Task 7).
2. A replayed/duplicate IIP item must not double-count news pressure (Task 3).
3. An item whose receive time is in the future (clock skew) must not affect pressure "now" (Task 3).
4. An item with no price at its publish time (`movedSincePublish === null`) must never trigger an entry, because lateness cannot be checked (Task 7).
5. After a loss the same contract is more levered than at entry; an entry whose realized leverage exceeds `1.05 x L_eff` must be refused (Task 7).

## File Structure

| File | Responsibility |
|---|---|
| `src/perp/types.ts` | Shared domain types (`Side`, `ImpactAssessment`, `PositionState`, `Snapshot`, `Action`, ...) |
| `src/perp/config.ts` | `PerpConfig` zod schema, `DEFAULT_CONFIG`, `loadPerpConfig(env)` |
| `src/perp/quant/formulas.ts` | sigma, stop fraction, liquidation distance, normal CDF, barrier-touch probability |
| `src/perp/quant/pressure.ts` | `PressureBook`: signed, decayed news pressure |
| `src/perp/risk/governor.ts` | `computeGovernor`: effective leverage and stop from volatility |
| `src/perp/risk/state.ts` | `RiskState`, cooldown/threshold updates after exits and entries |
| `src/perp/risk/killSwitch.ts` | `evaluateKillSwitch` |
| `src/perp/time/windows.ts` | weekly-close and event-window helpers |
| `src/perp/policy/policy.ts` | `decide`: the entry/exit rules as one pure function |
| `src/perp/store/db.ts` | SQLite schema + typed accessors (journal, state, exits, assessments, snapshots, equity) |
| `test/perp/*.test.ts` | one test file per module above |

---

### Task 1: Worktree, shared types, config

**Files:**
- Create: `src/perp/types.ts`, `src/perp/config.ts`, `test/perp/config.test.ts`
- Create (copied in): `docs/superpowers/specs/2026-10-14-us500-perp-bot-design.md` and the three plan files under `docs/superpowers/plans/`

**Interfaces:**
- Produces: everything in `types.ts` (below) and `config.ts` exports `PerpConfig` (type), `DEFAULT_CONFIG: PerpConfig`, `loadPerpConfig(env: NodeJS.ProcessEnv): PerpConfig`.

- [ ] **Step 1: Create the worktree and copy the docs in**

```bash
cd ~/executor_module && git worktree add ~/executor_module-perp -b feat/perp-bot main \
  && ln -s ~/executor_module/node_modules ~/executor_module-perp/node_modules \
  && mkdir -p ~/executor_module-perp/test/perp ~/executor_module-perp/src/perp \
  && cd ~/executor_module-perp && git log --oneline | head -1 && git status --short | head
```
Expected: the top commit of `main` (currently `0724f78`), and an empty `git status` (the `node_modules` symlink is git-ignored; if it shows as untracked, add `node_modules` to `.git/info/exclude`, not to a tracked file).

From the Windows PC (ermac), copy the spec and plans (if the copy is blocked by the auto-mode classifier, ask the user to approve it once):

```powershell
scp C:\Users\there\us500-bot\docs\superpowers\specs\2026-10-14-us500-perp-bot-design.md emac@mini-mac.local:executor_module-perp/docs/superpowers/specs/
scp C:\Users\there\us500-bot\docs\superpowers\plans\2026-10-14-us500-perp-bot-*.md emac@mini-mac.local:executor_module-perp/docs/superpowers/plans/
```

- [ ] **Step 2: Write `src/perp/types.ts`**

```ts
// src/perp/types.ts
export type Side = 'long' | 'short';
export type Direction = 'up' | 'down' | 'neutral';
export type Bucket = 'minor' | 'moderate' | 'major' | 'shock';
export type Horizon = 'intraday' | 'days' | 'week';

export type ExitRule =
  | 'trailing_stop' // exchange-side trailing trigger fired
  | 'liquidated'
  | 'margin_guard'
  | 'shock'
  | 'slow_bleed'
  | 'pressure'
  | 'weekend'
  | 'operator';

/** What the impact extractor concluded about one news item (plan 2 produces it). */
export interface ImpactAssessment {
  itemId: string;
  /** When the bot received the item; used for pressure decay. */
  receivedAtMs: number;
  /** Source publish time; used for the lateness check. */
  publishedAtMs: number;
  direction: Direction;
  bucket: Bucket;
  horizon: Horizon;
  credibility: number; // 0..1
  novelty: 'new' | 'known';
  alreadyPriced: 'yes' | 'no' | 'unclear';
  confidence: number; // 0..1
  rationale: string;
}

export interface PositionState {
  side: Side;
  contracts: number;
  entryPrice: number;
  entryTimeMs: number;
  /** Best mark since entry: the highest for a long, the lowest for a short. */
  extreme: number;
  /** Realized leverage at entry: notional / subaccount equity. */
  leverage: number;
  /** Distance of the exchange-side trailing stop, in basis points of the watermark. */
  stopBps: number;
  /** While set and in the future, the stop was deliberately tightened and must not be widened. */
  tightenedUntilMs: number | null;
}

export interface ScheduledEvent {
  tsMs: number;
  name: string;
  impact: 'high' | 'medium';
}

export interface MacroPoint {
  value: number;
  /** Absolute change vs the previous observation, null when unknown. */
  change1d: number | null;
  /** ISO date or timestamp of the observation. */
  asOf: string;
}

export interface Snapshot {
  tsMs: number;
  perp: {
    bid: number;
    ask: number;
    mark: number;
    marketOpen: boolean;
    /** Next scheduled close (ms epoch), null when the exchange does not say. */
    nextCloseTsMs: number | null;
    fundingEstimate: number | null;
  };
  returns: { d1: number | null; d5: number | null };
  realizedWeeklySigma: number | null;
  macro: Record<string, MacroPoint>;
  events: ScheduledEvent[];
  kalshiEvents: Array<{ ticker: string; yesProb: number }>;
  freshness: { perpAgeMs: number; macroAgeMs: number | null };
}

export type Action =
  | { kind: 'hold'; reasons: string[] }
  | { kind: 'open'; side: Side; leverage: number; stopFrac: number; triggerItemId: string; reasons: string[] }
  | { kind: 'close'; rule: ExitRule; reasons: string[] }
  | { kind: 'set_stop'; stopFrac: number; holdMs: number | null; reasons: string[] };
```

- [ ] **Step 3: Write the failing config test `test/perp/config.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, loadPerpConfig } from '../../src/perp/config.js';

describe('loadPerpConfig', () => {
  it('returns the spec defaults when no override is given', () => {
    const cfg = loadPerpConfig({});
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.ticker).toBe('KXUS500PERP');
    expect(cfg.leverageTarget).toBe(4);
    expect(cfg.lossBudget).toBe(0.2);
    expect(cfg.stopFloor).toBe(0.03);
    expect(cfg.stopCap).toBe(0.05);
    expect(cfg.maintenanceMargin).toEqual({ long: 0.0502, short: 0.056 });
    expect(cfg.allowLong && cfg.allowShort).toBe(true);
    expect(cfg.bucketMove).toEqual({ minor: 0.005, moderate: 0.015, major: 0.03, shock: 0.05 });
  });

  it('deep-merges PERP_CONFIG_JSON over the defaults', () => {
    const cfg = loadPerpConfig({
      PERP_CONFIG_JSON: JSON.stringify({ leverageTarget: 3, allowShort: false, bucketMove: { shock: 0.06 } }),
    });
    expect(cfg.leverageTarget).toBe(3);
    expect(cfg.allowShort).toBe(false);
    expect(cfg.bucketMove.shock).toBe(0.06);
    expect(cfg.bucketMove.minor).toBe(0.005);
    expect(cfg.lossBudget).toBe(0.2);
  });

  it('rejects invalid JSON, unknown keys and out-of-range values', () => {
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: '{nope' })).toThrow(/PERP_CONFIG_JSON/);
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ bogus: 1 }) })).toThrow();
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ leverageTarget: 0 }) })).toThrow();
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ lossBudget: 1.5 }) })).toThrow();
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ bucketMove: { nope: 0.1 } }) })).toThrow();
  });

  it('rejects a stop floor above the cap', () => {
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ stopFloor: 0.06 }) })).toThrow(/stopFloor/);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/config.test.ts`
Expected: FAIL (cannot resolve `../../src/perp/config.js`).

- [ ] **Step 5: Write `src/perp/config.ts`**

```ts
// src/perp/config.ts
import { z } from 'zod';

const frac = z.number().gt(0).lt(1);
const unit = z.number().min(0).max(1);
const posNum = z.number().gt(0);

const BaseSchema = z
  .object({
    ticker: z.string().min(1),
    allowLong: z.boolean(),
    allowShort: z.boolean(),
    leverageTarget: z.number().gt(0).max(20),
    lossBudget: frac,
    sigmaK: posNum,
    stopFloor: frac,
    stopCap: frac,
    softDrawdown: frac,
    maintenanceMargin: z.object({ long: frac, short: frac }).strict(),
    tauDays: posNum,
    pEntryLong: frac,
    shortBar: z.number().gte(1),
    pExit: frac,
    confLong: unit,
    confShort: unit,
    shockConfidence: unit,
    shockCredibility: unit,
    latenessMaxFrac: z.number().gt(0).max(1),
    weekendFlatMinutes: z.number().int().min(0),
    weekendHoldMult: z.number().gte(1),
    noTradeMinutesAroundEvents: z.number().int().min(0),
    eventTightenMinutes: z.number().int().min(0),
    cooldownHours: z.number().min(0),
    stopOutCooldownHours: z.number().min(0),
    reentryMult: z.number().gte(1),
    minLeverage: posNum,
    entryLeverageSlack: z.number().gte(1),
    killStopOuts30d: z.number().int().min(1),
    killDrawdown: frac,
    killExits24h: z.number().int().min(1),
    tightenSigmaDayMult: posNum,
    tightenFloor: frac,
    tightenHoldMinutes: z.number().int().min(0),
    resyncMinChange: frac,
    staleSnapshotMs: z.number().int().positive(),
    bucketMove: z.object({ minor: frac, moderate: frac, major: frac, shock: frac }).strict(),
    noveltyWeight: z.object({ new: unit, known: unit }).strict(),
    pricedWeight: z.object({ yes: unit, unclear: unit, no: unit }).strict(),
    horizonTauFactor: z.object({ intraday: posNum, days: posNum, week: posNum }).strict(),
  })
  .strict();

const ConfigSchema = BaseSchema.superRefine((c, ctx) => {
  if (c.stopFloor > c.stopCap) {
    ctx.addIssue({ code: 'custom', path: ['stopFloor'], message: 'stopFloor must not exceed stopCap' });
  }
});

const OverrideSchema = BaseSchema.deepPartial();

export type PerpConfig = z.infer<typeof BaseSchema>;

export const DEFAULT_CONFIG: PerpConfig = {
  ticker: 'KXUS500PERP',
  allowLong: true,
  allowShort: true,
  leverageTarget: 4,
  lossBudget: 0.2,
  sigmaK: 1.75,
  stopFloor: 0.03,
  stopCap: 0.05,
  softDrawdown: 0.03,
  maintenanceMargin: { long: 0.0502, short: 0.056 },
  tauDays: 2,
  pEntryLong: 0.015,
  shortBar: 1.25,
  pExit: 0.02,
  confLong: 0.6,
  confShort: 0.7,
  shockConfidence: 0.7,
  shockCredibility: 0.7,
  latenessMaxFrac: 0.4,
  weekendFlatMinutes: 30,
  weekendHoldMult: 1.5,
  noTradeMinutesAroundEvents: 5,
  eventTightenMinutes: 60,
  cooldownHours: 4,
  stopOutCooldownHours: 24,
  reentryMult: 1.2,
  minLeverage: 2,
  entryLeverageSlack: 1.05,
  killStopOuts30d: 2,
  killDrawdown: 0.3,
  killExits24h: 3,
  tightenSigmaDayMult: 1.5,
  tightenFloor: 0.01,
  tightenHoldMinutes: 120,
  resyncMinChange: 0.005,
  staleSnapshotMs: 180_000,
  bucketMove: { minor: 0.005, moderate: 0.015, major: 0.03, shock: 0.05 },
  noveltyWeight: { new: 1, known: 0.25 },
  pricedWeight: { yes: 0.3, unclear: 0.7, no: 1 },
  horizonTauFactor: { intraday: 0.25, days: 1, week: 1.5 },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/** Defaults, optionally overridden by the PERP_CONFIG_JSON env var (deep-merged, validated, unknown keys rejected). */
export function loadPerpConfig(env: NodeJS.ProcessEnv): PerpConfig {
  const raw = env.PERP_CONFIG_JSON;
  if (raw === undefined || raw.trim() === '') return ConfigSchema.parse(DEFAULT_CONFIG);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PERP_CONFIG_JSON is not valid JSON: ${(err as Error).message}`);
  }
  const override = OverrideSchema.parse(parsed) as Record<string, unknown>;
  return ConfigSchema.parse(deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, override));
}
```

- [ ] **Step 6: Run the test and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/config.test.ts && npx tsc --noEmit`
Expected: 4 tests pass; `tsc` prints nothing. (If `deepPartial` is missing in the installed zod, replace `BaseSchema.deepPartial()` with a hand-written partial of each nested object; keep the tests unchanged.)

- [ ] **Step 7: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp docs && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): shared types, config schema and defaults, spec and plans

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Quant formulas

**Files:**
- Create: `src/perp/quant/formulas.ts`, `test/perp/formulas.test.ts`

**Interfaces:**
- Consumes: `PerpConfig` (Task 1).
- Produces:
  - `DEFAULT_SIGMA_WEEK = 0.025`
  - `sigmaWeekFromVix(vix: number): number | null` (null for non-finite or <= 0)
  - `clamp(x: number, lo: number, hi: number): number` (`min(hi, max(lo, x))`: when `hi < lo`, `hi` wins)
  - `stopFraction(sigmaWeek: number, leverage: number, cfg: PerpConfig): number`
  - `liquidationDistance(leverage: number, mm: number): number`
  - `liqBoundLeverage(stop: number, mm: number): number`
  - `normalCdf(x: number): number`
  - `barrierTouchProbability(barrier: number, sigma: number): number`

- [ ] **Step 1: Write the failing test `test/perp/formulas.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import {
  barrierTouchProbability,
  clamp,
  liqBoundLeverage,
  liquidationDistance,
  normalCdf,
  sigmaWeekFromVix,
  stopFraction,
} from '../../src/perp/quant/formulas.js';

const cfg = DEFAULT_CONFIG;

describe('sigmaWeekFromVix', () => {
  it('is VIX/100/sqrt(52)', () => {
    expect(sigmaWeekFromVix(16)).toBeCloseTo(0.022188, 5);
    expect(sigmaWeekFromVix(20)).toBeCloseTo(0.027735, 5);
  });
  it('returns null for missing, zero, negative or non-finite VIX', () => {
    for (const bad of [0, -3, NaN, Infinity]) expect(sigmaWeekFromVix(bad)).toBeNull();
  });
});

describe('clamp', () => {
  it('clamps and lets hi win when the range is inverted', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0.02, 0.03, 0.0146)).toBe(0.0146);
  });
});

describe('stopFraction (spec 5.2)', () => {
  it('floats between 3% and the 5% cap with VIX at 4x', () => {
    expect(stopFraction(sigmaWeekFromVix(16)!, 4, cfg)).toBeCloseTo(0.038829, 5);
    expect(stopFraction(sigmaWeekFromVix(20)!, 4, cfg)).toBeCloseTo(0.048536, 5);
    expect(stopFraction(sigmaWeekFromVix(12)!, 4, cfg)).toBe(0.03); // floor
  });
  it('never exceeds the 5% cap even when volatility is high', () => {
    expect(stopFraction(sigmaWeekFromVix(25)!, 3.2965, cfg)).toBe(0.05);
    expect(stopFraction(sigmaWeekFromVix(40)!, 3, cfg)).toBe(0.05);
  });
  it('is limited by the margin-loss budget B/L at high leverage, below the floor', () => {
    expect(stopFraction(sigmaWeekFromVix(16)!, 13.7, cfg)).toBeCloseTo(0.2 / 13.7, 6);
  });
});

describe('liquidation helpers', () => {
  it('liquidationDistance = 1/L - MM', () => {
    expect(liquidationDistance(4, 0.0502)).toBeCloseTo(0.1998, 6);
    expect(liquidationDistance(13.74, 0.056)).toBeCloseTo(0.01678, 4);
  });
  it('liqBoundLeverage solves 2*stop <= 1/L - MM for L', () => {
    expect(liqBoundLeverage(0.0388, 0.0502)).toBeCloseTo(1 / (2 * 0.0388 + 0.0502), 6);
  });
});

describe('normal helpers', () => {
  it('normalCdf matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('barrierTouchProbability is 2*(1-Phi(b/sigma)), with edge cases', () => {
    expect(barrierTouchProbability(0.03, 0.022188)).toBeCloseTo(0.176, 2);
    expect(barrierTouchProbability(0, 0.02)).toBe(1);
    expect(barrierTouchProbability(0.03, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/formulas.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/quant/formulas.ts`**

```ts
// src/perp/quant/formulas.ts
import type { PerpConfig } from '../config.js';

export const WEEKS_PER_YEAR = 52;
/** Used only when neither VIX nor a realized estimate is available (the policy refuses entries then). */
export const DEFAULT_SIGMA_WEEK = 0.025;

/** Index weekly sigma as a fraction, from the VIX level; null when the VIX is unusable. */
export function sigmaWeekFromVix(vix: number): number | null {
  if (!Number.isFinite(vix) || vix <= 0) return null;
  return vix / 100 / Math.sqrt(WEEKS_PER_YEAR);
}

/** min(hi, max(lo, x)): when hi < lo the upper bound wins, which is what the loss-budget cap needs. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Trailing-stop distance as a fraction of price for REALIZED leverage `leverage` (spec 5.2):
 * clamp(k * sigmaWeek, floor, min(cap, B / L)).
 */
export function stopFraction(sigmaWeek: number, leverage: number, cfg: PerpConfig): number {
  const upper = Math.min(cfg.stopCap, cfg.lossBudget / leverage);
  return clamp(cfg.sigmaK * sigmaWeek, cfg.stopFloor, upper);
}

/** Adverse index move (fraction) that reaches liquidation at leverage L with maintenance margin mm: 1/L - mm. */
export function liquidationDistance(leverage: number, mm: number): number {
  return 1 / leverage - mm;
}

/** Largest leverage whose liquidation distance is still at least twice `stop`: solves 2*stop <= 1/L - mm. */
export function liqBoundLeverage(stop: number, mm: number): number {
  return 1 / (2 * stop + mm);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** P(the path touches -barrier within the horizon) for zero-drift Brownian motion with horizon sigma `sigma`. */
export function barrierTouchProbability(barrier: number, sigma: number): number {
  if (barrier <= 0) return 1;
  if (sigma <= 0) return 0;
  return 2 * (1 - normalCdf(barrier / sigma));
}
```

- [ ] **Step 4: Run the test**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/formulas.test.ts && npx tsc --noEmit`
Expected: all pass, no `tsc` output.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): quant formulas (sigma, stop fraction, liquidation, barrier touch)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Pressure book

**Files:**
- Create: `src/perp/quant/pressure.ts`, `test/perp/pressure.test.ts`

**Interfaces:**
- Consumes: `PerpConfig`, `ImpactAssessment`, `clamp` is not needed.
- Produces:
  - `itemWeight(a: ImpactAssessment, cfg: PerpConfig): number` signed fraction (positive = bullish); 0 for non-finite inputs
  - `class PressureBook { constructor(cfg: PerpConfig); add(a: ImpactAssessment): boolean; at(tMs: number): number; top(tMs: number, n: number): Array<{ itemId: string; contribution: number; rationale: string }>; prune(beforeMs: number): number; get size(): number }`

- [ ] **Step 1: Write the failing test `test/perp/pressure.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { PressureBook, itemWeight } from '../../src/perp/quant/pressure.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 86_400_000;
const cfg = DEFAULT_CONFIG;

function a(over: Partial<ImpactAssessment> = {}): ImpactAssessment {
  return {
    itemId: 'i1',
    receivedAtMs: T0,
    publishedAtMs: T0 - 60_000,
    direction: 'up',
    bucket: 'moderate',
    horizon: 'days',
    credibility: 0.8,
    novelty: 'new',
    alreadyPriced: 'no',
    confidence: 0.75,
    rationale: 'r',
    ...over,
  };
}

describe('itemWeight', () => {
  it('= sign * bucketMove * credibility * confidence * noveltyWeight * pricedWeight', () => {
    expect(itemWeight(a(), cfg)).toBeCloseTo(0.015 * 0.8 * 0.75, 10);
    expect(itemWeight(a({ direction: 'down' }), cfg)).toBeCloseTo(-0.009, 10);
    expect(itemWeight(a({ direction: 'neutral' }), cfg)).toBe(0);
    expect(itemWeight(a({ alreadyPriced: 'yes' }), cfg)).toBeCloseTo(0.009 * 0.3, 10);
    expect(itemWeight(a({ novelty: 'known' }), cfg)).toBeCloseTo(0.009 * 0.25, 10);
  });
  it('is 0 (never NaN) when confidence or credibility is not finite', () => {
    expect(itemWeight(a({ confidence: NaN }), cfg)).toBe(0);
    expect(itemWeight(a({ credibility: Infinity }), cfg)).toBe(0);
  });
});

describe('PressureBook', () => {
  it('returns the full weight at arrival and decays by e^-1 after tau (2 days)', () => {
    const book = new PressureBook(cfg);
    book.add(a());
    expect(book.at(T0)).toBeCloseTo(0.009, 10);
    expect(book.at(T0 + 2 * DAY)).toBeCloseTo(0.009 * Math.exp(-1), 8);
  });
  it('sums signed contributions', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'up' }));
    book.add(a({ itemId: 'down', direction: 'down', bucket: 'minor' }));
    expect(book.at(T0)).toBeCloseTo(0.009 - 0.005 * 0.8 * 0.75, 10);
  });
  it('ignores a duplicate/replayed item id (review focus 2)', () => {
    const book = new PressureBook(cfg);
    expect(book.add(a())).toBe(true);
    expect(book.add(a({ bucket: 'shock' }))).toBe(false);
    expect(book.at(T0)).toBeCloseTo(0.009, 10);
    expect(book.size).toBe(1);
  });
  it('ignores items received after the evaluation time (review focus 3)', () => {
    const book = new PressureBook(cfg);
    book.add(a({ receivedAtMs: T0 + 3_600_000 }));
    expect(book.at(T0)).toBe(0);
    expect(book.at(T0 + 3_600_000)).toBeCloseTo(0.009, 10);
  });
  it('decays an intraday item 4x faster than a days item', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'intra', horizon: 'intraday' }));
    expect(book.at(T0 + DAY / 2)).toBeCloseTo(0.009 * Math.exp(-1), 8); // tau = 0.5 day
    const book2 = new PressureBook(cfg);
    book2.add(a({ itemId: 'days', horizon: 'days' }));
    expect(book2.at(T0 + DAY / 2)).toBeCloseTo(0.009 * Math.exp(-0.25), 8);
  });
  it('never produces NaN from a malformed item', () => {
    const book = new PressureBook(cfg);
    book.add(a({ confidence: NaN }));
    expect(book.at(T0)).toBe(0);
  });
  it('top() ranks contributors by magnitude and prune() drops old items', () => {
    const book = new PressureBook(cfg);
    book.add(a({ itemId: 'small', bucket: 'minor', receivedAtMs: T0 - 10 * DAY }));
    book.add(a({ itemId: 'big', bucket: 'major' }));
    const top = book.top(T0, 2);
    expect(top[0].itemId).toBe('big');
    expect(book.prune(T0 - DAY)).toBe(1);
    expect(book.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/pressure.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/quant/pressure.ts`**

```ts
// src/perp/quant/pressure.ts
import type { PerpConfig } from '../config.js';
import type { ImpactAssessment } from '../types.js';

const MS_PER_DAY = 86_400_000;

const finite01 = (x: number): number | null => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null);

/**
 * Signed expected index move (fraction) that one item adds to the news pressure at arrival.
 * Positive = bullish. Any non-finite credibility/confidence yields 0, never NaN.
 */
export function itemWeight(a: ImpactAssessment, cfg: PerpConfig): number {
  const sign = a.direction === 'up' ? 1 : a.direction === 'down' ? -1 : 0;
  const cred = finite01(a.credibility);
  const conf = finite01(a.confidence);
  if (cred === null || conf === null) return 0;
  return sign * cfg.bucketMove[a.bucket] * cred * conf * cfg.noveltyWeight[a.novelty] * cfg.pricedWeight[a.alreadyPriced];
}

interface Entry {
  weight: number;
  receivedAtMs: number;
  tauMs: number;
  rationale: string;
}

/** Signed news pressure: a sum of item weights, each decaying exponentially from the moment it was received. */
export class PressureBook {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly cfg: PerpConfig) {}

  /** Returns false (and changes nothing) when this item id was already added. */
  add(a: ImpactAssessment): boolean {
    if (this.entries.has(a.itemId)) return false;
    this.entries.set(a.itemId, {
      weight: itemWeight(a, this.cfg),
      receivedAtMs: a.receivedAtMs,
      tauMs: this.cfg.tauDays * MS_PER_DAY * this.cfg.horizonTauFactor[a.horizon],
      rationale: a.rationale,
    });
    return true;
  }

  /** Pressure as of time `tMs`: only items already received by then, each decayed to `tMs`. */
  at(tMs: number): number {
    let p = 0;
    for (const e of this.entries.values()) {
      if (e.receivedAtMs > tMs) continue;
      p += e.weight * Math.exp(-(tMs - e.receivedAtMs) / e.tauMs);
    }
    return p;
  }

  top(tMs: number, n: number): Array<{ itemId: string; contribution: number; rationale: string }> {
    const rows: Array<{ itemId: string; contribution: number; rationale: string }> = [];
    for (const [itemId, e] of this.entries) {
      if (e.receivedAtMs > tMs) continue;
      rows.push({ itemId, contribution: e.weight * Math.exp(-(tMs - e.receivedAtMs) / e.tauMs), rationale: e.rationale });
    }
    rows.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
    return rows.slice(0, n);
  }

  /** Drops items received before `beforeMs`; returns how many were removed. */
  prune(beforeMs: number): number {
    let removed = 0;
    for (const [id, e] of this.entries) {
      if (e.receivedAtMs < beforeMs) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/pressure.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): decayed signed news pressure book

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Volatility and leverage governor

**Files:**
- Create: `src/perp/risk/governor.ts`, `test/perp/governor.test.ts`

**Interfaces:**
- Consumes: `PerpConfig`, `sigmaWeekFromVix`, `DEFAULT_SIGMA_WEEK`, `clamp`, `stopFraction`, `liqBoundLeverage`.
- Produces:
  - `interface GovernorOutput { sigmaWeek: number; sigmaDay: number; sigmaSource: 'vix' | 'realized' | 'default'; leverageEff: number; stopFrac: number }`
  - `computeGovernor(i: { cfg: PerpConfig; side: Side; vix: number | null; realizedWeeklySigma: number | null }): GovernorOutput`
  - `computeGovernors(cfg, vix, realizedWeeklySigma): Record<Side, GovernorOutput>`

- [ ] **Step 1: Write the failing test `test/perp/governor.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { computeGovernor, computeGovernors } from '../../src/perp/risk/governor.js';

const cfg = DEFAULT_CONFIG;
const g = (vix: number | null, side: 'long' | 'short' = 'long', realized: number | null = null, c = cfg) =>
  computeGovernor({ cfg: c, side, vix, realizedWeeklySigma: realized });

describe('computeGovernor', () => {
  it('keeps 4x and a ~3.9% stop at VIX 16', () => {
    const out = g(16);
    expect(out.sigmaSource).toBe('vix');
    expect(out.leverageEff).toBe(4);
    expect(out.stopFrac).toBeCloseTo(0.038829, 5);
    expect(out.sigmaDay).toBeCloseTo(0.022188 / Math.sqrt(5), 5);
  });
  it('reduces leverage instead of widening the stop when volatility is high (VIX 25)', () => {
    const out = g(25);
    expect(out.leverageEff).toBeCloseTo(0.2 / (1.75 * 0.034669), 3); // ~3.2965
    expect(out.stopFrac).toBe(0.05);
  });
  it('refuses a 13.7x target at VIX 16 (weekly horizon)', () => {
    const out = g(16, 'long', null, { ...cfg, leverageTarget: 13.7 });
    expect(out.leverageEff).toBeCloseTo(0.2 / 0.038829, 3); // ~5.15
    expect(out.leverageEff).toBeLessThan(6);
  });
  it('is bounded by liquidation distance when the loss budget is generous', () => {
    const out = g(16, 'long', null, { ...cfg, leverageTarget: 13.7, lossBudget: 0.4 });
    expect(out.leverageEff).toBeCloseTo(1 / (2 * 0.038829 + 0.0502), 3); // ~7.82
  });
  it('uses the higher short maintenance margin for shorts', () => {
    const long = g(16, 'long', null, { ...cfg, leverageTarget: 13.7, lossBudget: 0.4 });
    const short = g(16, 'short', null, { ...cfg, leverageTarget: 13.7, lossBudget: 0.4 });
    expect(short.leverageEff).toBeLessThan(long.leverageEff);
  });
  it('falls back to realized sigma, then to a default, when VIX is missing/zero/NaN (review focus 1)', () => {
    expect(g(null, 'long', 0.03).sigmaSource).toBe('realized');
    expect(g(null, 'long', 0.03).sigmaWeek).toBe(0.03);
    for (const bad of [null, 0, NaN, -5]) {
      const out = g(bad as number | null);
      expect(out.sigmaSource).toBe('default');
      expect(out.sigmaWeek).toBe(0.025);
      expect(Number.isFinite(out.leverageEff)).toBe(true);
      expect(Number.isFinite(out.stopFrac)).toBe(true);
    }
    expect(g(null, 'long', NaN).sigmaSource).toBe('default');
  });
  it('computeGovernors returns both sides', () => {
    const both = computeGovernors(cfg, 16, null);
    expect(both.long.leverageEff).toBe(4);
    expect(both.short.leverageEff).toBe(4);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/governor.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/risk/governor.ts`**

```ts
// src/perp/risk/governor.ts
import type { PerpConfig } from '../config.js';
import { DEFAULT_SIGMA_WEEK, clamp, liqBoundLeverage, sigmaWeekFromVix, stopFraction } from '../quant/formulas.js';
import type { Side } from '../types.js';

export interface GovernorOutput {
  sigmaWeek: number;
  /** Daily sigma implied by the weekly one: sigmaWeek / sqrt(5). */
  sigmaDay: number;
  sigmaSource: 'vix' | 'realized' | 'default';
  /** Largest realized leverage the volatility and liquidation limits allow, capped by the target. */
  leverageEff: number;
  /** Trailing-stop distance (fraction of price) at `leverageEff`. */
  stopFrac: number;
}

export function computeGovernor(i: {
  cfg: PerpConfig;
  side: Side;
  vix: number | null;
  realizedWeeklySigma: number | null;
}): GovernorOutput {
  const { cfg } = i;
  let sigmaWeek: number;
  let sigmaSource: GovernorOutput['sigmaSource'];
  const fromVix = i.vix === null ? null : sigmaWeekFromVix(i.vix);
  if (fromVix !== null) {
    sigmaWeek = fromVix;
    sigmaSource = 'vix';
  } else if (i.realizedWeeklySigma !== null && Number.isFinite(i.realizedWeeklySigma) && i.realizedWeeklySigma > 0) {
    sigmaWeek = i.realizedWeeklySigma;
    sigmaSource = 'realized';
  } else {
    sigmaWeek = DEFAULT_SIGMA_WEEK;
    sigmaSource = 'default';
  }

  const kSigma = cfg.sigmaK * sigmaWeek;
  const stopVol = clamp(kSigma, cfg.stopFloor, cfg.stopCap);
  const levVol = cfg.lossBudget / kSigma;
  const levLiq = liqBoundLeverage(stopVol, cfg.maintenanceMargin[i.side]);
  const leverageEff = Math.min(cfg.leverageTarget, levVol, levLiq);

  return {
    sigmaWeek,
    sigmaDay: sigmaWeek / Math.sqrt(5),
    sigmaSource,
    leverageEff,
    stopFrac: stopFraction(sigmaWeek, leverageEff, cfg),
  };
}

export function computeGovernors(
  cfg: PerpConfig,
  vix: number | null,
  realizedWeeklySigma: number | null
): Record<Side, GovernorOutput> {
  return {
    long: computeGovernor({ cfg, side: 'long', vix, realizedWeeklySigma }),
    short: computeGovernor({ cfg, side: 'short', vix, realizedWeeklySigma }),
  };
}
```

- [ ] **Step 4: Run the test**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/governor.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): volatility/leverage governor

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Risk state (cooldowns) and kill switch

**Files:**
- Create: `src/perp/risk/state.ts`, `src/perp/risk/killSwitch.ts`, `test/perp/risk.test.ts`

**Interfaces:**
- Consumes: `PerpConfig`, `ExitRule`, `Side`.
- Produces:
  - `interface RiskState { halted: boolean; haltReason: string | null; cooldownUntilMs: Record<Side, number>; thresholdMult: Record<Side, number> }`
  - `initialRiskState(): RiskState`, `STOP_OUT_RULES: ReadonlySet<ExitRule>`
  - `applyExit(risk: RiskState, exit: { rule: ExitRule; side: Side; atMs: number }, cfg: PerpConfig): RiskState`
  - `applyEntry(risk: RiskState, side: Side): RiskState`, `haltRisk(risk, reason): RiskState`, `clearHalt(risk): RiskState`
  - `interface ExitRecord { atMs: number; rule: ExitRule; side: Side; pnlUsd: number }`
  - `evaluateKillSwitch(i: { exits: ExitRecord[]; equityPeak: number; equityNow: number; nowMs: number; cfg: PerpConfig }): { halt: boolean; reason: string | null }`

- [ ] **Step 1: Write the failing test `test/perp/risk.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { applyEntry, applyExit, clearHalt, haltRisk, initialRiskState } from '../../src/perp/risk/state.js';
import { evaluateKillSwitch, type ExitRecord } from '../../src/perp/risk/killSwitch.js';

const cfg = DEFAULT_CONFIG;
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;
const DAY = 24 * H;

describe('risk state (spec 5.5)', () => {
  it('starts open with no cooldowns and unit thresholds', () => {
    const r = initialRiskState();
    expect(r.halted).toBe(false);
    expect(r.cooldownUntilMs).toEqual({ long: 0, short: 0 });
    expect(r.thresholdMult).toEqual({ long: 1, short: 1 });
  });
  it('a news-driven exit cools down only the same side and raises its threshold', () => {
    const r = applyExit(initialRiskState(), { rule: 'shock', side: 'long', atMs: NOW }, cfg);
    expect(r.cooldownUntilMs.long).toBe(NOW + 4 * H);
    expect(r.cooldownUntilMs.short).toBe(0);
    expect(r.thresholdMult.long).toBe(1.2);
    expect(r.thresholdMult.short).toBe(1);
  });
  it('a price stop-out cools down BOTH sides for 24h', () => {
    for (const rule of ['trailing_stop', 'margin_guard', 'liquidated'] as const) {
      const r = applyExit(initialRiskState(), { rule, side: 'short', atMs: NOW }, cfg);
      expect(r.cooldownUntilMs.long).toBe(NOW + 24 * H);
      expect(r.cooldownUntilMs.short).toBe(NOW + 24 * H);
      expect(r.thresholdMult.short).toBe(1.2);
    }
  });
  it('weekend and operator exits change nothing', () => {
    for (const rule of ['weekend', 'operator'] as const) {
      expect(applyExit(initialRiskState(), { rule, side: 'long', atMs: NOW }, cfg)).toEqual(initialRiskState());
    }
  });
  it('a new entry resets that side\'s threshold multiplier', () => {
    const r = applyExit(initialRiskState(), { rule: 'slow_bleed', side: 'long', atMs: NOW }, cfg);
    expect(applyEntry(r, 'long').thresholdMult.long).toBe(1);
  });
  it('halt and clearHalt', () => {
    const h = haltRisk(initialRiskState(), 'two stop-outs');
    expect(h.halted).toBe(true);
    expect(h.haltReason).toBe('two stop-outs');
    expect(clearHalt(h).halted).toBe(false);
  });
});

const exit = (over: Partial<ExitRecord>): ExitRecord => ({ atMs: NOW - H, rule: 'shock', side: 'long', pnlUsd: -0.1, ...over });

describe('evaluateKillSwitch (spec 5.7)', () => {
  const base = { equityPeak: 10, equityNow: 10, nowMs: NOW, cfg };
  it('does not halt on a clean record', () => {
    expect(evaluateKillSwitch({ ...base, exits: [] })).toEqual({ halt: false, reason: null });
  });
  it('halts on two stop-outs in 30 days', () => {
    const exits = [exit({ rule: 'trailing_stop', atMs: NOW - 5 * DAY }), exit({ rule: 'margin_guard', atMs: NOW - 2 * DAY })];
    const r = evaluateKillSwitch({ ...base, exits });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/stop-outs/);
  });
  it('ignores stop-outs older than 30 days and non-stop-out rules', () => {
    const exits = [
      exit({ rule: 'trailing_stop', atMs: NOW - 31 * DAY }),
      exit({ rule: 'trailing_stop', atMs: NOW - 2 * DAY }),
      exit({ rule: 'shock', atMs: NOW - 3 * DAY }),
    ];
    expect(evaluateKillSwitch({ ...base, exits }).halt).toBe(false);
  });
  it('halts when equity is 30% below its peak', () => {
    expect(evaluateKillSwitch({ ...base, exits: [], equityNow: 7.5 }).halt).toBe(false);
    const r = evaluateKillSwitch({ ...base, exits: [], equityNow: 6.9 });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/drawdown/);
  });
  it('halts on three exits within 24 hours', () => {
    const exits = [exit({ atMs: NOW - H }), exit({ atMs: NOW - 5 * H }), exit({ atMs: NOW - 20 * H })];
    const r = evaluateKillSwitch({ ...base, exits });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/24 hours/);
  });
  it('does not divide by zero when the equity peak is 0', () => {
    expect(evaluateKillSwitch({ ...base, exits: [], equityPeak: 0, equityNow: 0 }).halt).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/risk.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `src/perp/risk/state.ts`**

```ts
// src/perp/risk/state.ts
import type { PerpConfig } from '../config.js';
import type { ExitRule, Side } from '../types.js';

export interface RiskState {
  halted: boolean;
  haltReason: string | null;
  /** Earliest time a new entry on that side is allowed. */
  cooldownUntilMs: Record<Side, number>;
  /** Multiplier on that side's entry threshold; raised after an exit, reset by the next entry. */
  thresholdMult: Record<Side, number>;
}

export const STOP_OUT_RULES: ReadonlySet<ExitRule> = new Set<ExitRule>(['trailing_stop', 'margin_guard', 'liquidated']);
const NEWS_RULES: ReadonlySet<ExitRule> = new Set<ExitRule>(['shock', 'slow_bleed', 'pressure']);
const HOUR_MS = 3_600_000;

export function initialRiskState(): RiskState {
  return {
    halted: false,
    haltReason: null,
    cooldownUntilMs: { long: 0, short: 0 },
    thresholdMult: { long: 1, short: 1 },
  };
}

/**
 * Spec 5.5. A price stop-out (rules 1-2) cools BOTH sides for the stop-out cooldown; a news-driven exit
 * (rules 3-5) cools only the same side, so the opposite direction may enter immediately if its own
 * threshold passes. The same side's next entry needs a higher bar. Weekend/operator exits change nothing.
 */
export function applyExit(
  risk: RiskState,
  exit: { rule: ExitRule; side: Side; atMs: number },
  cfg: PerpConfig
): RiskState {
  const next: RiskState = {
    ...risk,
    cooldownUntilMs: { ...risk.cooldownUntilMs },
    thresholdMult: { ...risk.thresholdMult },
  };
  if (STOP_OUT_RULES.has(exit.rule)) {
    const until = exit.atMs + cfg.stopOutCooldownHours * HOUR_MS;
    next.cooldownUntilMs.long = Math.max(next.cooldownUntilMs.long, until);
    next.cooldownUntilMs.short = Math.max(next.cooldownUntilMs.short, until);
    next.thresholdMult[exit.side] = cfg.reentryMult;
  } else if (NEWS_RULES.has(exit.rule)) {
    next.cooldownUntilMs[exit.side] = Math.max(next.cooldownUntilMs[exit.side], exit.atMs + cfg.cooldownHours * HOUR_MS);
    next.thresholdMult[exit.side] = cfg.reentryMult;
  }
  return next;
}

export function applyEntry(risk: RiskState, side: Side): RiskState {
  return { ...risk, thresholdMult: { ...risk.thresholdMult, [side]: 1 } };
}

export function haltRisk(risk: RiskState, reason: string): RiskState {
  return { ...risk, halted: true, haltReason: reason };
}

export function clearHalt(risk: RiskState): RiskState {
  return { ...risk, halted: false, haltReason: null };
}
```

- [ ] **Step 4: Write `src/perp/risk/killSwitch.ts`**

```ts
// src/perp/risk/killSwitch.ts
import type { PerpConfig } from '../config.js';
import type { ExitRule, Side } from '../types.js';
import { STOP_OUT_RULES } from './state.js';

export interface ExitRecord {
  atMs: number;
  rule: ExitRule;
  side: Side;
  pnlUsd: number;
}

const DAY_MS = 86_400_000;

/** Spec 5.7: two stop-outs in 30 days, or equity down 30% from its peak, or three exits within 24 hours. */
export function evaluateKillSwitch(i: {
  exits: ExitRecord[];
  equityPeak: number;
  equityNow: number;
  nowMs: number;
  cfg: PerpConfig;
}): { halt: boolean; reason: string | null } {
  const { cfg, nowMs } = i;
  const stopOuts = i.exits.filter((e) => STOP_OUT_RULES.has(e.rule) && nowMs - e.atMs <= 30 * DAY_MS).length;
  if (stopOuts >= cfg.killStopOuts30d) {
    return { halt: true, reason: `${stopOuts} stop-outs in 30 days (limit ${cfg.killStopOuts30d})` };
  }
  if (i.equityPeak > 0 && i.equityNow <= i.equityPeak * (1 - cfg.killDrawdown)) {
    const dd = (1 - i.equityNow / i.equityPeak) * 100;
    return { halt: true, reason: `equity drawdown ${dd.toFixed(1)}% from peak (limit ${(cfg.killDrawdown * 100).toFixed(0)}%)` };
  }
  const recent = i.exits.filter((e) => nowMs - e.atMs <= DAY_MS).length;
  if (recent >= cfg.killExits24h) {
    return { halt: true, reason: `${recent} exits within 24 hours (limit ${cfg.killExits24h})` };
  }
  return { halt: false, reason: null };
}
```

- [ ] **Step 5: Run the test**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/risk.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): risk state, cooldowns and kill switch

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Time windows

**Files:**
- Create: `src/perp/time/windows.ts`, `test/perp/windows.test.ts`

**Interfaces:**
- Consumes: `ScheduledEvent`.
- Produces: `MS_PER_MIN`, `minutesToClose(nowMs: number, nextCloseTsMs: number | null): number | null`, `inEventWindow(nowMs, events, minutes): boolean` (high-impact events only, +- window), `eventSoon(nowMs, events, withinMinutes): boolean` (high-impact, strictly in the future within the window).

- [ ] **Step 1: Write the failing test `test/perp/windows.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { eventSoon, inEventWindow, minutesToClose } from '../../src/perp/time/windows.js';
import type { ScheduledEvent } from '../../src/perp/types.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const ev = (offsetMin: number, impact: 'high' | 'medium' = 'high'): ScheduledEvent => ({ tsMs: NOW + offsetMin * MIN, name: 'CPI', impact });

describe('minutesToClose', () => {
  it('is null when the close is unknown and signed otherwise', () => {
    expect(minutesToClose(NOW, null)).toBeNull();
    expect(minutesToClose(NOW, NOW + 90 * MIN)).toBe(90);
    expect(minutesToClose(NOW, NOW - 10 * MIN)).toBe(-10);
  });
});

describe('inEventWindow', () => {
  it('is true within +-minutes of a high-impact event, either side', () => {
    expect(inEventWindow(NOW, [ev(4)], 5)).toBe(true);
    expect(inEventWindow(NOW, [ev(-4)], 5)).toBe(true);
    expect(inEventWindow(NOW, [ev(6)], 5)).toBe(false);
  });
  it('ignores medium-impact events and an empty list', () => {
    expect(inEventWindow(NOW, [ev(1, 'medium')], 5)).toBe(false);
    expect(inEventWindow(NOW, [], 5)).toBe(false);
  });
});

describe('eventSoon', () => {
  it('is true only for a high-impact event strictly ahead and within the window', () => {
    expect(eventSoon(NOW, [ev(30)], 60)).toBe(true);
    expect(eventSoon(NOW, [ev(61)], 60)).toBe(false);
    expect(eventSoon(NOW, [ev(-5)], 60)).toBe(false);
    expect(eventSoon(NOW, [ev(30, 'medium')], 60)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/windows.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/time/windows.ts`**

```ts
// src/perp/time/windows.ts
import type { ScheduledEvent } from '../types.js';

export const MS_PER_MIN = 60_000;

/** Minutes until the next scheduled market close; null when the exchange does not report one. */
export function minutesToClose(nowMs: number, nextCloseTsMs: number | null): number | null {
  return nextCloseTsMs === null ? null : (nextCloseTsMs - nowMs) / MS_PER_MIN;
}

/** True when `nowMs` is within +-`minutes` of any high-impact scheduled event. */
export function inEventWindow(nowMs: number, events: ScheduledEvent[], minutes: number): boolean {
  return events.some((e) => e.impact === 'high' && Math.abs(e.tsMs - nowMs) <= minutes * MS_PER_MIN);
}

/** True when a high-impact event is strictly ahead and starts within `withinMinutes`. */
export function eventSoon(nowMs: number, events: ScheduledEvent[], withinMinutes: number): boolean {
  return events.some((e) => e.impact === 'high' && e.tsMs > nowMs && e.tsMs - nowMs <= withinMinutes * MS_PER_MIN);
}
```

- [ ] **Step 4: Run the test**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/windows.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): weekly-close and event window helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Policy (entry and exit rules)

**Files:**
- Create: `src/perp/policy/policy.ts`, `test/perp/policy.test.ts`

**Interfaces:**
- Consumes: `PerpConfig`; `GovernorOutput`; `RiskState`; `stopFraction`; `eventSoon`, `inEventWindow`, `minutesToClose`; types from Task 1.
- Produces:
  - `type NewItem = ImpactAssessment & { movedSincePublish: number | null }` (`movedSincePublish` = perp move since the item's publish time, signed in the item's direction, as a fraction; `null` = unknown)
  - `interface PolicyInput { nowMs; cfg; snapshot: Snapshot; position: PositionState | null; pressureNow: number; pressure12hAgo: number; newItems: NewItem[]; governors: Record<Side, GovernorOutput>; realizedLeverage: number | null; liqDistance: number | null; weeklyExtreme: number | null; risk: RiskState; prevBreachStreak: number }`
    - `realizedLeverage`: leverage a new 1-contract position would have = price x contracts / subaccount equity (null when unknown); `liqDistance`: the broker's distance to liquidation as a fraction of price (only meaningful while positioned); `weeklyExtreme`: best mark in the last 7 days in the position's favour (max for a long, min for a short)
  - `interface PolicyOutput { action: Action; breachStreak: number }`
  - `entryThreshold(side: Side, cfg: PerpConfig): number`
  - `decide(inp: PolicyInput): PolicyOutput`

- [ ] **Step 1: Write the failing test `test/perp/policy.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { computeGovernors } from '../../src/perp/risk/governor.js';
import { initialRiskState } from '../../src/perp/risk/state.js';
import { decide, entryThreshold, type NewItem, type PolicyInput } from '../../src/perp/policy/policy.js';
import type { PositionState, ScheduledEvent, Snapshot } from '../../src/perp/types.js';

const cfg = DEFAULT_CONFIG;
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;

function snap(over: Partial<Snapshot['perp']> = {}, events: ScheduledEvent[] = []): Snapshot {
  return {
    tsMs: NOW,
    perp: { bid: 13.75, ask: 13.76, mark: 13.755, marketOpen: true, nextCloseTsMs: NOW + 3 * 24 * H, fundingEstimate: 0, ...over },
    returns: { d1: 0, d5: 0 },
    realizedWeeklySigma: null,
    macro: {},
    events,
    kalshiEvents: [],
    freshness: { perpAgeMs: 1000, macroAgeMs: 1000 },
  };
}

function item(over: Partial<NewItem> = {}): NewItem {
  return {
    itemId: 'i1',
    receivedAtMs: NOW,
    publishedAtMs: NOW - MIN,
    direction: 'up',
    bucket: 'moderate',
    horizon: 'days',
    credibility: 0.8,
    novelty: 'new',
    alreadyPriced: 'no',
    confidence: 0.75,
    rationale: 'because',
    movedSincePublish: 0.001,
    ...over,
  };
}

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    nowMs: NOW,
    cfg,
    snapshot: snap(),
    position: null,
    pressureNow: 0.02,
    pressure12hAgo: 0,
    newItems: [item()],
    governors: computeGovernors(cfg, 16, null),
    realizedLeverage: 4,
    liqDistance: null,
    weeklyExtreme: null,
    risk: initialRiskState(),
    prevBreachStreak: 0,
    ...over,
  };
}

const longPos = (over: Partial<PositionState> = {}): PositionState => ({
  side: 'long', contracts: 1, entryPrice: 13.76, entryTimeMs: NOW - 24 * H, extreme: 13.9, leverage: 4, stopBps: 388, tightenedUntilMs: null, ...over,
});
const shortPos = (over: Partial<PositionState> = {}): PositionState => ({
  side: 'short', contracts: 1, entryPrice: 13.76, entryTimeMs: NOW - 24 * H, extreme: 13.5, leverage: 4, stopBps: 388, tightenedUntilMs: null, ...over,
});

describe('entryThreshold', () => {
  it('is 1.5% for longs and 1.25x that for shorts', () => {
    expect(entryThreshold('long', cfg)).toBe(0.015);
    expect(entryThreshold('short', cfg)).toBeCloseTo(0.01875, 10);
  });
});

describe('flat: entries', () => {
  it('opens a long on bullish pressure + a new, confident, not-late item', () => {
    const { action } = decide(input());
    expect(action.kind).toBe('open');
    if (action.kind !== 'open') return;
    expect(action.side).toBe('long');
    expect(action.leverage).toBe(4);
    expect(action.stopFrac).toBeCloseTo(0.038829, 5);
    expect(action.triggerItemId).toBe('i1');
  });
  it('holds when pressure is below the long threshold', () => {
    expect(decide(input({ pressureNow: 0.01 })).action.kind).toBe('hold');
  });
  it('holds when the trigger item is known (not new) or low confidence', () => {
    expect(decide(input({ newItems: [item({ novelty: 'known' })] })).action.kind).toBe('hold');
    expect(decide(input({ newItems: [item({ confidence: 0.5 })] })).action.kind).toBe('hold');
  });
  it('holds when the market already moved >40% of the expected move (late)', () => {
    // moderate = 1.5% expected; 40% = 0.6%
    expect(decide(input({ newItems: [item({ movedSincePublish: 0.007 })] })).action.kind).toBe('hold');
    expect(decide(input({ newItems: [item({ movedSincePublish: 0.005 })] })).action.kind).toBe('open');
  });
  it('never enters when the move since publish is unknown (review focus 4)', () => {
    const out = decide(input({ newItems: [item({ movedSincePublish: null })] }));
    expect(out.action.kind).toBe('hold');
  });
  it('shorts need a 25% higher bar and higher confidence', () => {
    const bear = item({ direction: 'down', confidence: 0.75 });
    expect(decide(input({ pressureNow: -0.016, newItems: [bear] })).action.kind).toBe('hold'); // < 1.875%
    const ok = decide(input({ pressureNow: -0.02, newItems: [bear] }));
    expect(ok.action.kind).toBe('open');
    if (ok.action.kind === 'open') expect(ok.action.side).toBe('short');
    expect(decide(input({ pressureNow: -0.02, newItems: [item({ direction: 'down', confidence: 0.65 })] })).action.kind).toBe('hold');
  });
  it('respects allowShort=false', () => {
    const noShort = { ...cfg, allowShort: false };
    expect(decide(input({ cfg: noShort, pressureNow: -0.03, newItems: [item({ direction: 'down' })] })).action.kind).toBe('hold');
  });
  it('holds while halted, stale, market closed, inside the weekly-close window, or in an event window', () => {
    expect(decide(input({ risk: { ...initialRiskState(), halted: true, haltReason: 'x' } })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: { ...snap(), tsMs: NOW - 10 * MIN } })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: snap({ marketOpen: false }) })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: snap({ nextCloseTsMs: NOW + 20 * MIN }) })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: snap({}, [{ tsMs: NOW + 3 * MIN, name: 'CPI', impact: 'high' }]) })).action.kind).toBe('hold');
  });
  it('holds during the per-side cooldown but allows the opposite side after a news exit', () => {
    const cooling = { ...initialRiskState(), cooldownUntilMs: { long: NOW + H, short: 0 } };
    expect(decide(input({ risk: cooling })).action.kind).toBe('hold');
    const bear = item({ direction: 'down', confidence: 0.8 });
    expect(decide(input({ risk: cooling, pressureNow: -0.03, newItems: [bear] })).action.kind).toBe('open');
  });
  it('applies the raised re-entry threshold', () => {
    const raised = { ...initialRiskState(), thresholdMult: { long: 1.2, short: 1 } };
    expect(decide(input({ risk: raised, pressureNow: 0.017 })).action.kind).toBe('hold'); // needs 1.8%
    expect(decide(input({ risk: raised, pressureNow: 0.019 })).action.kind).toBe('open');
  });
  it('refuses entries with no volatility estimate (review focus 1)', () => {
    const out = decide(input({ governors: computeGovernors(cfg, null, null) }));
    expect(out.action.kind).toBe('hold');
    expect(out.action.kind === 'hold' && out.action.reasons.join(' ')).toMatch(/volatility/);
  });
  it('refuses entries when governed leverage is below the minimum', () => {
    expect(decide(input({ governors: computeGovernors(cfg, 80, null) })).action.kind).toBe('hold');
  });
  it('refuses an entry whose realized leverage exceeds 1.05 x governed leverage (review focus 5)', () => {
    expect(decide(input({ realizedLeverage: 4.19 })).action.kind).toBe('open'); // limit is 4 x 1.05 = 4.2
    expect(decide(input({ realizedLeverage: 4.3 })).action.kind).toBe('hold');
    expect(decide(input({ realizedLeverage: null })).action.kind).toBe('hold');
  });
  it('sizes the stop from REALIZED leverage', () => {
    const out = decide(input({ realizedLeverage: 2.75 }));
    expect(out.action.kind === 'open' && out.action.leverage).toBe(2.75);
  });
});

describe('long: exits', () => {
  const noNews = { newItems: [] as NewItem[], pressureNow: 0, position: longPos() };

  it('closes via the margin guard when liquidation is closer than 2 stops', () => {
    const out = decide(input({ ...noNews, liqDistance: 0.07 })); // 2 * 0.0388 = 0.0776
    expect(out.action).toMatchObject({ kind: 'close', rule: 'margin_guard' });
    expect(decide(input({ ...noNews, liqDistance: 0.2 })).action.kind).toBe('hold');
  });
  it('closes on a credible, new, adverse shock', () => {
    const shock = item({ direction: 'down', bucket: 'shock', confidence: 0.8, credibility: 0.9 });
    expect(decide(input({ ...noNews, newItems: [shock] })).action).toMatchObject({ kind: 'close', rule: 'shock' });
  });
  it('ignores a shock that is low-confidence, known, or in the long\'s favour', () => {
    for (const s of [
      item({ direction: 'down', bucket: 'shock', confidence: 0.5, credibility: 0.9 }),
      item({ direction: 'down', bucket: 'shock', novelty: 'known', confidence: 0.9, credibility: 0.9 }),
      item({ direction: 'up', bucket: 'shock', confidence: 0.9, credibility: 0.9 }),
    ]) {
      expect(decide(input({ ...noNews, newItems: [s] })).action.kind).toBe('hold');
    }
  });
  it('closes on a slow bleed: >=3% off the weekly high, adverse pressure >= 2% and not decaying', () => {
    const base = { ...noNews, snapshot: snap({ mark: 13.4 }), weeklyExtreme: 13.9, pressureNow: -0.021, pressure12hAgo: -0.015 };
    expect(decide(input(base)).action).toMatchObject({ kind: 'close', rule: 'slow_bleed' });
  });
  it('does NOT close on price alone, nor when the adverse pressure is decaying, nor below 3%', () => {
    expect(decide(input({ ...noNews, snapshot: snap({ mark: 13.4 }), weeklyExtreme: 13.9, pressureNow: 0, pressure12hAgo: 0 })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, snapshot: snap({ mark: 13.4 }), weeklyExtreme: 13.9, pressureNow: -0.021, pressure12hAgo: -0.03 })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, snapshot: snap({ mark: 13.6 }), weeklyExtreme: 13.9, pressureNow: -0.021, pressure12hAgo: -0.015 })).action.kind).toBe('hold');
  });
  it('closes when adverse pressure breaches the exit threshold on two consecutive evaluations', () => {
    const first = decide(input({ ...noNews, pressureNow: -0.021, prevBreachStreak: 0 }));
    expect(first.action.kind).toBe('hold');
    expect(first.breachStreak).toBe(1);
    const second = decide(input({ ...noNews, pressureNow: -0.021, prevBreachStreak: first.breachStreak }));
    expect(second.action).toMatchObject({ kind: 'close', rule: 'pressure' });
    expect(decide(input({ ...noNews, pressureNow: -0.01, prevBreachStreak: 1 })).breachStreak).toBe(0);
  });
  it('flattens before the weekly close unless aligned pressure is at least 1.5x the entry threshold', () => {
    const closing = snap({ nextCloseTsMs: NOW + 20 * MIN });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: 0.01 })).action).toMatchObject({ kind: 'close', rule: 'weekend' });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: 0.0226 })).action.kind).toBe('hold');
  });
  it('cannot close while the market is closed (holds; the exchange trigger remains)', () => {
    const out = decide(input({ ...noNews, snapshot: snap({ marketOpen: false }), pressureNow: -0.05, prevBreachStreak: 5 }));
    expect(out.action.kind).toBe('hold');
  });
  it('tightens the stop for a credible adverse "major" item and holds the tightening for 2h', () => {
    const major = item({ direction: 'down', bucket: 'major', confidence: 0.8 });
    const out = decide(input({ ...noNews, newItems: [major] }));
    expect(out.action.kind).toBe('set_stop');
    if (out.action.kind !== 'set_stop') return;
    expect(out.action.stopFrac).toBeCloseTo(0.01488, 4); // 1.5 * sigmaDay
    expect(out.action.holdMs).toBe(120 * MIN);
  });
  it('tightens ahead of a high-impact release and does not re-tighten once tight', () => {
    const events: ScheduledEvent[] = [{ tsMs: NOW + 30 * MIN, name: 'FOMC', impact: 'high' }];
    const out = decide(input({ ...noNews, snapshot: snap({}, events) }));
    expect(out.action.kind).toBe('set_stop');
    // 1.5 x sigmaDay is ~148.8 bps; a stop already at 148 bps is as tight as the target, so nothing to do.
    const tight = decide(input({ ...noNews, snapshot: snap({}, events), position: longPos({ stopBps: 148 }) }));
    expect(tight.action.kind).toBe('hold');
  });
  it('re-syncs the stop when volatility moved it by >= 50 bps, but not while a tightening is held', () => {
    const wide = decide(input({ ...noNews, position: longPos({ stopBps: 500 }) }));
    expect(wide.action.kind).toBe('set_stop');
    if (wide.action.kind === 'set_stop') expect(wide.action.stopFrac).toBeCloseTo(0.038829, 5);
    expect(decide(input({ ...noNews, position: longPos({ stopBps: 390 }) })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, position: longPos({ stopBps: 149, tightenedUntilMs: NOW + H }) })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, position: longPos({ stopBps: 149, tightenedUntilMs: NOW - H }) })).action.kind).toBe('set_stop');
  });
});

describe('short: mirrored exits', () => {
  const noNews = { newItems: [] as NewItem[], pressureNow: 0, position: shortPos() };
  it('closes a short on a bullish shock', () => {
    const shock = item({ direction: 'up', bucket: 'shock', confidence: 0.8, credibility: 0.9 });
    expect(decide(input({ ...noNews, newItems: [shock] })).action).toMatchObject({ kind: 'close', rule: 'shock' });
    const bearShock = item({ direction: 'down', bucket: 'shock', confidence: 0.8, credibility: 0.9 });
    expect(decide(input({ ...noNews, newItems: [bearShock] })).action.kind).toBe('hold');
  });
  it('closes a short on a slow bleed measured from the weekly LOW', () => {
    const out = decide(input({ ...noNews, snapshot: snap({ mark: 13.95 }), weeklyExtreme: 13.5, pressureNow: 0.021, pressure12hAgo: 0.015 }));
    expect(out.action).toMatchObject({ kind: 'close', rule: 'slow_bleed' });
  });
  it('weekend hold needs bearish (negative) pressure for a short', () => {
    const closing = snap({ nextCloseTsMs: NOW + 20 * MIN });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: 0.01 })).action).toMatchObject({ kind: 'close', rule: 'weekend' });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: -0.03 })).action.kind).toBe('hold');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/policy.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/policy/policy.ts`**

```ts
// src/perp/policy/policy.ts
import type { PerpConfig } from '../config.js';
import { stopFraction } from '../quant/formulas.js';
import type { GovernorOutput } from '../risk/governor.js';
import type { RiskState } from '../risk/state.js';
import { eventSoon, inEventWindow, minutesToClose, MS_PER_MIN } from '../time/windows.js';
import type { Action, Direction, ExitRule, ImpactAssessment, PositionState, Side, Snapshot } from '../types.js';

export type NewItem = ImpactAssessment & { movedSincePublish: number | null };

export interface PolicyInput {
  nowMs: number;
  cfg: PerpConfig;
  snapshot: Snapshot;
  position: PositionState | null;
  /** Signed decayed news pressure now (positive = bullish) and 12 hours ago. */
  pressureNow: number;
  pressure12hAgo: number;
  /** Items that arrived since the previous evaluation. */
  newItems: NewItem[];
  governors: Record<Side, GovernorOutput>;
  /** Leverage a new 1-contract position would have (price x contracts / subaccount equity); null if unknown. */
  realizedLeverage: number | null;
  /** Broker distance to liquidation as a fraction of price; only meaningful while positioned. */
  liqDistance: number | null;
  /** Best mark in the last 7 days in the position's favour (max for a long, min for a short). */
  weeklyExtreme: number | null;
  risk: RiskState;
  prevBreachStreak: number;
}

export interface PolicyOutput {
  action: Action;
  /** Consecutive evaluations with adverse pressure at or beyond the exit threshold. */
  breachStreak: number;
}

export function entryThreshold(side: Side, cfg: PerpConfig): number {
  return side === 'long' ? cfg.pEntryLong : cfg.pEntryLong * cfg.shortBar;
}

const adverseDirection = (side: Side): Direction => (side === 'long' ? 'down' : 'up');
const favourableDirection = (side: Side): Direction => (side === 'long' ? 'up' : 'down');
/** Pressure in the position's favour: positive is good for the side. */
const aligned = (side: Side, p: number): number => (side === 'long' ? p : -p);
const fmtPct = (x: number): string => `${(x * 100).toFixed(2)}%`;

export function decide(inp: PolicyInput): PolicyOutput {
  return inp.position === null ? decideFlat(inp) : decideInPosition(inp, inp.position);
}

function decideInPosition(inp: PolicyInput, pos: PositionState): PolicyOutput {
  const { cfg, nowMs, snapshot } = inp;
  const gov = inp.governors[pos.side];
  const adverseNow = -aligned(pos.side, inp.pressureNow);
  const adversePrev = -aligned(pos.side, inp.pressure12hAgo);
  const breachStreak = adverseNow >= cfg.pExit ? inp.prevBreachStreak + 1 : 0;
  const currentStop = pos.stopBps / 10_000;

  const close = (rule: ExitRule, reason: string): PolicyOutput => ({
    action: { kind: 'close', rule, reasons: [reason] },
    breachStreak,
  });
  const hold = (reason: string): PolicyOutput => ({ action: { kind: 'hold', reasons: [reason] }, breachStreak });

  // Nothing can be traded while the market is closed; the exchange-side trigger stays in force.
  if (!snapshot.perp.marketOpen) return hold('market closed; exchange trigger remains in force');

  // Rule 2: margin guard.
  if (inp.liqDistance !== null && inp.liqDistance < 2 * currentStop) {
    return close('margin_guard', `liquidation distance ${fmtPct(inp.liqDistance)} < 2 x stop ${fmtPct(currentStop)}`);
  }

  // Rule 3: credible, novel, adverse shock closes the position.
  const against = inp.newItems.filter((i) => i.direction === adverseDirection(pos.side));
  const shock = against.find(
    (i) => i.bucket === 'shock' && i.novelty === 'new' && i.confidence >= cfg.shockConfidence && i.credibility >= cfg.shockCredibility
  );
  if (shock) return close('shock', `adverse shock item ${shock.itemId}: ${shock.rationale}`);

  // Rule 4: slow bleed needs price AND news: drawdown from the weekly extreme, persistent adverse pressure.
  const mark = snapshot.perp.mark;
  const ref = inp.weeklyExtreme;
  const drawdown =
    ref === null || ref <= 0 ? 0 : pos.side === 'long' ? (ref - mark) / ref : (mark - ref) / ref;
  if (drawdown >= cfg.softDrawdown && adverseNow >= cfg.pExit && adverseNow >= adversePrev) {
    return close(
      'slow_bleed',
      `drawdown ${fmtPct(drawdown)} from weekly extreme with adverse pressure ${fmtPct(adverseNow)} not decaying (12h ago ${fmtPct(adversePrev)})`
    );
  }

  // Rule 5: cumulative adverse pressure for two consecutive evaluations.
  if (breachStreak >= 2) {
    return close('pressure', `adverse pressure ${fmtPct(adverseNow)} >= exit threshold ${fmtPct(cfg.pExit)} for ${breachStreak} evaluations`);
  }

  // Weekly close: flat unless the aligned pressure is strong.
  const mtc = minutesToClose(nowMs, snapshot.perp.nextCloseTsMs);
  if (mtc !== null && mtc >= 0 && mtc <= cfg.weekendFlatMinutes) {
    const holdAt = cfg.weekendHoldMult * entryThreshold(pos.side, cfg);
    if (aligned(pos.side, inp.pressureNow) < holdAt) {
      return close('weekend', `${mtc.toFixed(0)} min to weekly close and aligned pressure ${fmtPct(aligned(pos.side, inp.pressureNow))} < ${fmtPct(holdAt)}`);
    }
  }

  // Rule 6: tighten on a credible adverse "major" item or ahead of a high-impact release.
  const majorAdverse = against.some((i) => i.bucket === 'major' && i.novelty === 'new' && i.confidence >= cfg.shockConfidence);
  const releaseSoon = eventSoon(nowMs, snapshot.events, cfg.eventTightenMinutes);
  if (majorAdverse || releaseSoon) {
    const tightenFrac = Math.max(cfg.tightenFloor, cfg.tightenSigmaDayMult * gov.sigmaDay);
    if (tightenFrac < currentStop - 1e-9) {
      return {
        action: {
          kind: 'set_stop',
          stopFrac: tightenFrac,
          holdMs: majorAdverse ? cfg.tightenHoldMinutes * MS_PER_MIN : null,
          reasons: [majorAdverse ? 'adverse major item: tighten stop' : 'high-impact release ahead: tighten stop'],
        },
        breachStreak,
      };
    }
    return hold('already tightened ahead of risk');
  }

  // A deliberate tightening is held until it expires.
  if (pos.tightenedUntilMs !== null && nowMs < pos.tightenedUntilMs) return hold('stop tightened; holding until it expires');

  // Keep the exchange trigger in sync with the current volatility.
  const desired = stopFraction(gov.sigmaWeek, pos.leverage, cfg);
  if (Math.abs(desired - currentStop) >= cfg.resyncMinChange) {
    return {
      action: { kind: 'set_stop', stopFrac: desired, holdMs: null, reasons: [`re-sync stop ${fmtPct(currentStop)} -> ${fmtPct(desired)}`] },
      breachStreak,
    };
  }
  return hold('no exit rule fired');
}

function decideFlat(inp: PolicyInput): PolicyOutput {
  const { cfg, nowMs, snapshot, risk } = inp;
  const hold = (...reasons: string[]): PolicyOutput => ({ action: { kind: 'hold', reasons }, breachStreak: 0 });

  if (risk.halted) return hold(`halted: ${risk.haltReason ?? 'unknown'}`);
  const ageMs = Math.max(nowMs - snapshot.tsMs, snapshot.freshness.perpAgeMs);
  if (ageMs > cfg.staleSnapshotMs) return hold(`stale data (${Math.round(ageMs / 1000)}s old)`);
  if (!snapshot.perp.marketOpen) return hold('market closed');
  const mtc = minutesToClose(nowMs, snapshot.perp.nextCloseTsMs);
  if (mtc !== null && mtc <= cfg.weekendFlatMinutes) return hold('inside the weekly-close window');
  if (inEventWindow(nowMs, snapshot.events, cfg.noTradeMinutesAroundEvents)) {
    return hold('inside the no-trade window around a scheduled release');
  }

  const sides: Side[] = [];
  if (cfg.allowLong) sides.push('long');
  if (cfg.allowShort) sides.push('short');
  const gov = inp.governors[sides[0] ?? 'long'];
  if (gov.sigmaSource === 'default') return hold('no volatility estimate (VIX and realized sigma unavailable)');
  if (inp.realizedLeverage === null) return hold('realized leverage unknown');

  const reasons: string[] = [];
  for (const side of sides) {
    const g = inp.governors[side];
    if (g.leverageEff < cfg.minLeverage) {
      reasons.push(`${side}: governed leverage ${g.leverageEff.toFixed(2)}x below minimum ${cfg.minLeverage}x`);
      continue;
    }
    if (inp.realizedLeverage > g.leverageEff * cfg.entryLeverageSlack) {
      reasons.push(`${side}: realized leverage ${inp.realizedLeverage.toFixed(2)}x exceeds governed ${g.leverageEff.toFixed(2)}x (fund more collateral)`);
      continue;
    }
    if (nowMs < risk.cooldownUntilMs[side]) {
      reasons.push(`${side}: cooling down until ${new Date(risk.cooldownUntilMs[side]).toISOString()}`);
      continue;
    }
    const threshold = entryThreshold(side, cfg) * risk.thresholdMult[side];
    const alignedP = aligned(side, inp.pressureNow);
    if (alignedP < threshold) {
      reasons.push(`${side}: pressure ${fmtPct(alignedP)} below threshold ${fmtPct(threshold)}`);
      continue;
    }
    const minConf = side === 'long' ? cfg.confLong : cfg.confShort;
    const trigger = inp.newItems.find((i) => i.direction === favourableDirection(side) && i.novelty === 'new' && i.confidence >= minConf);
    if (!trigger) {
      reasons.push(`${side}: no new item with confidence >= ${minConf} in its direction`);
      continue;
    }
    const lateLimit = cfg.latenessMaxFrac * cfg.bucketMove[trigger.bucket];
    if (trigger.movedSincePublish === null) {
      reasons.push(`${side}: item ${trigger.itemId} has no price at publish time; cannot check lateness`);
      continue;
    }
    if (trigger.movedSincePublish > lateLimit) {
      reasons.push(`${side}: late, market already moved ${fmtPct(trigger.movedSincePublish)} (> ${fmtPct(lateLimit)})`);
      continue;
    }
    return {
      action: {
        kind: 'open',
        side,
        leverage: inp.realizedLeverage,
        stopFrac: stopFraction(g.sigmaWeek, inp.realizedLeverage, cfg),
        triggerItemId: trigger.itemId,
        reasons: [`${side} entry: pressure ${fmtPct(alignedP)} >= ${fmtPct(threshold)}; item ${trigger.itemId}: ${trigger.rationale}`],
      },
      breachStreak: 0,
    };
  }
  return hold(...(reasons.length > 0 ? reasons : ['no side allowed by config']));
}
```

- [ ] **Step 4: Run the policy test and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/policy.test.ts && npx tsc --noEmit`
Expected: all pass. If a numeric expectation is off by rounding, fix the test's tolerance only after re-deriving the number by hand from the spec formula; never loosen a rule.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): entry/exit policy state machine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: SQLite store

**Files:**
- Create: `src/perp/store/db.ts`, `test/perp/store.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3`, types, `RiskState`, `ExitRecord`.
- Produces (all take the `Database` first):
  - `openPerpDb(file: string): Database.Database` (use `':memory:'` in tests)
  - `appendJournal(db, e: { tsMs: number; kind: string; payload: unknown }): void`; `listJournal(db, kind: string, limit: number): Array<{ tsMs: number; payload: unknown }>` (newest first)
  - `getState<T>(db, key: string): T | null`; `setState(db, key: string, value: unknown): void`
  - `saveRiskState(db, r: RiskState)`, `loadRiskState(db): RiskState` (defaults to `initialRiskState()`)
  - `savePosition(db, p: PositionState | null)`, `loadPosition(db): PositionState | null`
  - `recordExit(db, e: ExitRecord)`, `listExits(db, sinceMs: number): ExitRecord[]`
  - `recordAssessment(db, a: ImpactAssessment): boolean` (false when the item id exists), `listAssessments(db, sinceMs: number): ImpactAssessment[]` (by `receivedAtMs`, ascending)
  - `saveSnapshot(db, s: Snapshot)`, `snapshotNear(db, tsMs: number, maxGapMs: number): Snapshot | null`, `markSeries(db, sinceMs: number): Array<{ tsMs: number; mark: number }>`
  - `recordEquity(db, tsMs: number, equity: number)`, `equityPeak(db): number` (0 when empty)

- [ ] **Step 1: Write the failing test `test/perp/store.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  appendJournal, equityPeak, getState, listAssessments, listExits, listJournal, loadPosition, loadRiskState,
  markSeries, openPerpDb, recordAssessment, recordEquity, recordExit, saveRiskState, savePosition, saveSnapshot,
  setState, snapshotNear,
} from '../../src/perp/store/db.js';
import { haltRisk, initialRiskState } from '../../src/perp/risk/state.js';
import type { ImpactAssessment, PositionState, Snapshot } from '../../src/perp/types.js';

let db: Database.Database;
beforeEach(() => {
  db = openPerpDb(':memory:');
});

const T = Date.UTC(2026, 9, 14, 15, 0, 0);
const snap = (tsMs: number, mark: number): Snapshot => ({
  tsMs,
  perp: { bid: mark - 0.005, ask: mark + 0.005, mark, marketOpen: true, nextCloseTsMs: null, fundingEstimate: 0 },
  returns: { d1: null, d5: null },
  realizedWeeklySigma: null,
  macro: {},
  events: [],
  kalshiEvents: [],
  freshness: { perpAgeMs: 0, macroAgeMs: null },
});
const assess = (id: string, receivedAtMs: number): ImpactAssessment => ({
  itemId: id, receivedAtMs, publishedAtMs: receivedAtMs - 1000, direction: 'up', bucket: 'minor', horizon: 'days',
  credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r',
});

describe('journal and state', () => {
  it('appends and lists the journal newest first, by kind', () => {
    appendJournal(db, { tsMs: T, kind: 'decision', payload: { a: 1 } });
    appendJournal(db, { tsMs: T + 1, kind: 'decision', payload: { a: 2 } });
    appendJournal(db, { tsMs: T + 2, kind: 'other', payload: {} });
    expect(listJournal(db, 'decision', 10).map((r) => r.payload)).toEqual([{ a: 2 }, { a: 1 }]);
    expect(listJournal(db, 'decision', 1)).toHaveLength(1);
  });
  it('round-trips state values and returns null for a missing key', () => {
    expect(getState(db, 'x')).toBeNull();
    setState(db, 'x', { n: 5 });
    setState(db, 'x', { n: 6 });
    expect(getState(db, 'x')).toEqual({ n: 6 });
  });
});

describe('risk state and position', () => {
  it('defaults to the initial risk state and round-trips a saved one', () => {
    expect(loadRiskState(db)).toEqual(initialRiskState());
    const r = haltRisk(initialRiskState(), 'why');
    saveRiskState(db, r);
    expect(loadRiskState(db)).toEqual(r);
  });
  it('saves, loads and clears the position', () => {
    expect(loadPosition(db)).toBeNull();
    const p: PositionState = { side: 'short', contracts: 1, entryPrice: 13.7, entryTimeMs: T, extreme: 13.6, leverage: 4, stopBps: 388, tightenedUntilMs: null };
    savePosition(db, p);
    expect(loadPosition(db)).toEqual(p);
    savePosition(db, null);
    expect(loadPosition(db)).toBeNull();
  });
});

describe('exits, assessments, snapshots, equity', () => {
  it('lists exits since a time', () => {
    recordExit(db, { atMs: T - 1000, rule: 'shock', side: 'long', pnlUsd: -0.2 });
    recordExit(db, { atMs: T + 1000, rule: 'trailing_stop', side: 'short', pnlUsd: -0.4 });
    expect(listExits(db, T)).toEqual([{ atMs: T + 1000, rule: 'trailing_stop', side: 'short', pnlUsd: -0.4 }]);
  });
  it('rejects a duplicate assessment id and lists by receive time', () => {
    expect(recordAssessment(db, assess('a', T))).toBe(true);
    expect(recordAssessment(db, assess('a', T + 5))).toBe(false);
    recordAssessment(db, assess('b', T - 5000));
    expect(listAssessments(db, T - 10_000).map((a) => a.itemId)).toEqual(['b', 'a']);
    expect(listAssessments(db, T).map((a) => a.itemId)).toEqual(['a']);
  });
  it('finds the snapshot nearest a time within a gap, and lists marks', () => {
    saveSnapshot(db, snap(T, 13.7));
    saveSnapshot(db, snap(T + 60_000, 13.8));
    expect(snapshotNear(db, T + 50_000, 30_000)?.perp.mark).toBe(13.8);
    expect(snapshotNear(db, T + 500_000, 30_000)).toBeNull();
    expect(markSeries(db, T)).toEqual([{ tsMs: T, mark: 13.7 }, { tsMs: T + 60_000, mark: 13.8 }]);
  });
  it('tracks the equity peak', () => {
    expect(equityPeak(db)).toBe(0);
    recordEquity(db, T, 5);
    recordEquity(db, T + 1, 6.5);
    recordEquity(db, T + 2, 4);
    expect(equityPeak(db)).toBe(6.5);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/executor_module-perp && npx vitest run test/perp/store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/perp/store/db.ts`**

```ts
// src/perp/store/db.ts
import Database from 'better-sqlite3';
import type { ExitRecord } from '../risk/killSwitch.js';
import { initialRiskState, type RiskState } from '../risk/state.js';
import type { ImpactAssessment, PositionState, Snapshot } from '../types.js';

export function openPerpDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS journal_kind_ts ON journal (kind, ts_ms);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS exits (id INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, rule TEXT NOT NULL, side TEXT NOT NULL, pnl_usd REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS assessments (item_id TEXT PRIMARY KEY, received_ms INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots (ts_ms INTEGER PRIMARY KEY, mark REAL NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS equity (ts_ms INTEGER PRIMARY KEY, equity REAL NOT NULL);
  `);
  return db;
}

export function appendJournal(db: Database.Database, e: { tsMs: number; kind: string; payload: unknown }): void {
  db.prepare('INSERT INTO journal (ts_ms, kind, payload) VALUES (?, ?, ?)').run(e.tsMs, e.kind, JSON.stringify(e.payload));
}

export function listJournal(db: Database.Database, kind: string, limit: number): Array<{ tsMs: number; payload: unknown }> {
  const rows = db
    .prepare('SELECT ts_ms, payload FROM journal WHERE kind = ? ORDER BY ts_ms DESC, id DESC LIMIT ?')
    .all(kind, limit) as Array<{ ts_ms: number; payload: string }>;
  return rows.map((r) => ({ tsMs: r.ts_ms, payload: JSON.parse(r.payload) as unknown }));
}

export function getState<T>(db: Database.Database, key: string): T | null {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
  return row === undefined ? null : (JSON.parse(row.value) as T);
}

export function setState(db: Database.Database, key: string, value: unknown): void {
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

export function saveRiskState(db: Database.Database, r: RiskState): void {
  setState(db, 'risk', r);
}
export function loadRiskState(db: Database.Database): RiskState {
  return getState<RiskState>(db, 'risk') ?? initialRiskState();
}

export function savePosition(db: Database.Database, p: PositionState | null): void {
  setState(db, 'position', p);
}
export function loadPosition(db: Database.Database): PositionState | null {
  return getState<PositionState | null>(db, 'position') ?? null;
}

export function recordExit(db: Database.Database, e: ExitRecord): void {
  db.prepare('INSERT INTO exits (at_ms, rule, side, pnl_usd) VALUES (?, ?, ?, ?)').run(e.atMs, e.rule, e.side, e.pnlUsd);
}
export function listExits(db: Database.Database, sinceMs: number): ExitRecord[] {
  const rows = db
    .prepare('SELECT at_ms, rule, side, pnl_usd FROM exits WHERE at_ms >= ? ORDER BY at_ms ASC, id ASC')
    .all(sinceMs) as Array<{ at_ms: number; rule: ExitRecord['rule']; side: ExitRecord['side']; pnl_usd: number }>;
  return rows.map((r) => ({ atMs: r.at_ms, rule: r.rule, side: r.side, pnlUsd: r.pnl_usd }));
}

/** Returns false (and stores nothing) when the item id was already recorded. */
export function recordAssessment(db: Database.Database, a: ImpactAssessment): boolean {
  const res = db.prepare('INSERT OR IGNORE INTO assessments (item_id, received_ms, json) VALUES (?, ?, ?)').run(a.itemId, a.receivedAtMs, JSON.stringify(a));
  return res.changes > 0;
}
export function listAssessments(db: Database.Database, sinceMs: number): ImpactAssessment[] {
  const rows = db
    .prepare('SELECT json FROM assessments WHERE received_ms >= ? ORDER BY received_ms ASC')
    .all(sinceMs) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as ImpactAssessment);
}

export function saveSnapshot(db: Database.Database, s: Snapshot): void {
  db.prepare('INSERT OR REPLACE INTO snapshots (ts_ms, mark, json) VALUES (?, ?, ?)').run(s.tsMs, s.perp.mark, JSON.stringify(s));
}
export function snapshotNear(db: Database.Database, tsMs: number, maxGapMs: number): Snapshot | null {
  const row = db
    .prepare('SELECT ts_ms, json FROM snapshots ORDER BY ABS(ts_ms - ?) ASC LIMIT 1')
    .get(tsMs) as { ts_ms: number; json: string } | undefined;
  if (row === undefined || Math.abs(row.ts_ms - tsMs) > maxGapMs) return null;
  return JSON.parse(row.json) as Snapshot;
}
export function markSeries(db: Database.Database, sinceMs: number): Array<{ tsMs: number; mark: number }> {
  const rows = db.prepare('SELECT ts_ms, mark FROM snapshots WHERE ts_ms >= ? ORDER BY ts_ms ASC').all(sinceMs) as Array<{ ts_ms: number; mark: number }>;
  return rows.map((r) => ({ tsMs: r.ts_ms, mark: r.mark }));
}

export function recordEquity(db: Database.Database, tsMs: number, equity: number): void {
  db.prepare('INSERT OR REPLACE INTO equity (ts_ms, equity) VALUES (?, ?)').run(tsMs, equity);
}
export function equityPeak(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(equity) AS m FROM equity').get() as { m: number | null };
  return row.m ?? 0;
}
```

- [ ] **Step 4: Run the whole perp suite and the typecheck**

Run: `cd ~/executor_module-perp && npx vitest run test/perp && npx tsc --noEmit`
Expected: every `test/perp` file passes; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
cd ~/executor_module-perp && git add src/perp test/perp && git -c user.name="Eamon McNamee" -c user.email=224684024+emcnamee-bs@users.noreply.github.com commit -m "feat(perp): SQLite store (journal, state, exits, assessments, snapshots, equity)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (against the spec)

- **Coverage:** spec 5.1 rules 2-6 and the weekend rule (Task 7); rule 1 (exchange-side trailing stop) is enforced by the broker in plan 2 and detected by the engine in plan 3; 5.2 formulas and the realized-leverage guard (Tasks 2, 4, 7); 5.3 entries including the short bar, confidence, lateness and no-trade windows (Task 7); 5.4 config (Task 1); 5.5 cooldowns (Task 5); 5.6 weekly close (Tasks 6, 7); 5.7 kill switch and staleness (Tasks 5, 7); section 6 priors (Task 1 defaults); journal storage (Task 8). Collectors, model calls, brokers, engine, deployment and evaluation are in plans 2 and 3.
- **Placeholders:** none; every step has complete code and exact commands.
- **Type consistency:** `PositionState.tightenedUntilMs`, `Action` kinds (`hold|open|close|set_stop`), `NewItem`, `GovernorOutput`, `RiskState` and `ExitRecord` are defined once and used with the same names in Tasks 5-8 and in plans 2-3.
