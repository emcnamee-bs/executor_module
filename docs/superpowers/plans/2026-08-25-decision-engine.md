# Decision Engine (Slice 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For every keyphrase-matched item, run Haiku synopsis → Sonnet verify → Sonnet decide, then deterministically compute rung, fair-value shift, Kelly sizing, and gates against the live `KXAPRPOTUS` band ladder, and durably record the resulting decision (would-trade or skip, with reason) — without placing any real order.

**Architecture:** Eight new, mostly-independent modules under `src/decide/`, composed by one orchestrator (`pipeline.ts`) that's wired into `main.ts`'s existing per-item handler, triggered only when `matchedPhrases.length > 0`. The model-call stages (Haiku, Sonnet verify, Sonnet decide) are thin, separately-testable wrappers; all money-math (rung, baseline/shift pricing, Kelly, ceilings, gates) is pure deterministic code; every decision — traded or not — is written to a local SQLite ledger.

**Tech Stack:** Same as slices 1–2 (Node ≥20, TypeScript strict/ESM, vitest, `@anthropic-ai/sdk`) plus `better-sqlite3` for the decision ledger and the native `fetch` API for Kalshi's public, unauthenticated market-data endpoints (`api.elections.kalshi.com`).

**Spec:** `docs/superpowers/specs/2026-08-25-decision-engine-design.md`

## Global Constraints

- **Unit-naming discipline (load-bearing — do not mix these up):** every quantity measured in Kalshi price cents (0–100 per contract, or a dollar-cent notional total) is suffixed `Cents` in code (`yesAskCents`, `edgeCents`, `notionalCents`). Every quantity measured in RCP approval-rating percentage points (Sonnet's estimated shift, band boundaries, the baseline) is suffixed `Pts` (`magnitudePts`, `floorStrike`/`capStrike` are already in points by nature). These are two different, non-interchangeable units that happen to live on similar numeric scales — never assign one to a variable named for the other.
- **No real order placement anywhere in this slice.** The pipeline stops at recording a decision to the ledger. No Kalshi authentication, no signed requests — market-data reads used here are public and unauthenticated.
- **Rung is fully deterministic** — `tier 1–2 → REPORTED (stake 0.25)`; `tier 3–5 → RUMOR (stake 0.0)`; promoted to `CORROBORATED (stake 0.5)` when `story_key !== null && corroborations >= 2`. No `confirmed_sources` shortcut. `CONFIRMED` is unreachable in this version.
- **Entry-only scope.** A `(story_key, event_ticker)` pair that already has a `would_trade = 1` row in the ledger is skipped before any model call is made — no exits, no adds, no position-aware reasoning.
- **Risk ceilings, real dollars, enforced redundantly:** per-trade notional cap **$10 (1,000 cents)**; total open-exposure cap across all `would_trade = 1` ledger rows **$40 (4,000 cents)**. Both enforced at (a) the sizing-formula clamp, (b) a SQLite `CHECK`/`TRIGGER` on the ledger.
- **Manual kill switch, checked first.** `process.env.EXECUTOR_TRADING_HALTED === 'true'` short-circuits the whole pipeline to a recorded skip — before any Haiku/Sonnet/Kalshi call — so it also saves API cost when tripped.
- **Testing:** Kalshi market-data reads are public and free — test `kalshi.ts` with real HTTP calls, no restriction. Anthropic model calls cost real money — a small number of representative real-call end-to-end tests only (per-module happy path plus one rejection case each); the deterministic rung/sizing/gates/ledger logic gets exhaustive real-call-site testing (real SQLite, no mocks) driven by injected/stubbed model outputs, since its correctness depends only on what those outputs *are*, not on how they were produced.
- **Structured model output is always validated before use**, never trusted as `as any` and passed straight into money-math — per the lesson from slice 2's final review (a malformed model response must never silently corrupt downstream state).

---

### Task 1: Rung computation

**Files:**
- Create: `src/decide/rung.ts`
- Test: `test/decide/rung.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `export type Rung = 'rumor' | 'reported' | 'corroborated' | 'confirmed';`
  - `export const RUNG_STAKES: Record<Rung, number>` — `{ rumor: 0.0, reported: 0.25, corroborated: 0.5, confirmed: 1.0 }`
  - `export interface RungInput { trustTier: number; storyKey: string | null; corroborations: number }`
  - `export function computeRung(input: RungInput): Rung`

- [ ] **Step 1: Write failing tests**

```typescript
// test/decide/rung.test.ts
import { describe, it, expect } from 'vitest';
import { computeRung, RUNG_STAKES } from '../../src/decide/rung.js';

describe('RUNG_STAKES', () => {
  it('has the four expected stake values', () => {
    expect(RUNG_STAKES).toEqual({
      rumor: 0.0,
      reported: 0.25,
      corroborated: 0.5,
      confirmed: 1.0,
    });
  });
});

describe('computeRung', () => {
  it('tier 1 with no story_key floors at reported', () => {
    expect(computeRung({ trustTier: 1, storyKey: null, corroborations: 0 })).toBe('reported');
  });

  it('tier 2 with no story_key floors at reported', () => {
    expect(computeRung({ trustTier: 2, storyKey: null, corroborations: 0 })).toBe('reported');
  });

  it('tier 3 with no story_key floors at rumor', () => {
    expect(computeRung({ trustTier: 3, storyKey: null, corroborations: 0 })).toBe('rumor');
  });

  it('tier 5 with no story_key floors at rumor', () => {
    expect(computeRung({ trustTier: 5, storyKey: null, corroborations: 0 })).toBe('rumor');
  });

  it('promotes to corroborated when story_key is set and corroborations >= 2, regardless of tier', () => {
    expect(computeRung({ trustTier: 3, storyKey: 'story-1', corroborations: 2 })).toBe('corroborated');
    expect(computeRung({ trustTier: 1, storyKey: 'story-1', corroborations: 3 })).toBe('corroborated');
  });

  it('does not promote when corroborations is 1 (reporter alone)', () => {
    expect(computeRung({ trustTier: 1, storyKey: 'story-1', corroborations: 1 })).toBe('reported');
    expect(computeRung({ trustTier: 3, storyKey: 'story-1', corroborations: 1 })).toBe('rumor');
  });

  it('ignores a nonzero corroborations count when story_key is null', () => {
    expect(computeRung({ trustTier: 3, storyKey: null, corroborations: 5 })).toBe('rumor');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/rung.test.ts`
Expected: FAIL — `src/decide/rung.ts` does not exist yet.

- [ ] **Step 3: Implement `src/decide/rung.ts`**

```typescript
// src/decide/rung.ts

export type Rung = 'rumor' | 'reported' | 'corroborated' | 'confirmed';

export const RUNG_STAKES: Record<Rung, number> = {
  rumor: 0.0,
  reported: 0.25,
  corroborated: 0.5,
  confirmed: 1.0,
};

export interface RungInput {
  trustTier: number;
  storyKey: string | null;
  corroborations: number;
}

/**
 * No `confirmed_sources` shortcut exists in this version (deliberate, per the
 * design spec) -- `confirmed` is unreachable. Corroboration promotion always
 * wins over the tier floor when it qualifies, since corroborated (0.5) is
 * never weaker than reported (0.25).
 */
export function computeRung(input: RungInput): Rung {
  const totalDistinctSources = input.storyKey !== null ? input.corroborations : 0;
  if (totalDistinctSources >= 2) {
    return 'corroborated';
  }
  return input.trustTier <= 2 ? 'reported' : 'rumor';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/rung.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/decide/rung.ts test/decide/rung.test.ts
git commit -m "feat: add deterministic rung computation"
```

---

### Task 2: Kalshi market-data client

**Files:**
- Create: `src/decide/kalshi.ts`
- Test: `test/decide/kalshi.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `export interface BandMarket { ticker: string; floorStrike: number | null; capStrike: number | null; strikeType: 'less' | 'greater' | 'between'; status: string; yesAskCents: number | null; yesBidCents: number | null; yesAskSizeContracts: number; yesBidSizeContracts: number }`
  - `export interface ActiveLadder { eventTicker: string; strikeDate: string; bands: BandMarket[] }`
  - `export async function fetchActiveLadder(seriesTicker: string): Promise<ActiveLadder | null>` — `null` when no open event exists for the series.

**Prerequisite:** none — this hits Kalshi's real public API, which needs no credentials and no local service.

- [ ] **Step 1: Write failing tests**

```typescript
// test/decide/kalshi.test.ts
import { describe, it, expect } from 'vitest';
import { fetchActiveLadder } from '../../src/decide/kalshi.js';

describe('fetchActiveLadder (real Kalshi API)', () => {
  it('returns the currently active KXAPRPOTUS weekly event with a full band ladder', async () => {
    const ladder = await fetchActiveLadder('KXAPRPOTUS');

    expect(ladder).not.toBeNull();
    if (!ladder) return;

    expect(ladder.eventTicker).toMatch(/^KXAPRPOTUS-\d{2}[A-Z]{3}\d{2}$/);
    expect(ladder.bands.length).toBeGreaterThan(0);

    for (const band of ladder.bands) {
      expect(band.ticker.startsWith(ladder.eventTicker)).toBe(true);
      expect(['less', 'greater', 'between']).toContain(band.strikeType);
      if (band.strikeType === 'between') {
        expect(band.floorStrike).not.toBeNull();
        expect(band.capStrike).not.toBeNull();
      }
      if (band.strikeType === 'greater') {
        expect(band.floorStrike).not.toBeNull();
        expect(band.capStrike).toBeNull();
      }
      if (band.strikeType === 'less') {
        expect(band.capStrike).not.toBeNull();
        expect(band.floorStrike).toBeNull();
      }
      if (band.yesAskCents !== null) {
        expect(band.yesAskCents).toBeGreaterThan(0);
        expect(band.yesAskCents).toBeLessThanOrEqual(100);
      }
      if (band.yesBidCents !== null) {
        expect(band.yesBidCents).toBeGreaterThanOrEqual(0);
        expect(band.yesBidCents).toBeLessThan(100);
      }
      expect(band.yesAskSizeContracts).toBeGreaterThanOrEqual(0);
      expect(band.yesBidSizeContracts).toBeGreaterThanOrEqual(0);
    }
  }, 15000);

  it('returns null for a series with no open event', async () => {
    const ladder = await fetchActiveLadder('KXNONEXISTENTSERIESXYZ');
    expect(ladder).toBeNull();
  }, 15000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/kalshi.test.ts`
Expected: FAIL — `src/decide/kalshi.ts` does not exist yet.

- [ ] **Step 3: Implement `src/decide/kalshi.ts`**

```typescript
// src/decide/kalshi.ts

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface BandMarket {
  ticker: string;
  floorStrike: number | null;
  capStrike: number | null;
  strikeType: 'less' | 'greater' | 'between';
  status: string;
  /** null when Kalshi reports no resting order on this side (raw price exactly 0.0000). */
  yesAskCents: number | null;
  yesBidCents: number | null;
  yesAskSizeContracts: number;
  yesBidSizeContracts: number;
}

export interface ActiveLadder {
  eventTicker: string;
  strikeDate: string;
  bands: BandMarket[];
}

interface KalshiEvent {
  event_ticker: string;
  strike_date: string;
}

interface KalshiEventsResponse {
  events: KalshiEvent[];
}

interface KalshiMarket {
  ticker: string;
  floor_strike?: number;
  cap_strike?: number;
  strike_type: 'less' | 'greater' | 'between';
  status: string;
  yes_ask_dollars: string;
  yes_bid_dollars: string;
  yes_ask_size_fp: string;
  yes_bid_size_fp: string;
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
}

/** Kalshi reports "no resting order" as an exact 0.0000, not a missing field. */
function priceCentsOrNull(raw: string): number | null {
  const dollars = parseFloat(raw);
  const cents = Math.round(dollars * 100);
  return cents > 0 ? cents : null;
}

function sizeContracts(raw: string): number {
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export async function fetchActiveLadder(seriesTicker: string): Promise<ActiveLadder | null> {
  const eventsUrl = `${KALSHI_API_BASE}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open`;
  const eventsRes = await fetch(eventsUrl);
  if (!eventsRes.ok) {
    throw new Error(`Kalshi events fetch failed: ${eventsRes.status} ${eventsRes.statusText}`);
  }
  const eventsBody = (await eventsRes.json()) as KalshiEventsResponse;
  if (eventsBody.events.length === 0) {
    return null;
  }

  const active = [...eventsBody.events].sort((a, b) => a.strike_date.localeCompare(b.strike_date))[0];

  const marketsUrl = `${KALSHI_API_BASE}/markets?event_ticker=${encodeURIComponent(active.event_ticker)}&status=open`;
  const marketsRes = await fetch(marketsUrl);
  if (!marketsRes.ok) {
    throw new Error(`Kalshi markets fetch failed: ${marketsRes.status} ${marketsRes.statusText}`);
  }
  const marketsBody = (await marketsRes.json()) as KalshiMarketsResponse;

  const bands: BandMarket[] = marketsBody.markets.map((m) => ({
    ticker: m.ticker,
    floorStrike: m.floor_strike ?? null,
    capStrike: m.cap_strike ?? null,
    strikeType: m.strike_type,
    status: m.status,
    yesAskCents: priceCentsOrNull(m.yes_ask_dollars),
    yesBidCents: priceCentsOrNull(m.yes_bid_dollars),
    yesAskSizeContracts: sizeContracts(m.yes_ask_size_fp),
    yesBidSizeContracts: sizeContracts(m.yes_bid_size_fp),
  }));

  return { eventTicker: active.event_ticker, strikeDate: active.strike_date, bands };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/kalshi.test.ts`
Expected: PASS. If the first test fails on the `strikeType`-specific assertions, print `JSON.stringify(ladder, null, 2)` and confirm against the live API response shape — the market may have shifted since this plan was written, but the field names/shapes should not have.

- [ ] **Step 5: Commit**

```bash
git add src/decide/kalshi.ts test/decide/kalshi.test.ts
git commit -m "feat: add read-only Kalshi market-data client"
```

---

### Task 3: Decision ledger

**Files:**
- Modify: `package.json` (add `better-sqlite3` + `@types/better-sqlite3`)
- Modify: `.gitignore` (add `data/decisions.db`)
- Create: `src/decide/ledger.ts`
- Test: `test/decide/ledger.test.ts`

**Interfaces:**
- Consumes: `Rung` type from Task 1 (`src/decide/rung.ts`).
- Produces:
  - `export interface DecisionRecord { itemId: string; storyKey: string | null; eventTicker: string | null; marketTicker: string | null; side: 'yes' | 'no' | null; rung: Rung; direction: 'up' | 'down' | null; magnitudePts: number | null; contracts: number; entryPriceCents: number | null; notionalCents: number; edgeCents: number | null; wouldTrade: boolean; reason: string }`
  - `export function openLedger(dbPath: string): Database.Database`
  - `export function recordDecision(db: Database.Database, record: DecisionRecord): void` — throws if the total-exposure trigger rejects the insert.
  - `export function hasOpenPosition(db: Database.Database, storyKey: string, eventTicker: string): boolean`
  - `export function totalExposureCents(db: Database.Database): number`

- [ ] **Step 1: Add the `better-sqlite3` dependency**

Add to `package.json`'s `dependencies`:

```json
    "better-sqlite3": "^11.3.0",
```

Add to `devDependencies`:

```json
    "@types/better-sqlite3": "^7.6.11",
```

Run: `npm install`
Expected: installs cleanly, `package-lock.json` updated.

- [ ] **Step 2: Add the runtime database file to `.gitignore`**

Add this line to `.gitignore` (this is generated runtime state, not source):

```
data/decisions.db
```

- [ ] **Step 3: Write failing tests**

```typescript
// test/decide/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openLedger,
  recordDecision,
  hasOpenPosition,
  totalExposureCents,
  type DecisionRecord,
} from '../../src/decide/ledger.js';
import type Database from 'better-sqlite3';

function skipRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: 'item-1',
    storyKey: null,
    eventTicker: null,
    marketTicker: null,
    side: null,
    rung: 'rumor',
    direction: null,
    magnitudePts: null,
    contracts: 0,
    entryPriceCents: null,
    notionalCents: 0,
    edgeCents: null,
    wouldTrade: false,
    reason: 'rumor rung, stake 0',
    ...overrides,
  };
}

function tradeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: 'item-2',
    storyKey: 'story-1',
    eventTicker: 'KXAPRPOTUS-26AUG28',
    marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
    side: 'yes',
    rung: 'reported',
    direction: 'up',
    magnitudePts: 0.3,
    contracts: 10,
    entryPriceCents: 10,
    notionalCents: 100,
    edgeCents: 3,
    wouldTrade: true,
    reason: '10 contracts, 3c edge',
    ...overrides,
  };
}

describe('ledger', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a skip decision', () => {
    expect(() => recordDecision(db, skipRecord())).not.toThrow();
  });

  it('records a would-trade decision within the per-trade cap', () => {
    expect(() => recordDecision(db, tradeRecord())).not.toThrow();
  });

  it('rejects a would-trade decision over the $10 per-trade cap at the database layer', () => {
    expect(() => recordDecision(db, tradeRecord({ notionalCents: 1001 }))).toThrow();
  });

  it('allows a skip decision with notionalCents 0 regardless of other fields', () => {
    expect(() => recordDecision(db, skipRecord({ notionalCents: 0 }))).not.toThrow();
  });

  it('reports no open position for a story never recorded', () => {
    expect(hasOpenPosition(db, 'story-unknown', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('reports an open position after a would-trade decision for that story+event', () => {
    recordDecision(db, tradeRecord({ storyKey: 'story-2', eventTicker: 'KXAPRPOTUS-26AUG28' }));
    expect(hasOpenPosition(db, 'story-2', 'KXAPRPOTUS-26AUG28')).toBe(true);
  });

  it('does not treat a skip decision as an open position', () => {
    recordDecision(db, skipRecord({ storyKey: 'story-3', eventTicker: 'KXAPRPOTUS-26AUG28' }));
    expect(hasOpenPosition(db, 'story-3', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('scopes open-position checks to the given event_ticker, not all-time', () => {
    recordDecision(
      db,
      tradeRecord({ storyKey: 'story-4', eventTicker: 'KXAPRPOTUS-26AUG21' })
    );
    expect(hasOpenPosition(db, 'story-4', 'KXAPRPOTUS-26AUG21')).toBe(true);
    expect(hasOpenPosition(db, 'story-4', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('sums total exposure across would-trade rows only', () => {
    recordDecision(db, tradeRecord({ storyKey: 's-a', notionalCents: 500 }));
    recordDecision(db, tradeRecord({ storyKey: 's-b', notionalCents: 300 }));
    recordDecision(db, skipRecord({ storyKey: 's-c' }));
    expect(totalExposureCents(db)).toBe(800);
  });

  it('rejects a would-trade insert that would push total exposure over the $40 cap', () => {
    recordDecision(db, tradeRecord({ storyKey: 's-x', notionalCents: 1000 }));
    recordDecision(db, tradeRecord({ storyKey: 's-y', notionalCents: 1000 }));
    recordDecision(db, tradeRecord({ storyKey: 's-z', notionalCents: 1000 }));
    recordDecision(db, tradeRecord({ storyKey: 's-w', notionalCents: 1000 }));
    // total is now exactly 4000 (the cap) -- one more cent of would-trade notional must reject
    expect(() =>
      recordDecision(db, tradeRecord({ storyKey: 's-over', notionalCents: 1 }))
    ).toThrow();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/decide/ledger.test.ts`
Expected: FAIL — `src/decide/ledger.ts` does not exist yet.

- [ ] **Step 5: Implement `src/decide/ledger.ts`**

```typescript
// src/decide/ledger.ts
import Database from 'better-sqlite3';
import type { Rung } from './rung.js';

export const MAX_NOTIONAL_CENTS_PER_TRADE = 1000;
export const MAX_TOTAL_EXPOSURE_CENTS = 4000;

export interface DecisionRecord {
  itemId: string;
  storyKey: string | null;
  eventTicker: string | null;
  marketTicker: string | null;
  side: 'yes' | 'no' | null;
  rung: Rung;
  direction: 'up' | 'down' | null;
  magnitudePts: number | null;
  contracts: number;
  entryPriceCents: number | null;
  notionalCents: number;
  edgeCents: number | null;
  wouldTrade: boolean;
  reason: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  story_key TEXT,
  event_ticker TEXT,
  market_ticker TEXT,
  side TEXT CHECK (side IN ('yes','no') OR side IS NULL),
  rung TEXT NOT NULL CHECK (rung IN ('rumor','reported','corroborated','confirmed')),
  direction TEXT CHECK (direction IN ('up','down') OR direction IS NULL),
  magnitude_pts REAL,
  contracts INTEGER NOT NULL DEFAULT 0 CHECK (contracts >= 0),
  entry_price_cents INTEGER CHECK (entry_price_cents IS NULL OR (entry_price_cents > 0 AND entry_price_cents < 100)),
  notional_cents INTEGER NOT NULL DEFAULT 0 CHECK (notional_cents >= 0 AND notional_cents <= ${MAX_NOTIONAL_CENTS_PER_TRADE}),
  edge_cents REAL,
  would_trade INTEGER NOT NULL CHECK (would_trade IN (0,1)),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER IF NOT EXISTS enforce_total_exposure
BEFORE INSERT ON decisions
WHEN NEW.would_trade = 1
BEGIN
  SELECT RAISE(ABORT, 'total exposure cap exceeded')
  WHERE (SELECT COALESCE(SUM(notional_cents), 0) FROM decisions WHERE would_trade = 1)
        + NEW.notional_cents > ${MAX_TOTAL_EXPOSURE_CENTS};
END;
`;

export function openLedger(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function recordDecision(db: Database.Database, record: DecisionRecord): void {
  db.prepare(
    `INSERT INTO decisions
      (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
       magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
       would_trade, reason)
     VALUES (@itemId, @storyKey, @eventTicker, @marketTicker, @side, @rung, @direction,
       @magnitudePts, @contracts, @entryPriceCents, @notionalCents, @edgeCents,
       @wouldTrade, @reason)`
  ).run({
    ...record,
    wouldTrade: record.wouldTrade ? 1 : 0,
  });
}

export function hasOpenPosition(db: Database.Database, storyKey: string, eventTicker: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM decisions
       WHERE story_key = ? AND event_ticker = ? AND would_trade = 1
       LIMIT 1`
    )
    .get(storyKey, eventTicker);
  return row !== undefined;
}

export function totalExposureCents(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(notional_cents), 0) AS total FROM decisions WHERE would_trade = 1`)
    .get() as { total: number };
  return row.total;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/decide/ledger.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore src/decide/ledger.ts test/decide/ledger.test.ts
git commit -m "feat: add decision ledger with redundant exposure ceilings"
```

---

### Task 4: Sizing & gates module

**Files:**
- Create: `src/decide/sizing.ts`
- Test: `test/decide/sizing.test.ts`

**Interfaces:**
- Consumes: `Rung`, `RUNG_STAKES` from Task 1 (`src/decide/rung.ts`); `BandMarket` from Task 2 (`src/decide/kalshi.ts`).
- Produces:
  - `export interface SizingInput { bands: BandMarket[]; rung: Rung; direction: 'up' | 'down'; magnitudePts: number; currentTotalExposureCents: number }`
  - `export interface SizingResult { wouldTrade: boolean; marketTicker: string | null; side: 'yes' | 'no' | null; contracts: number; entryPriceCents: number | null; notionalCents: number; edgeCents: number | null; reason: string }`
  - `export function evaluateSizing(input: SizingInput): SizingResult`

This module is entirely pure — no network, no database. It is the money-math core and gets the most exhaustive test coverage in this plan.

- [ ] **Step 1: Write failing tests**

```typescript
// test/decide/sizing.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateSizing, type SizingInput } from '../../src/decide/sizing.js';
import type { BandMarket } from '../../src/decide/kalshi.js';
import type { Rung } from '../../src/decide/rung.js';

function band(overrides: Partial<BandMarket>): BandMarket {
  return {
    ticker: 'KXAPRPOTUS-26AUG28-40.1',
    floorStrike: 40.0,
    capStrike: 40.2,
    strikeType: 'between',
    status: 'active',
    yesAskCents: 40,
    yesBidCents: 38,
    yesAskSizeContracts: 500,
    yesBidSizeContracts: 500,
    ...overrides,
  };
}

/**
 * A five-band ladder centered on 40.0-41.0, priced so the market-implied
 * baseline sits right around 40.5 (each band's yes price roughly tracks a
 * bell curve peaking at the 40.4-40.6 band).
 */
function baseLadder(): BandMarket[] {
  return [
    band({
      ticker: 'K-39.8',
      floorStrike: null,
      capStrike: 40.0,
      strikeType: 'less',
      yesAskCents: 10,
      yesBidCents: 8,
    }),
    band({
      ticker: 'K-40.0',
      floorStrike: 40.0,
      capStrike: 40.2,
      strikeType: 'between',
      yesAskCents: 25,
      yesBidCents: 23,
    }),
    band({
      ticker: 'K-40.2',
      floorStrike: 40.2,
      capStrike: 40.4,
      strikeType: 'between',
      yesAskCents: 40,
      yesBidCents: 38,
    }),
    band({
      ticker: 'K-40.4',
      floorStrike: 40.4,
      capStrike: 40.6,
      strikeType: 'between',
      yesAskCents: 42,
      yesBidCents: 40,
    }),
    band({
      ticker: 'K-40.6',
      floorStrike: 40.6,
      capStrike: null,
      strikeType: 'greater',
      yesAskCents: 12,
      yesBidCents: 10,
    }),
  ];
}

function baseInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    bands: baseLadder(),
    rung: 'reported' as Rung,
    direction: 'up',
    magnitudePts: 0.3,
    currentTotalExposureCents: 0,
    ...overrides,
  };
}

describe('evaluateSizing', () => {
  it('finds a would-trade band when an upward shift creates edge', () => {
    const result = evaluateSizing(baseInput());
    expect(result.wouldTrade).toBe(true);
    expect(result.marketTicker).not.toBeNull();
    expect(result.side).toBe('yes');
    expect(result.contracts).toBeGreaterThan(0);
    expect(result.notionalCents).toBeGreaterThan(0);
    expect(result.notionalCents).toBeLessThanOrEqual(1000);
  });

  it('declines when rung is rumor (stake 0) regardless of edge', () => {
    const result = evaluateSizing(baseInput({ rung: 'rumor' }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/rumor|stake/i);
  });

  it('declines when magnitude_pts is zero (no shift, no edge)', () => {
    const result = evaluateSizing(baseInput({ magnitudePts: 0 }));
    expect(result.wouldTrade).toBe(false);
  });

  it('declines a band whose spread exceeds 5 cents', () => {
    const wideSpreadLadder = baseLadder().map((b) =>
      b.ticker === 'K-40.4' ? { ...b, yesAskCents: 42, yesBidCents: 30 } : b
    );
    const result = evaluateSizing(baseInput({ bands: wideSpreadLadder, magnitudePts: 0.05 }));
    // With every band's edge this small, the only band that might have cleared
    // now fails the spread gate -- assert it is not the wide-spread band that traded.
    if (result.wouldTrade) {
      expect(result.marketTicker).not.toBe('K-40.4');
    }
  });

  it('declines a band with zero depth at the entry price', () => {
    const noDepthLadder = baseLadder().map((b) =>
      b.ticker === 'K-40.4' ? { ...b, yesAskSizeContracts: 0 } : b
    );
    const result = evaluateSizing(baseInput({ bands: noDepthLadder }));
    if (result.wouldTrade) {
      expect(result.marketTicker).not.toBe('K-40.4');
    }
  });

  it('declines a band with no resting ask on the entry side', () => {
    const noAskLadder = baseLadder().map((b) =>
      b.ticker === 'K-40.4' ? { ...b, yesAskCents: null } : b
    );
    const result = evaluateSizing(baseInput({ bands: noAskLadder }));
    if (result.wouldTrade) {
      expect(result.marketTicker).not.toBe('K-40.4');
    }
  });

  it('declines every band when price is outside the 10-90 cent tradeable range', () => {
    const extremeLadder = baseLadder().map((b) => ({ ...b, yesAskCents: 95, yesBidCents: 93 }));
    const result = evaluateSizing(baseInput({ bands: extremeLadder }));
    expect(result.wouldTrade).toBe(false);
  });

  it('clamps contracts so notional never exceeds the $10 per-trade cap', () => {
    const cheapLadder = baseLadder().map((b) =>
      b.ticker === 'K-40.4' ? { ...b, yesAskCents: 2, yesBidCents: 1, yesAskSizeContracts: 100000 } : b
    );
    const result = evaluateSizing(
      baseInput({ bands: cheapLadder, rung: 'confirmed', magnitudePts: 5 })
    );
    expect(result.notionalCents).toBeLessThanOrEqual(1000);
  });

  it('declines when the trade would push total exposure over the $40 cap', () => {
    const result = evaluateSizing(baseInput({ currentTotalExposureCents: 4000 }));
    expect(result.wouldTrade).toBe(false);
    expect(result.reason).toMatch(/exposure/i);
  });

  it('allows a trade that exactly reaches, but does not exceed, the $40 cap', () => {
    const result = evaluateSizing(baseInput({ currentTotalExposureCents: 3990 }));
    // Either it trades within the remaining $0.10, or it declines because no
    // band's clamped size fits in that remaining room -- both are valid, but
    // it must never report a notional that would push the total over 4000.
    expect(result.notionalCents).toBeLessThanOrEqual(10);
  });

  it('a stronger rung produces a larger or equal position than a weaker rung, same market conditions', () => {
    const reported = evaluateSizing(baseInput({ rung: 'reported' }));
    const confirmed = evaluateSizing(baseInput({ rung: 'confirmed' }));
    expect(confirmed.contracts).toBeGreaterThanOrEqual(reported.contracts);
  });

  it('a downward direction can find edge on the low side of the ladder', () => {
    const result = evaluateSizing(baseInput({ direction: 'down', magnitudePts: 0.3 }));
    // Not asserting wouldTrade=true unconditionally (depends on the exact
    // interpolated curve), but if it trades, side must still be a valid value.
    if (result.wouldTrade) {
      expect(['yes', 'no']).toContain(result.side);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/sizing.test.ts`
Expected: FAIL — `src/decide/sizing.ts` does not exist yet.

- [ ] **Step 3: Implement `src/decide/sizing.ts`**

```typescript
// src/decide/sizing.ts
import type { BandMarket } from './kalshi.js';
import { RUNG_STAKES, type Rung } from './rung.js';

const SETTLEMENT_CENTS = 100;
const MAX_SPREAD_CENTS = 5;
const MIN_DEPTH_CONTRACTS = 1;
const MIN_PRICE_CENTS = 10;
const MAX_PRICE_CENTS = 90;
const MIN_EDGE_CENTS = 0.5;
const MAX_NOTIONAL_CENTS_PER_TRADE = 1000;
const MAX_TOTAL_EXPOSURE_CENTS = 4000;
const DEFAULT_BAND_WIDTH_PTS = 0.2;

export interface SizingInput {
  bands: BandMarket[];
  rung: Rung;
  direction: 'up' | 'down';
  magnitudePts: number;
  currentTotalExposureCents: number;
}

export interface SizingResult {
  wouldTrade: boolean;
  marketTicker: string | null;
  side: 'yes' | 'no' | null;
  contracts: number;
  entryPriceCents: number | null;
  notionalCents: number;
  edgeCents: number | null;
  reason: string;
}

function typicalBandWidthPts(bands: BandMarket[]): number {
  const widths = bands
    .filter((b): b is BandMarket & { floorStrike: number; capStrike: number } =>
      b.floorStrike !== null && b.capStrike !== null
    )
    .map((b) => b.capStrike - b.floorStrike);
  if (widths.length === 0) return DEFAULT_BAND_WIDTH_PTS;
  return widths.reduce((a, w) => a + w, 0) / widths.length;
}

function bandMidpointPts(band: BandMarket, widthPts: number): number {
  if (band.floorStrike !== null && band.capStrike !== null) {
    return (band.floorStrike + band.capStrike) / 2;
  }
  if (band.floorStrike !== null) {
    return band.floorStrike + widthPts / 2;
  }
  if (band.capStrike !== null) {
    return band.capStrike - widthPts / 2;
  }
  throw new Error(`band ${band.ticker} has neither floorStrike nor capStrike`);
}

function bandYesProbability(band: BandMarket): number | null {
  if (band.yesAskCents === null || band.yesBidCents === null) return null;
  return (band.yesAskCents + band.yesBidCents) / 200;
}

interface CurvePoint {
  centerPts: number;
  probability: number;
}

function buildProbabilityCurve(bands: BandMarket[], widthPts: number): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (const b of bands) {
    const p = bandYesProbability(b);
    if (p === null) continue;
    points.push({ centerPts: bandMidpointPts(b, widthPts), probability: p });
  }
  return points.sort((a, b) => a.centerPts - b.centerPts);
}

function interpolateProbability(curve: CurvePoint[], targetPts: number): number {
  if (curve.length === 0) return 0;
  if (targetPts <= curve[0].centerPts) return curve[0].probability;
  const last = curve[curve.length - 1];
  if (targetPts >= last.centerPts) return last.probability;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (targetPts >= a.centerPts && targetPts <= b.centerPts) {
      const t = (targetPts - a.centerPts) / (b.centerPts - a.centerPts);
      return a.probability + t * (b.probability - a.probability);
    }
  }
  return 0;
}

function kellyFraction(fairPriceCents: number, askCents: number): number {
  if (!(askCents > 0 && askCents < SETTLEMENT_CENTS)) return 0;
  const fraction = (fairPriceCents - askCents) / (SETTLEMENT_CENTS - askCents);
  return Math.max(0, fraction);
}

interface BandCandidate {
  ticker: string;
  side: 'yes' | 'no';
  askCents: number;
  spreadCents: number;
  depthContracts: number;
  fairPriceCents: number;
  edgeCents: number;
}

function evaluateBand(
  band: BandMarket,
  curve: CurvePoint[],
  widthPts: number,
  signedMagnitudePts: number
): BandCandidate[] {
  const targetPts = bandMidpointPts(band, widthPts) - signedMagnitudePts;
  const fairProbability = interpolateProbability(curve, targetPts);
  const fairPriceCents = Math.round(fairProbability * 100);
  const candidates: BandCandidate[] = [];

  if (band.yesAskCents !== null && band.yesBidCents !== null) {
    candidates.push({
      ticker: band.ticker,
      side: 'yes',
      askCents: band.yesAskCents,
      spreadCents: band.yesAskCents - band.yesBidCents,
      depthContracts: band.yesAskSizeContracts,
      fairPriceCents,
      edgeCents: fairPriceCents - band.yesAskCents,
    });
  }

  // The NO side of a binary Kalshi market is the complement of the same book:
  // no_ask = 100 - yes_bid (consuming the NO ask fills the resting YES bid).
  if (band.yesBidCents !== null && band.yesAskCents !== null) {
    const noAskCents = SETTLEMENT_CENTS - band.yesBidCents;
    const noFairPriceCents = SETTLEMENT_CENTS - fairPriceCents;
    candidates.push({
      ticker: band.ticker,
      side: 'no',
      askCents: noAskCents,
      spreadCents: band.yesAskCents - band.yesBidCents,
      depthContracts: band.yesBidSizeContracts,
      fairPriceCents: noFairPriceCents,
      edgeCents: noFairPriceCents - noAskCents,
    });
  }

  return candidates;
}

export function evaluateSizing(input: SizingInput): SizingResult {
  const decline = (reason: string): SizingResult => ({
    wouldTrade: false,
    marketTicker: null,
    side: null,
    contracts: 0,
    entryPriceCents: null,
    notionalCents: 0,
    edgeCents: null,
    reason,
  });

  const stake = RUNG_STAKES[input.rung];
  if (stake <= 0) {
    return decline(`rung is ${input.rung}, stake ${stake} -- never trades`);
  }

  const widthPts = typicalBandWidthPts(input.bands);
  const curve = buildProbabilityCurve(input.bands, widthPts);
  if (curve.length === 0) {
    return decline('no band has a usable two-sided price; cannot build a fair-value curve');
  }

  const signedMagnitudePts = input.direction === 'up' ? input.magnitudePts : -input.magnitudePts;

  const remainingExposureCents = MAX_TOTAL_EXPOSURE_CENTS - input.currentTotalExposureCents;
  if (remainingExposureCents <= 0) {
    return decline(`total exposure cap reached (${input.currentTotalExposureCents}c of ${MAX_TOTAL_EXPOSURE_CENTS}c)`);
  }

  let best: BandCandidate | null = null;

  for (const band of input.bands) {
    if (band.status !== 'active') continue;
    for (const candidate of evaluateBand(band, curve, widthPts, signedMagnitudePts)) {
      if (candidate.askCents < MIN_PRICE_CENTS || candidate.askCents > MAX_PRICE_CENTS) continue;
      if (candidate.spreadCents > MAX_SPREAD_CENTS) continue;
      if (candidate.depthContracts < MIN_DEPTH_CONTRACTS) continue;
      if (candidate.edgeCents < MIN_EDGE_CENTS) continue;

      const kelly = kellyFraction(candidate.fairPriceCents, candidate.askCents);
      if (kelly <= 0) continue;

      if (best === null || candidate.edgeCents > best.edgeCents) {
        best = candidate;
      }
    }
  }

  if (best === null) {
    return decline('no band cleared the tradeability/edge gates after the fair-value shift');
  }

  const kelly = kellyFraction(best.fairPriceCents, best.askCents);
  const byCeiling = Math.floor(MAX_NOTIONAL_CENTS_PER_TRADE / best.askCents);
  const byExposureRemaining = Math.floor(remainingExposureCents / best.askCents);
  const byKellyStake = Math.floor(byCeiling * kelly * stake);
  const contracts = Math.max(0, Math.min(byKellyStake, best.depthContracts, byExposureRemaining));

  if (contracts <= 0) {
    return decline('sized to zero contracts after Kelly/stake/depth/exposure clamps');
  }

  const notionalCents = contracts * best.askCents;

  return {
    wouldTrade: true,
    marketTicker: best.ticker,
    side: best.side,
    contracts,
    entryPriceCents: best.askCents,
    notionalCents,
    edgeCents: best.edgeCents,
    reason: `${contracts} contracts, ${best.edgeCents.toFixed(2)}c edge, stake ${stake}`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/sizing.test.ts`
Expected: PASS, all cases. If the fair-value/curve tests behave unexpectedly, log `JSON.stringify({ widthPts, curve }, null, 2)` from inside a temporary debug branch to inspect the interpolation — the ladder fixture's exact numbers were chosen to make an upward shift find edge on the `K-40.4`/`K-40.6` side, but the precise winning band is a function of the interpolation and is intentionally not hardcoded into the assertions.

- [ ] **Step 5: Commit**

```bash
git add src/decide/sizing.ts test/decide/sizing.test.ts
git commit -m "feat: add deterministic Kelly sizing and gates over the band ladder"
```

---

### Task 5: Haiku synopsis step

**Files:**
- Create: `src/decide/synopsis.ts`
- Test: `test/decide/synopsis.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `export async function synopsize(client: Anthropic, headline: string, snippet: string | null): Promise<string>`

**Prerequisite:** `ANTHROPIC_API_KEY` available via `.envrc`/direnv, same as slice 2.

- [ ] **Step 1: Write failing tests**

```typescript
// test/decide/synopsis.test.ts
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { synopsize } from '../../src/decide/synopsis.js';

describe('synopsize (real Haiku call)', () => {
  it('produces a non-empty summary of a headline and snippet', async () => {
    const client = new Anthropic();
    const summary = await synopsize(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced today that the national unemployment rate declined to 3.9%, beating economist expectations of 4.1%, driven by strong hiring in the services sector.'
    );

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
    expect(summary.toLowerCase()).toMatch(/unemploy|labor|job/);
  }, 20000);

  it('produces a summary from headline alone when snippet is null', async () => {
    const client = new Anthropic();
    const summary = await synopsize(client, 'State Department announces new sanctions on shipping firms', null);

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
  }, 20000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/synopsis.test.ts`
Expected: FAIL — `src/decide/synopsis.ts` does not exist yet.

- [ ] **Step 3: Implement `src/decide/synopsis.ts`**

```typescript
// src/decide/synopsis.ts
import Anthropic from '@anthropic-ai/sdk';

export async function synopsize(
  client: Anthropic,
  headline: string,
  snippet: string | null
): Promise<string> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Summarize what this news item is actually about, in 2-3 plain sentences. Do not speculate beyond what the text says, and do not add commentary about its significance.\n\n${sourceText}`,
      },
    ],
  });

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text'
  );
  if (!textBlock) {
    throw new Error('Haiku returned no text content for the synopsis');
  }
  const summary = textBlock.text.trim();
  if (summary.length === 0) {
    throw new Error('Haiku returned an empty synopsis');
  }
  return summary;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/synopsis.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/decide/synopsis.ts test/decide/synopsis.test.ts
git commit -m "feat: add Haiku synopsis step"
```

---

### Task 6: Sonnet verify step

**Files:**
- Create: `src/decide/verify.ts`
- Test: `test/decide/verify.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (takes plain strings).
- Produces:
  - `export interface VerifyResult { supported: boolean; note: string }`
  - `export async function verifySynopsis(client: Anthropic, headline: string, snippet: string | null, synopsis: string): Promise<VerifyResult>`

**Prerequisite:** same as Task 5.

- [ ] **Step 1: Write failing tests**

```typescript
// test/decide/verify.test.ts
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { verifySynopsis } from '../../src/decide/verify.js';

describe('verifySynopsis (real Sonnet call)', () => {
  it('supports a faithful synopsis of the source text', async () => {
    const client = new Anthropic();
    const result = await verifySynopsis(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July, beating expectations.',
      'The unemployment rate dropped to 3.9% in July, according to new BLS data, coming in better than economists expected.'
    );

    expect(result.supported).toBe(true);
    expect(typeof result.note).toBe('string');
  }, 20000);

  it('rejects a synopsis that fabricates a claim the source does not make', async () => {
    const client = new Anthropic();
    const result = await verifySynopsis(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July.',
      'The President announced a major new stimulus package to combat unemployment, sources say.'
    );

    expect(result.supported).toBe(false);
  }, 20000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/verify.test.ts`
Expected: FAIL — `src/decide/verify.ts` does not exist yet.

- [ ] **Step 3: Implement `src/decide/verify.ts`**

```typescript
// src/decide/verify.ts
import Anthropic from '@anthropic-ai/sdk';

export interface VerifyResult {
  supported: boolean;
  note: string;
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['supported', 'note'],
  additionalProperties: false,
};

function validateVerifyOutput(parsed: unknown): VerifyResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Sonnet returned an invalid verify output shape: ${JSON.stringify(parsed)}`);
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.supported !== 'boolean') {
    throw new Error(`Sonnet returned an invalid "supported" field: ${JSON.stringify(p.supported)}`);
  }
  if (typeof p.note !== 'string') {
    throw new Error(`Sonnet returned an invalid "note" field: ${JSON.stringify(p.note)}`);
  }
  return { supported: p.supported, note: p.note };
}

export async function verifySynopsis(
  client: Anthropic,
  headline: string,
  snippet: string | null,
  synopsis: string
): Promise<VerifyResult> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Source text:\n${sourceText}\n\nProposed synopsis:\n${synopsis}\n\nDoes this synopsis accurately represent what the source text actually says, without adding claims the source does not make? Answer supported=true only if the synopsis is a faithful, non-exaggerated summary of the source text. Explain your answer briefly in "note".`,
      },
    ],
    // NOTE: uses a raw JSON schema, not the SDK's zodOutputFormat() helper --
    // slice 2 found zodOutputFormat incompatible with this project's installed
    // zod version (a real SDK defect, see docs/superpowers/sdd ledger history
    // for slice 2). Raw schema sidesteps it entirely.
    output_config: {
      format: { type: 'json_schema', schema: VERIFY_SCHEMA },
    } as Anthropic.Messages.MessageCreateParams['output_config'],
  });

  return validateVerifyOutput((response as unknown as { parsed_output: unknown }).parsed_output);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/verify.test.ts`
Expected: PASS, both cases. If `output_config`/`parsed_output` typing errors appear, check the installed `@anthropic-ai/sdk` version's actual type signatures (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`) the same way slice 2's generator task did, and adapt the cast rather than fighting the compiler — the test's behavioral assertions are the real spec, not the exact TypeScript incantation.

- [ ] **Step 5: Commit**

```bash
git add src/decide/verify.ts test/decide/verify.test.ts
git commit -m "feat: add Sonnet synopsis-verification step"
```

---

### Task 7: Sonnet decide step

**Files:**
- Create: `src/decide/decide.ts`
- Test: `test/decide/decide.test.ts`

**Interfaces:**
- Consumes: `Rung` type from Task 1 (`src/decide/rung.ts`).
- Produces:
  - `export interface DecideResult { direction: 'up' | 'down'; magnitudePts: number; shouldTrade: boolean; reasoning: string }`
  - `export async function decideTrade(client: Anthropic, headline: string, snippet: string | null, synopsis: string, rung: Rung): Promise<DecideResult>`

**Prerequisite:** same as Task 5.

- [ ] **Step 1: Write failing tests**

```typescript
// test/decide/decide.test.ts
import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { decideTrade } from '../../src/decide/decide.js';

describe('decideTrade (real Sonnet call)', () => {
  it('produces a structured direction/magnitude/should_trade/reasoning judgment', async () => {
    const client = new Anthropic();
    const result = await decideTrade(
      client,
      'BLS reports unemployment rate fell to 3.9% in July, beating expectations',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July.',
      'The unemployment rate dropped to 3.9% in July, beating economist expectations of 4.1%.',
      'reported'
    );

    expect(['up', 'down']).toContain(result.direction);
    expect(typeof result.magnitudePts).toBe('number');
    expect(Number.isFinite(result.magnitudePts)).toBe(true);
    expect(result.magnitudePts).toBeGreaterThanOrEqual(0);
    expect(typeof result.shouldTrade).toBe('boolean');
    expect(typeof result.reasoning).toBe('string');
    expect(result.reasoning.trim().length).toBeGreaterThan(0);
  }, 20000);

  it('is willing to say should_trade=false for an item with no plausible bearing on presidential approval', async () => {
    const client = new Anthropic();
    const result = await decideTrade(
      client,
      'IAEA reports routine equipment maintenance completed at monitoring station',
      'The IAEA confirmed a scheduled maintenance visit to a nuclear monitoring station was completed without incident.',
      'Routine IAEA equipment maintenance was completed without incident.',
      'reported'
    );

    expect(result.shouldTrade).toBe(false);
  }, 20000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `direnv exec . npx vitest run test/decide/decide.test.ts`
Expected: FAIL — `src/decide/decide.ts` does not exist yet.

- [ ] **Step 3: Implement `src/decide/decide.ts`**

```typescript
// src/decide/decide.ts
import Anthropic from '@anthropic-ai/sdk';
import type { Rung } from './rung.js';

export interface DecideResult {
  direction: 'up' | 'down';
  magnitudePts: number;
  shouldTrade: boolean;
  reasoning: string;
}

const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['up', 'down'] },
    magnitude_pts: { type: 'number' },
    should_trade: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['direction', 'magnitude_pts', 'should_trade', 'reasoning'],
  additionalProperties: false,
};

const DECIDE_CONTEXT = `You are assessing a news item for its likely effect on the U.S. President's approval rating, as measured by RealClearPolitics's polling average (a Kalshi market resolves weekly on a snapshot of this average).

Estimate:
- direction: "up" if this news plausibly pushes approval higher, "down" if lower.
- magnitude_pts: your best estimate of how many PERCENTAGE POINTS of RCP's approval average this might move, as a NON-NEGATIVE number (direction already carries the sign -- magnitude_pts is always >= 0). Typical single-item moves are small (a fraction of a point to a few points); reserve larger numbers for genuinely major news.
- should_trade: false if this item is too indirect, too old, too speculative, or otherwise not something you'd act on even if the arithmetic above looked favorable. This is your chance to veto a trade regardless of direction/magnitude.
- reasoning: a brief explanation of your judgment.

You are told the story's evidentiary rung for context only (rumor/reported/corroborated/confirmed) -- do not restate or alter it, it is not part of your output.`;

function validateDecideOutput(parsed: unknown): DecideResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Sonnet returned an invalid decide output shape: ${JSON.stringify(parsed)}`);
  }
  const p = parsed as Record<string, unknown>;
  if (p.direction !== 'up' && p.direction !== 'down') {
    throw new Error(`Sonnet returned an invalid direction: ${JSON.stringify(p.direction)}`);
  }
  if (typeof p.magnitude_pts !== 'number' || !Number.isFinite(p.magnitude_pts) || p.magnitude_pts < 0) {
    throw new Error(`Sonnet returned an invalid magnitude_pts: ${JSON.stringify(p.magnitude_pts)}`);
  }
  if (typeof p.should_trade !== 'boolean') {
    throw new Error(`Sonnet returned an invalid should_trade: ${JSON.stringify(p.should_trade)}`);
  }
  if (typeof p.reasoning !== 'string' || p.reasoning.trim().length === 0) {
    throw new Error(`Sonnet returned an invalid reasoning: ${JSON.stringify(p.reasoning)}`);
  }
  return {
    direction: p.direction,
    magnitudePts: p.magnitude_pts,
    shouldTrade: p.should_trade,
    reasoning: p.reasoning,
  };
}

export async function decideTrade(
  client: Anthropic,
  headline: string,
  snippet: string | null,
  synopsis: string,
  rung: Rung
): Promise<DecideResult> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${DECIDE_CONTEXT}\n\nEvidentiary rung: ${rung}\n\nSource text:\n${sourceText}\n\nSynopsis:\n${synopsis}`,
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: DECIDE_SCHEMA },
    } as Anthropic.Messages.MessageCreateParams['output_config'],
  });

  return validateDecideOutput((response as unknown as { parsed_output: unknown }).parsed_output);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `direnv exec . npx vitest run test/decide/decide.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/decide/decide.ts test/decide/decide.test.ts
git commit -m "feat: add Sonnet decide step"
```

---

### Task 8: Pipeline orchestration

**Files:**
- Create: `src/decide/pipeline.ts`
- Test: `test/decide/pipeline.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7 — `computeRung`/`RungInput` (rung.ts), `fetchActiveLadder`/`ActiveLadder`/`BandMarket` (kalshi.ts), `openLedger`/`recordDecision`/`hasOpenPosition`/`totalExposureCents`/`DecisionRecord` (ledger.ts), `evaluateSizing`/`SizingInput` (sizing.ts), `synopsize` (synopsis.ts), `verifySynopsis` (verify.ts), `decideTrade` (decide.ts). Also `Item` type from `../item.js`.
- Produces:
  - `export interface PipelineDeps { anthropicClient: Anthropic; db: Database.Database; fetchLadder: typeof fetchActiveLadder }` — injectable so tests can stub the model-call and network boundaries without touching the pure logic.
  - `export async function runDecisionPipeline(item: Item, deps: PipelineDeps): Promise<void>` — always resolves; every outcome (kill switch, verify-rejection, dedup skip, rumor rung, no-band-clears, or a real would-trade) is recorded to the ledger, never thrown past this function for a normal decision outcome. Only a genuine infrastructure failure (e.g. Kalshi fetch throws) propagates.

This task's test suite is the one place stubbing the model-call functions is appropriate — per the Global Constraints testing strategy, the orchestration logic's correctness (does it check the kill switch first? does it skip on dedup? does it record every branch?) does not depend on what Haiku/Sonnet actually said, only on what they returned.

**Deliberate ordering deviation from the spec's data-flow diagram:** the design spec's diagram lists the story-dedup check before the Kalshi ladder fetch, but dedup is scoped to `(story_key, event_ticker)` — it cannot run without already knowing the *current* `event_ticker`, which only the ladder fetch provides. That's an unstated dependency the spec's diagram didn't resolve. This task fetches the ladder immediately after the rung check (still before Sonnet decide, so it costs no extra model calls) and uses its `eventTicker` to scope the dedup check correctly. This is free either way — Kalshi market-data reads are public and unauthenticated — so reordering it costs nothing and closes a real gap rather than introducing one.

- [ ] **Step 1: Write failing tests**

```typescript
// test/decide/pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { runDecisionPipeline } from '../../src/decide/pipeline.js';
import { openLedger, hasOpenPosition, totalExposureCents } from '../../src/decide/ledger.js';
import type { Item } from '../../src/item.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import * as synopsisModule from '../../src/decide/synopsis.js';
import * as verifyModule from '../../src/decide/verify.js';
import * as decideModule from '../../src/decide/decide.js';

function baseItem(overrides: Partial<Item> = {}): Item {
  return {
    item_id: 'item-1',
    dedup_id: 'dedup-1',
    story_key: 'story-1',
    event_type: 'item',
    replay: false,
    source_id: 'bls_releases',
    adapter: 'feed',
    trust_tier: 1,
    headline: 'BLS reports unemployment rate fell to 3.9%',
    snippet: 'The unemployment rate declined to 3.9% in July.',
    url: null,
    raw_url: null,
    enrich_url: null,
    author: null,
    lang: null,
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: null,
    first_seen_ts: '2026-08-25T10:01:00Z',
    emitted_ts: '2026-08-25T10:01:05Z',
    latency_ms: 5000,
    is_first_sighting: true,
    corroborations: 0,
    provenance_gaps: [],
    amends_item_id: null,
    amendment_kind: null,
    ...overrides,
  };
}

function stubLadder(): ActiveLadder {
  return {
    eventTicker: 'KXAPRPOTUS-26AUG28',
    strikeDate: '2026-08-28T16:00:00Z',
    bands: [
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.2',
        floorStrike: 40.0,
        capStrike: 40.2,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 40,
        yesBidCents: 38,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.4',
        floorStrike: 40.2,
        capStrike: 40.4,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 42,
        yesBidCents: 40,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.6',
        floorStrike: 40.4,
        capStrike: null,
        strikeType: 'greater',
        status: 'active',
        yesAskCents: 12,
        yesBidCents: 10,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
    ],
  };
}

describe('runDecisionPipeline', () => {
  let dir: string;
  let db: Database.Database;
  let client: Anthropic;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pipeline-test-'));
    db = openLedger(path.join(dir, 'test.db'));
    client = new Anthropic({ apiKey: 'sk-ant-unused-in-these-tests' });
    delete process.env.EXECUTOR_TRADING_HALTED;
    vi.spyOn(synopsisModule, 'synopsize').mockResolvedValue('The unemployment rate fell to 3.9%.');
    vi.spyOn(verifyModule, 'verifySynopsis').mockResolvedValue({ supported: true, note: 'faithful' });
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
      direction: 'up',
      magnitudePts: 0.3,
      shouldTrade: true,
      reasoning: 'stronger-than-expected jobs data typically lifts approval',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.EXECUTOR_TRADING_HALTED;
  });

  it('records a skip when the kill switch is set, and makes no model calls', async () => {
    process.env.EXECUTOR_TRADING_HALTED = 'true';
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(synopsisModule.synopsize).not.toHaveBeenCalled();
    expect(fetchLadder).not.toHaveBeenCalled();
    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('records a skip when verify reports unsupported, before rung/decide/sizing', async () => {
    vi.spyOn(verifyModule, 'verifySynopsis').mockResolvedValue({ supported: false, note: 'fabricated' });
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(decideModule.decideTrade).not.toHaveBeenCalled();
    expect(fetchLadder).not.toHaveBeenCalled();
  });

  it('records a skip when rung is rumor, without calling decideTrade', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem({ trust_tier: 3, story_key: null }), {
      anthropicClient: client,
      db,
      fetchLadder,
    });

    expect(decideModule.decideTrade).not.toHaveBeenCalled();
  });

  it('skips a story that already has an open position for the active event, without calling Sonnet decide', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    // First run: real would-trade path.
    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });
    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(true);

    vi.mocked(decideModule.decideTrade).mockClear();
    await runDecisionPipeline(baseItem({ item_id: 'item-2' }), { anthropicClient: client, db, fetchLadder });
    expect(decideModule.decideTrade).not.toHaveBeenCalled();
  });

  it('records a skip when Sonnet decide says should_trade=false', async () => {
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
      direction: 'up',
      magnitudePts: 0.1,
      shouldTrade: false,
      reasoning: 'too indirect to act on',
    });
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('records a would-trade decision and increases total exposure when everything clears', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(true);
    expect(totalExposureCents(db)).toBeGreaterThan(0);
    expect(totalExposureCents(db)).toBeLessThanOrEqual(1000);
  });

  it('records a skip (not a throw) when fetchLadder returns null (no active event)', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(null);

    await expect(
      runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder })
    ).resolves.toBeUndefined();
    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/pipeline.test.ts`
Expected: FAIL — `src/decide/pipeline.ts` does not exist yet.

- [ ] **Step 3: Implement `src/decide/pipeline.ts`**

```typescript
// src/decide/pipeline.ts
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import { computeRung } from './rung.js';
import { fetchActiveLadder, type ActiveLadder } from './kalshi.js';
import { recordDecision, hasOpenPosition, totalExposureCents, type DecisionRecord } from './ledger.js';
import { evaluateSizing } from './sizing.js';
import { synopsize } from './synopsis.js';
import { verifySynopsis } from './verify.js';
import { decideTrade } from './decide.js';

const KALSHI_SERIES_TICKER = 'KXAPRPOTUS';

export interface PipelineDeps {
  anthropicClient: Anthropic;
  db: Database.Database;
  fetchLadder: typeof fetchActiveLadder;
}

function skipRecord(item: Item, reason: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: item.item_id,
    storyKey: item.story_key,
    eventTicker: null,
    marketTicker: null,
    side: null,
    rung: 'rumor',
    direction: null,
    magnitudePts: null,
    contracts: 0,
    entryPriceCents: null,
    notionalCents: 0,
    edgeCents: null,
    wouldTrade: false,
    reason,
    ...overrides,
  };
}

export async function runDecisionPipeline(item: Item, deps: PipelineDeps): Promise<void> {
  const { anthropicClient, db, fetchLadder } = deps;

  if (process.env.EXECUTOR_TRADING_HALTED === 'true') {
    recordDecision(db, skipRecord(item, 'kill switch active'));
    return;
  }

  const synopsis = await synopsize(anthropicClient, item.headline, item.snippet);
  const verification = await verifySynopsis(anthropicClient, item.headline, item.snippet, synopsis);
  if (!verification.supported) {
    recordDecision(db, skipRecord(item, `synopsis not supported by source: ${verification.note}`));
    return;
  }

  const rung = computeRung({
    trustTier: item.trust_tier,
    storyKey: item.story_key,
    corroborations: item.corroborations,
  });
  if (rung === 'rumor') {
    recordDecision(db, skipRecord(item, 'rumor rung, stake 0', { rung }));
    return;
  }

  const ladder: ActiveLadder | null = await fetchLadder(KALSHI_SERIES_TICKER);
  if (ladder === null) {
    recordDecision(db, skipRecord(item, 'no active KXAPRPOTUS event found', { rung }));
    return;
  }

  if (item.story_key !== null && hasOpenPosition(db, item.story_key, ladder.eventTicker)) {
    recordDecision(
      db,
      skipRecord(item, 'story already has an open position for the active event', {
        rung,
        eventTicker: ladder.eventTicker,
      })
    );
    return;
  }

  const decision = await decideTrade(anthropicClient, item.headline, item.snippet, synopsis, rung);
  if (!decision.shouldTrade) {
    recordDecision(
      db,
      skipRecord(item, decision.reasoning, {
        rung,
        eventTicker: ladder.eventTicker,
        direction: decision.direction,
        magnitudePts: decision.magnitudePts,
      })
    );
    return;
  }

  const sizing = evaluateSizing({
    bands: ladder.bands,
    rung,
    direction: decision.direction,
    magnitudePts: decision.magnitudePts,
    currentTotalExposureCents: totalExposureCents(db),
  });

  recordDecision(db, {
    itemId: item.item_id,
    storyKey: item.story_key,
    eventTicker: ladder.eventTicker,
    marketTicker: sizing.marketTicker,
    side: sizing.side,
    rung,
    direction: decision.direction,
    magnitudePts: decision.magnitudePts,
    contracts: sizing.contracts,
    entryPriceCents: sizing.entryPriceCents,
    notionalCents: sizing.notionalCents,
    edgeCents: sizing.edgeCents,
    wouldTrade: sizing.wouldTrade,
    reason: sizing.reason,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/pipeline.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/decide/pipeline.ts test/decide/pipeline.test.ts
git commit -m "feat: add decision pipeline orchestration with kill switch and dedup"
```

---

### Task 9: Wire the pipeline into `main.ts`

**Files:**
- Modify: `src/main.ts`
- Modify: `test/main.test.ts`

**Interfaces:**
- Consumes: `runDecisionPipeline`/`PipelineDeps` (Task 8), `openLedger` (Task 3), `fetchActiveLadder` (Task 2), and the existing `ItemOutcome`/`OnItem`/`runOnce` from the current `src/main.ts`.
- Produces: `runOnce`'s `onItem` callback type widens to `(outcome: ItemOutcome) => void | Promise<void>`, and `runOnce` now `await`s it (currently calls it synchronously, without awaiting).

**Prerequisite:** same local-Redis requirement as prior slices' main.ts work, plus `ANTHROPIC_API_KEY` for the optional manual smoke check.

- [ ] **Step 1: Read the current `src/main.ts` and `test/main.test.ts` in full before changing anything**

This file has been modified by two prior slices' final-review fix waves — read the actual current content rather than assuming it matches any earlier plan's snippets.

- [ ] **Step 2: Write a failing test for the widened `OnItem` type being awaited**

```typescript
// Add to test/main.test.ts, in the existing describe block, alongside the current tests:

it('awaits an async onItem callback before acking the entry', async () => {
  await client.xAdd(streamKey, '*', {
    json: JSON.stringify(realisticPayload({ headline: 'Trump approval rating drops sharply' })),
  });

  const compiled = compilePhrases(['trump approval rating']);
  const order: string[] = [];
  const controller = new AbortController();

  await runOnce(
    client,
    { streamKey, groupName, consumerName: 'consumer-async', blockMs: 500, count: 10 },
    compiled,
    async (outcome) => {
      order.push('onItem-start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('onItem-end');
      controller.abort();
    },
    controller.signal
  );

  expect(order).toEqual(['onItem-start', 'onItem-end']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL, or the test hangs/passes vacuously depending on the current `runOnce` implementation's exact synchronous-call behavior — either way, confirm by reading the current `runOnce` source that `onItem(...)` is called without `await`, before changing it.

- [ ] **Step 4: Modify `src/main.ts`**

Change the `OnItem` type and `runOnce`'s call to it:

```typescript
// Change this line:
// export type OnItem = (outcome: ItemOutcome) => void;
// to:
export type OnItem = (outcome: ItemOutcome) => void | Promise<void>;
```

Inside `runOnce`'s per-entry handler, change the call site from a bare `onItem(...)` to `await onItem(...)` (find the exact current line via Step 1's read and edit it in place — do not rewrite the whole function, this is a one-line change to how the callback is invoked).

Then add the decision-pipeline wiring to `main()`. Read the current `main()` implementation first (per Step 1), then extend its `onItem` callback so that, after the existing summary/match logging, a matched item also triggers the decision pipeline:

```typescript
// Additions to main.ts -- exact placement depends on the current file's
// structure (read it first per Step 1); this is the logic to add, not a
// full-file replacement.

import { openLedger } from './decide/ledger.js';
import { fetchActiveLadder } from './decide/kalshi.js';
import { runDecisionPipeline } from './decide/pipeline.js';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LEDGER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../data/decisions.db'
);

// Inside main(), before wiring the onItem callback:
const anthropicClient = new Anthropic();
const db = openLedger(DEFAULT_LEDGER_PATH);

// Inside the onItem callback, after the existing formatSummaryLine/[KEYPHRASE-MATCH] logging:
if (outcome.ok && outcome.matchedPhrases.length > 0) {
  try {
    await runDecisionPipeline(outcome.item, {
      anthropicClient,
      db,
      fetchLadder: fetchActiveLadder,
    });
  } catch (err) {
    console.error(`[decision-pipeline] error processing item=${outcome.item.item_id}:`, err);
  }
}
```

The `try/catch` here is deliberate: an infrastructure failure in the decision pipeline (e.g. Kalshi's API is briefly down) must not crash the whole consumer process or stop it from continuing to process later stream entries — it's logged and the loop continues. This is distinct from the pipeline's own internal handling, where every normal decision *outcome* (including every gate rejection) is already recorded to the ledger; this catch only ever fires for something the pipeline itself couldn't classify as a decision.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/main.test.ts`
Expected: PASS, all cases including the new async-await test.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`
Expected: everything passes (all 9 tasks' tests together).

- [ ] **Step 7: Manual smoke check (optional, requires a running Redis with real items and `ANTHROPIC_API_KEY`)**

Run: `direnv exec . npm run dev`
Expected: if `iip` is running and publishing, a keyphrase-matched item now also produces either a decision-pipeline error log or (silently, since decisions aren't logged to stdout in this task — only to the ledger) a new row in `data/decisions.db`. Inspect with:
`sqlite3 data/decisions.db "SELECT item_id, rung, would_trade, reason FROM decisions ORDER BY id DESC LIMIT 5;"`
Skip this step if `iip` isn't running locally — it's optional, not a pass/fail gate.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts test/main.test.ts
git commit -m "feat: wire the decision pipeline into the consumer for matched items"
```

---

## Self-Review Notes

- **Spec coverage:** all three model stages (Tasks 5–7), deterministic rung (Task 1), Kalshi ladder fetch (Task 2), the durable ledger with redundant ceilings (Task 3), baseline/shift/Kelly/gates sizing (Task 4), kill switch + dedup + verify-rejection + rumor-rejection orchestration (Task 8), and final wiring with async `onItem` (Task 9) are each covered by a task. The "no order placement" constraint is structurally satisfied — no task in this plan calls any Kalshi order-placement endpoint or reads/writes Kalshi credentials.
- **Placeholder scan:** none found — every step has runnable code or an exact command.
- **Type consistency:** `Rung`/`RUNG_STAKES` (Task 1), `BandMarket`/`ActiveLadder` (Task 2), `DecisionRecord` (Task 3), `SizingInput`/`SizingResult` (Task 4), `VerifyResult` (Task 6), `DecideResult` (Task 7), and `PipelineDeps` (Task 8) are used identically everywhere they're consumed, cross-checked against each producing task's exact interface block. Unit suffixes (`Cents` vs `Pts`) are applied consistently across every task that touches price or magnitude values, per the Global Constraints naming discipline.
