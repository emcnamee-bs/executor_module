# Exit Review — Plan A: Records and Accounting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ledger tables, helpers and accounting rules that record paper exits (reviews, fills, markers) and keep settlement and the Grafana wall correct for partially or fully exited positions. Nothing in this plan sells anything yet.

**Architecture:** Two additive SQLite tables (`paper_exit_reviews`, `paper_exits`) created through the existing `SCHEMA` string, one focused module `src/paper/exits.ts` that owns every read/write of them, a remainder-aware `settlePaperRows`, and a matching change to the wall publisher. A fully sold position is closed by writing `settled_at`, leaving `result` NULL and setting `pnl_cents` to the sum of its exit P&L, so every existing consumer of `paper_positions` keeps working.

**Tech Stack:** TypeScript (ESM, Node 22), better-sqlite3, vitest; Python 3 + unittest for the wall publisher (not in git).

**Spec:** `docs/superpowers/specs/2026-10-12-exit-review-design.md` (sections 3, 4, 6). This is plan 1 of 3; plans B (trigger and fills) and C (lateness and backtest) depend on the interfaces defined here.

## Where to work

All commands run **on mini-mac** (`ssh emac@mini-mac.local`) in the worktree `~/executor_module-exit` (branch `feat/exit-review`). The wall publisher lives outside git in `~/wall`. Run a single test file with `npx vitest run <path>`; the whole suite with `npx vitest run`.

**Baseline:** the full suite has known failures that are not regressions (Redis NOAUTH in `test/main.test.ts` and `test/redis/*`, `test/keyphrases/generate*` without an API key, one `ledgerLock` loader test; about 29 total as of 2026-10-11). Before Task 1 run `npx vitest run 2>&1 | tail -15` and write down the failed count; it must not rise.

**Commits** (mini-mac has no git identity). Use exactly:

```bash
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "<subject>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

## Global Constraints

- Paper only: nothing in this plan may touch `decisions`, `orders` or any real-order code path.
- Additive schema only: `CREATE TABLE IF NOT EXISTS`; no change to existing columns or CHECKs.
- Exit P&L is gross of fees (project convention). For both sides `pnl = contracts * (exit_price_cents - entry_price_cents)` where both prices are in that side's own cents.
- A fully sold position is closed as: `settled_at` = last fill time, `result` NULL, `pnl_cents` = sum of its exit fills' `pnl_cents`.
- `paper_exits.status` values: `filled` (completes the position), `partial`, `unsellable`, `held_to_settlement`. Only `filled`/`partial` rows carry contracts and a price; the other two are markers (contracts 0, price NULL, pnl 0).
- `paper-grid-2-publish.py` is disabled and must not be edited or re-enabled.

## Review Focus

1. A position sold in two partial fills then settled: P&L must equal fills + remainder settlement, with no double count (Task 2 test).
2. Selling more contracts than remain, selling a settled position, or selling a capture row must throw and write nothing (Task 1 tests).
3. An old ledger with no exit tables, read by the wall publisher in read-only mode, must still produce a cell, not crash (Task 3 test).
4. Re-recording the same marker (`unsellable`) on every retry must not grow the table (Task 1 test).
5. A fully exited position must disappear from the open list and from settlement scoring (Tasks 1 and 2 tests).

---

## File Structure

- Modify: `src/decide/ledger.ts` (extend `SCHEMA` with the two tables)
- Create: `src/paper/exits.ts` (all reads/writes of the exit tables, plus the open-position query)
- Modify: `src/paper/score.ts` (remainder-aware settlement)
- Create: `test/paper/exits.test.ts`, `test/paper/scoreExits.test.ts`
- Modify (outside git, with backup): `~/wall/paper-grid-publish.py`, `~/wall/tests/test_paper_grid.py`

---

### Task 1: Exit tables and the `exits.ts` module

**Files:**
- Modify: `src/decide/ledger.ts` (end of the `SCHEMA` string, after the `paper_positions` table)
- Create: `src/paper/exits.ts`
- Test: `test/paper/exits.test.ts`

**Interfaces:**
- Consumes: `openLedger(dbPath)` from `src/decide/ledger.ts`; `recordPaperPosition` from `src/paper/paper.ts` (tests only).
- Produces (all exported from `src/paper/exits.ts`; Plans B and C import these exact names):
  - `type ExitVerdict = 'sell' | 'hold' | 'error'`
  - `type ExitMarker = 'unsellable' | 'held_to_settlement'`
  - `interface OpenPaperPosition { id: number; trade: string; itemId: string; structure: 'band'|'threshold'|'binary'|'capture'; eventTicker: string; marketTicker: string; side: 'yes'|'no'; contracts: number; entryPriceCents: number; remaining: number }`
  - `listOpenPaperPositions(db): OpenPaperPosition[]`
  - `remainingContracts(db, positionId: number): number` (contracts minus fills; 0 when the position is unknown)
  - `interface ExitReviewRecord { trade: string; itemId: string; positionId: number; shift: number|null; confidence: number|null; reason: string|null; midCents: number|null; fairAfterCents: number|null; lossCents: number|null; exitCostCents: number|null; verdict: ExitVerdict; verdictReason: string|null; lagJson: string|null }`
  - `recordExitReview(db, rec: ExitReviewRecord): number` (returns review id)
  - `updateReviewLag(db, reviewId: number, lagJson: string): void`
  - `hasExitReview(db, itemId: string, positionId: number): boolean`
  - `positionHasSellReview(db, positionId: number): boolean`
  - `hasSellTrigger(db, marketTicker: string): boolean`
  - `interface ExitFillInput { positionId: number; reviewId: number; contracts: number; priceCents: number; filledAt?: string }`
  - `interface ExitFillResult { exitId: number; pnlCents: number; remaining: number; closed: boolean }`
  - `recordExitFill(db, input: ExitFillInput): ExitFillResult`
  - `recordExitMarker(db, positionId: number, reviewId: number, status: ExitMarker): boolean` (false when the latest row already has that status)
  - `interface PendingExit { position: OpenPaperPosition; reviewId: number }`
  - `pendingExits(db): PendingExit[]`

- [ ] **Step 1: Write the failing test**

Create `test/paper/exits.test.ts`:

```ts
// test/paper/exits.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition, type PaperPositionRecord } from '../../src/paper/paper.js';
import {
  listOpenPaperPositions,
  remainingContracts,
  recordExitReview,
  updateReviewLag,
  hasExitReview,
  positionHasSellReview,
  hasSellTrigger,
  recordExitFill,
  recordExitMarker,
  pendingExits,
  type ExitReviewRecord,
} from '../../src/paper/exits.js';

function pos(itemId: string, overrides: Partial<PaperPositionRecord> = {}): PaperPositionRecord {
  return {
    trade: 't', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: 'MKT-A', side: 'yes',
    contracts: 4, entryPriceCents: 40, direction: 'up', magnitude: 0.1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    ...overrides,
  };
}

function review(itemId: string, positionId: number, verdict: ExitReviewRecord['verdict'] = 'sell'): ExitReviewRecord {
  return {
    trade: 't', itemId, positionId, shift: -2, confidence: 0.8, reason: 'bearish', midCents: 50, fairAfterCents: 30,
    lossCents: 16, exitCostCents: 1, verdict, verdictReason: 'loss beats threshold', lagJson: null,
  };
}

describe('exit tables', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exits-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const posRow = (id: number) =>
    db.prepare(`SELECT settled_at, result, pnl_cents FROM paper_positions WHERE id = ?`).get(id) as {
      settled_at: string | null; result: string | null; pnl_cents: number | null;
    };

  it('creates both tables on an existing ledger (idempotent re-open)', () => {
    db.close();
    db = openLedger(path.join(dir, 'test.db'));
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain('paper_exit_reviews');
    expect(names).toContain('paper_exits');
  });

  it('lists only open positions with a side, and reports remaining contracts', () => {
    const open = recordPaperPosition(db, pos('i1'));
    recordPaperPosition(db, pos('capture', { marketTicker: null, side: null, contracts: 0, entryPriceCents: null }));
    const settled = recordPaperPosition(db, pos('i3'));
    db.prepare(`UPDATE paper_positions SET settled_at = '2026-10-12T00:00:00.000Z', result = 'no', pnl_cents = -160 WHERE id = ?`).run(settled);
    const rows = listOpenPaperPositions(db);
    expect(rows.map((r) => r.id)).toEqual([open]);
    expect(rows[0]).toMatchObject({ marketTicker: 'MKT-A', side: 'yes', contracts: 4, entryPriceCents: 40, remaining: 4 });
  });

  it('recordExitReview is unique per (item, position) and queryable', () => {
    const p = recordPaperPosition(db, pos('i1'));
    expect(hasExitReview(db, 'news-1', p)).toBe(false);
    const id = recordExitReview(db, review('news-1', p));
    expect(id).toBeGreaterThan(0);
    expect(hasExitReview(db, 'news-1', p)).toBe(true);
    expect(() => recordExitReview(db, review('news-1', p))).toThrow();
    expect(positionHasSellReview(db, p)).toBe(true);
    expect(hasSellTrigger(db, 'MKT-A')).toBe(true);
    expect(hasSellTrigger(db, 'MKT-OTHER')).toBe(false);
  });

  it('a hold or error review is not a sell trigger', () => {
    const p = recordPaperPosition(db, pos('i1'));
    recordExitReview(db, review('news-1', p, 'hold'));
    recordExitReview(db, review('news-2', p, 'error'));
    expect(positionHasSellReview(db, p)).toBe(false);
    expect(hasSellTrigger(db, 'MKT-A')).toBe(false);
  });

  it('updateReviewLag overwrites the lag json', () => {
    const p = recordPaperPosition(db, pos('i1'));
    const id = recordExitReview(db, review('news-1', p));
    updateReviewLag(db, id, '{"fillAt":"x"}');
    expect((db.prepare(`SELECT lag_json FROM paper_exit_reviews WHERE id = ?`).get(id) as { lag_json: string }).lag_json).toBe('{"fillAt":"x"}');
  });

  it('a partial fill books pnl, keeps the position open and shrinks remaining', () => {
    const p = recordPaperPosition(db, pos('i1')); // 4 yes @ 40
    const r = recordExitReview(db, review('news-1', p));
    const res = recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 55, filledAt: '2026-10-12T01:00:00.000Z' });
    expect(res).toMatchObject({ pnlCents: 15, remaining: 3, closed: false });
    expect(posRow(p).settled_at).toBeNull();
    expect(listOpenPaperPositions(db)[0].remaining).toBe(3);
    expect(remainingContracts(db, p)).toBe(3);
    expect(remainingContracts(db, 99999)).toBe(0);
  });

  it('the final fill closes the position: settled_at set, result null, pnl = sum of fills', () => {
    const p = recordPaperPosition(db, pos('i1')); // 4 yes @ 40
    const r = recordExitReview(db, review('news-1', p));
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 55, filledAt: '2026-10-12T01:00:00.000Z' });
    const res = recordExitFill(db, { positionId: p, reviewId: r, contracts: 3, priceCents: 30, filledAt: '2026-10-12T01:00:20.000Z' });
    expect(res).toMatchObject({ pnlCents: -30, remaining: 0, closed: true });
    expect(posRow(p)).toEqual({ settled_at: '2026-10-12T01:00:20.000Z', result: null, pnl_cents: 15 - 30 });
    expect(listOpenPaperPositions(db)).toEqual([]);
  });

  it('a NO position books pnl in NO cents (exit - entry)', () => {
    const p = recordPaperPosition(db, pos('i1', { side: 'no', contracts: 2, entryPriceCents: 29 }));
    const r = recordExitReview(db, review('news-1', p));
    const res = recordExitFill(db, { positionId: p, reviewId: r, contracts: 2, priceCents: 20 });
    expect(res.pnlCents).toBe(-18);
  });

  it('refuses to oversell, to sell a settled position, or to sell a capture row, and writes nothing', () => {
    const p = recordPaperPosition(db, pos('i1')); // 4
    const r = recordExitReview(db, review('news-1', p));
    expect(() => recordExitFill(db, { positionId: p, reviewId: r, contracts: 5, priceCents: 30 })).toThrow(/only 4 remaining/);
    expect(() => recordExitFill(db, { positionId: p, reviewId: r, contracts: 0, priceCents: 30 })).toThrow(/positive/);
    const cap = recordPaperPosition(db, pos('cap', { marketTicker: null, side: null, contracts: 0, entryPriceCents: null }));
    expect(() => recordExitFill(db, { positionId: cap, reviewId: r, contracts: 1, priceCents: 30 })).toThrow();
    db.prepare(`UPDATE paper_positions SET settled_at = '2026-10-12T00:00:00.000Z', result = 'no', pnl_cents = -160 WHERE id = ?`).run(p);
    expect(() => recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 30 })).toThrow(/already settled/);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_exits`).get() as { n: number }).n).toBe(0);
  });

  it('recordExitMarker is idempotent for the same latest status', () => {
    const p = recordPaperPosition(db, pos('i1'));
    const r = recordExitReview(db, review('news-1', p));
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(true);
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(false);
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_exits`).get() as { n: number }).n).toBe(1);
    // after a partial fill the next unsellable is a new state change
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 30 });
    expect(recordExitMarker(db, p, r, 'unsellable')).toBe(true);
  });

  it('pendingExits = open positions with a sell review and no held_to_settlement marker', () => {
    const a = recordPaperPosition(db, pos('a'));
    const b = recordPaperPosition(db, pos('b', { marketTicker: 'MKT-B' }));
    const c = recordPaperPosition(db, pos('c', { marketTicker: 'MKT-C' }));
    const ra = recordExitReview(db, review('n1', a, 'sell'));
    recordExitReview(db, review('n1', b, 'hold'));
    const rc = recordExitReview(db, review('n1', c, 'sell'));
    expect(pendingExits(db).map((x) => [x.position.id, x.reviewId])).toEqual([[a, ra], [c, rc]]);
    recordExitMarker(db, c, rc, 'held_to_settlement');
    expect(pendingExits(db).map((x) => x.position.id)).toEqual([a]);
    recordExitFill(db, { positionId: a, reviewId: ra, contracts: 4, priceCents: 30 });
    expect(pendingExits(db)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/paper/exits.test.ts`
Expected: FAIL (`Cannot find module '../../src/paper/exits.js'`).

- [ ] **Step 3: Extend the ledger schema**

In `src/decide/ledger.ts`, find the end of the `SCHEMA` template string (the `paper_positions` table's final CHECK, then `);` then the closing backtick and `;`):

```
  CHECK (side IS NULL OR (market_ticker IS NOT NULL AND contracts > 0 AND entry_price_cents IS NOT NULL))
);
`;
```

Replace it with:

```
  CHECK (side IS NULL OR (market_ticker IS NOT NULL AND contracts > 0 AND entry_price_cents IS NOT NULL))
);

-- Exit review (paper only, see docs/superpowers/specs/2026-10-12-exit-review-design.md).
-- One row per (news item, held position) review, whether the verdict is sell, hold or error.
CREATE TABLE IF NOT EXISTS paper_exit_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  trade TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position_id INTEGER NOT NULL REFERENCES paper_positions(id),
  shift REAL, confidence REAL, reason TEXT,
  mid_cents REAL, fair_after_cents REAL, loss_cents REAL, exit_cost_cents REAL,
  verdict TEXT NOT NULL CHECK (verdict IN ('sell','hold','error')),
  verdict_reason TEXT,
  lag_json TEXT,
  UNIQUE (item_id, position_id)
);
CREATE INDEX IF NOT EXISTS idx_paper_exit_reviews_position ON paper_exit_reviews(position_id);

-- Simulated exit fills and exit-state markers. A fill (filled/partial) has contracts > 0 and a
-- price; unsellable / held_to_settlement are markers (contracts 0, no price, pnl 0).
CREATE TABLE IF NOT EXISTS paper_exits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  position_id INTEGER NOT NULL REFERENCES paper_positions(id),
  review_id INTEGER NOT NULL REFERENCES paper_exit_reviews(id),
  contracts INTEGER NOT NULL DEFAULT 0 CHECK (contracts >= 0),
  price_cents INTEGER CHECK (price_cents IS NULL OR (price_cents > 0 AND price_cents <= 100)),
  pnl_cents INTEGER NOT NULL DEFAULT 0,   -- GROSS of fees
  status TEXT NOT NULL CHECK (status IN ('filled','partial','unsellable','held_to_settlement')),
  filled_at TEXT,
  late INTEGER,
  late_json TEXT,
  CHECK ((status IN ('filled','partial')) = (contracts > 0 AND price_cents IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_paper_exits_position ON paper_exits(position_id);
`;
```

- [ ] **Step 4: Write the module**

Create `src/paper/exits.ts`:

```ts
// src/paper/exits.ts
//
// Every read and write of the paper exit tables lives here (spec sections 3, 4, 6).
// A fully sold position is closed by writing settled_at / result NULL / pnl_cents = sum of
// its fills, so existing consumers of paper_positions need no change.
import type Database from 'better-sqlite3';

export type ExitVerdict = 'sell' | 'hold' | 'error';
export type ExitMarker = 'unsellable' | 'held_to_settlement';

export interface OpenPaperPosition {
  id: number;
  trade: string;
  itemId: string;
  structure: 'band' | 'threshold' | 'binary' | 'capture';
  eventTicker: string;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
  /** contracts minus everything already sold. */
  remaining: number;
}

const OPEN_POSITIONS_SQL = `
  SELECT p.id, p.trade, p.item_id AS itemId, p.structure, p.event_ticker AS eventTicker,
         p.market_ticker AS marketTicker, p.side, p.contracts, p.entry_price_cents AS entryPriceCents,
         p.contracts - COALESCE((SELECT SUM(e.contracts) FROM paper_exits e WHERE e.position_id = p.id), 0) AS remaining
    FROM paper_positions p
   WHERE p.side IS NOT NULL AND p.market_ticker IS NOT NULL AND p.settled_at IS NULL
   ORDER BY p.id`;

/** Unsettled paper positions that still hold contracts (capture rows never appear). */
export function listOpenPaperPositions(db: Database.Database): OpenPaperPosition[] {
  return (db.prepare(OPEN_POSITIONS_SQL).all() as OpenPaperPosition[]).filter((p) => p.remaining > 0);
}

/** Contracts of a position not yet sold by exits (0 when the position does not exist). */
export function remainingContracts(db: Database.Database, positionId: number): number {
  const row = db
    .prepare(
      `SELECT p.contracts - COALESCE((SELECT SUM(e.contracts) FROM paper_exits e WHERE e.position_id = p.id), 0) AS remaining
         FROM paper_positions p WHERE p.id = ?`
    )
    .get(positionId) as { remaining: number } | undefined;
  return row?.remaining ?? 0;
}

export interface ExitReviewRecord {
  trade: string;
  itemId: string;
  positionId: number;
  shift: number | null;
  confidence: number | null;
  reason: string | null;
  midCents: number | null;
  fairAfterCents: number | null;
  lossCents: number | null;
  exitCostCents: number | null;
  verdict: ExitVerdict;
  verdictReason: string | null;
  lagJson: string | null;
}

/** One audit row per review. UNIQUE (item_id, position_id): a redelivered item cannot be reviewed twice. */
export function recordExitReview(db: Database.Database, rec: ExitReviewRecord): number {
  const info = db
    .prepare(
      `INSERT INTO paper_exit_reviews
        (trade, item_id, position_id, shift, confidence, reason, mid_cents, fair_after_cents,
         loss_cents, exit_cost_cents, verdict, verdict_reason, lag_json)
       VALUES
        (@trade, @itemId, @positionId, @shift, @confidence, @reason, @midCents, @fairAfterCents,
         @lossCents, @exitCostCents, @verdict, @verdictReason, @lagJson)`
    )
    .run(rec);
  return Number(info.lastInsertRowid);
}

export function updateReviewLag(db: Database.Database, reviewId: number, lagJson: string): void {
  db.prepare(`UPDATE paper_exit_reviews SET lag_json = ? WHERE id = ?`).run(lagJson, reviewId);
}

export function hasExitReview(db: Database.Database, itemId: string, positionId: number): boolean {
  return db.prepare(`SELECT 1 FROM paper_exit_reviews WHERE item_id = ? AND position_id = ?`).get(itemId, positionId) !== undefined;
}

/** True once any review of this position said sell (the trigger has fired; the timer finishes the sale). */
export function positionHasSellReview(db: Database.Database, positionId: number): boolean {
  return db.prepare(`SELECT 1 FROM paper_exit_reviews WHERE position_id = ? AND verdict = 'sell' LIMIT 1`).get(positionId) !== undefined;
}

/** True when any position in this market has had a sell trigger: entry must not re-buy it. */
export function hasSellTrigger(db: Database.Database, marketTicker: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM paper_exit_reviews r JOIN paper_positions p ON p.id = r.position_id
          WHERE p.market_ticker = ? AND r.verdict = 'sell' LIMIT 1`
      )
      .get(marketTicker) !== undefined
  );
}

export interface ExitFillInput {
  positionId: number;
  reviewId: number;
  contracts: number;
  /** Sale price in the position's own side cents (YES: yes bid; NO: 100 - yes ask). */
  priceCents: number;
  filledAt?: string;
}

export interface ExitFillResult {
  exitId: number;
  pnlCents: number;
  remaining: number;
  closed: boolean;
}

/**
 * Records one simulated fill atomically. Throws, writing nothing, for an unknown/capture/settled
 * position, a non-positive size, or more contracts than remain. The fill that sells the last
 * contract closes the position (settled_at, result NULL, pnl_cents = sum of fills).
 */
export function recordExitFill(db: Database.Database, input: ExitFillInput): ExitFillResult {
  return db.transaction((): ExitFillResult => {
    const pos = db
      .prepare(
        `SELECT id, side, contracts, entry_price_cents AS entry, settled_at AS settledAt FROM paper_positions WHERE id = ?`
      )
      .get(input.positionId) as { id: number; side: string | null; contracts: number; entry: number | null; settledAt: string | null } | undefined;
    if (pos === undefined) throw new Error(`paper position ${input.positionId} not found`);
    if (pos.side === null || pos.entry === null) throw new Error(`paper position ${input.positionId} is a capture row: nothing to sell`);
    if (pos.settledAt !== null) throw new Error(`paper position ${input.positionId} is already settled or closed`);
    if (!Number.isInteger(input.contracts) || input.contracts <= 0) {
      throw new Error('an exit fill needs a positive whole number of contracts');
    }
    const sold = (db.prepare(`SELECT COALESCE(SUM(contracts), 0) AS n FROM paper_exits WHERE position_id = ?`).get(input.positionId) as { n: number }).n;
    const remainingBefore = pos.contracts - sold;
    if (input.contracts > remainingBefore) {
      throw new Error(`cannot sell ${input.contracts} contracts: only ${remainingBefore} remaining on position ${input.positionId}`);
    }
    const pnl = input.contracts * (input.priceCents - pos.entry);
    const closed = input.contracts === remainingBefore;
    const filledAt = input.filledAt ?? new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO paper_exits (position_id, review_id, contracts, price_cents, pnl_cents, status, filled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(input.positionId, input.reviewId, input.contracts, input.priceCents, pnl, closed ? 'filled' : 'partial', filledAt);
    if (closed) {
      db.prepare(
        `UPDATE paper_positions
            SET settled_at = ?, result = NULL,
                pnl_cents = (SELECT SUM(pnl_cents) FROM paper_exits WHERE position_id = ?)
          WHERE id = ? AND settled_at IS NULL`
      ).run(filledAt, input.positionId, input.positionId);
    }
    return { exitId: Number(info.lastInsertRowid), pnlCents: pnl, remaining: remainingBefore - input.contracts, closed };
  })();
}

/**
 * Writes an `unsellable` / `held_to_settlement` marker row only when the position's latest
 * paper_exits row does not already carry that status, so a 20 s retry never grows the table.
 * Returns whether a row was written.
 */
export function recordExitMarker(db: Database.Database, positionId: number, reviewId: number, status: ExitMarker): boolean {
  const last = db.prepare(`SELECT status FROM paper_exits WHERE position_id = ? ORDER BY id DESC LIMIT 1`).get(positionId) as
    | { status: string }
    | undefined;
  if (last?.status === status) return false;
  db.prepare(
    `INSERT INTO paper_exits (position_id, review_id, contracts, price_cents, pnl_cents, status) VALUES (?, ?, 0, NULL, 0, ?)`
  ).run(positionId, reviewId, status);
  return true;
}

export interface PendingExit {
  position: OpenPaperPosition;
  /** The first sell review for the position (the trigger). */
  reviewId: number;
}

/** Open positions whose trigger fired but which still hold contracts and were not given up on. */
export function pendingExits(db: Database.Database): PendingExit[] {
  const trigger = db.prepare(`SELECT id FROM paper_exit_reviews WHERE position_id = ? AND verdict = 'sell' ORDER BY id LIMIT 1`);
  const held = db.prepare(`SELECT 1 FROM paper_exits WHERE position_id = ? AND status = 'held_to_settlement' LIMIT 1`);
  const out: PendingExit[] = [];
  for (const position of listOpenPaperPositions(db)) {
    const t = trigger.get(position.id) as { id: number } | undefined;
    if (t === undefined || held.get(position.id) !== undefined) continue;
    out.push({ position, reviewId: t.id });
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/paper/exits.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Check nothing else broke**

Run: `npx vitest run test/decide/ledger.test.ts test/paper 2>&1 | tail -8`
Expected: all pass (the schema addition is additive).

- [ ] **Step 7: Commit**

```bash
git add src/decide/ledger.ts src/paper/exits.ts test/paper/exits.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(paper): exit review tables and exits.ts helpers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Remainder-aware settlement

**Files:**
- Modify: `src/paper/score.ts` (the `OpenRow` interface and the select/loop in `settlePaperRows`)
- Test: `test/paper/scoreExits.test.ts`

**Interfaces:**
- Consumes: `recordExitFill`, `recordExitReview` (Task 1); `settlePaperRows(db, fetchResult)` and `pnlCents(...)` (existing).
- Produces: `settlePaperRows` now books `pnl_cents` = sum of exit fills' P&L + settlement P&L of the remaining contracts. Signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/paper/scoreExits.test.ts`:

```ts
// test/paper/scoreExits.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { settlePaperRows } from '../../src/paper/score.js';
import { recordExitReview, recordExitFill } from '../../src/paper/exits.js';

describe('settlePaperRows with exits', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'score-exits-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const newPosition = (itemId: string, side: 'yes' | 'no' = 'yes') =>
    recordPaperPosition(db, {
      trade: 't', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: `M-${itemId}`, side,
      contracts: 4, entryPriceCents: 40, direction: 'up', magnitude: 0.1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
  const sellReview = (itemId: string, positionId: number) =>
    recordExitReview(db, {
      trade: 't', itemId: `news-${itemId}`, positionId, shift: -1, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30,
      lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null,
    });
  const row = (id: number) =>
    db.prepare(`SELECT settled_at, result, pnl_cents FROM paper_positions WHERE id = ?`).get(id) as {
      settled_at: string | null; result: string | null; pnl_cents: number | null;
    };
  const finalized = (result: 'yes' | 'no') => async () => ({ status: 'finalized', result });

  it('settles only the remaining contracts and adds the exit pnl (no double count)', async () => {
    const p = newPosition('a'); // 4 yes @ 40
    const r = sellReview('a', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 55 }); // +15
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 1, priceCents: 50 }); // +10, 2 remain
    const n = await settlePaperRows(db, finalized('no')); // remaining 2 lose 40 each = -80
    expect(n).toBe(1);
    expect(row(p)).toMatchObject({ result: 'no', pnl_cents: 15 + 10 - 80 });
  });

  it('a winning remainder still adds to the exit pnl', async () => {
    const p = newPosition('b'); // 4 yes @ 40
    const r = sellReview('b', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 3, priceCents: 20 }); // -60, 1 remains
    await settlePaperRows(db, finalized('yes')); // +60 on the last contract
    expect(row(p).pnl_cents).toBe(-60 + 60);
  });

  it('a NO position settles its remainder on the NO side', async () => {
    const p = newPosition('c', 'no'); // 4 no @ 40
    const r = sellReview('c', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 2, priceCents: 30 }); // -20
    await settlePaperRows(db, finalized('no')); // 2 remaining win 60 each = +120
    expect(row(p).pnl_cents).toBe(-20 + 120);
  });

  it('a fully exited position is never touched (already closed, result stays null)', async () => {
    const p = newPosition('d');
    const r = sellReview('d', p);
    recordExitFill(db, { positionId: p, reviewId: r, contracts: 4, priceCents: 30, filledAt: '2026-10-12T01:00:00.000Z' }); // -40
    let fetched = 0;
    const n = await settlePaperRows(db, async () => { fetched += 1; return { status: 'finalized', result: 'no' }; });
    expect(n).toBe(0);
    expect(fetched).toBe(0);
    expect(row(p)).toEqual({ settled_at: '2026-10-12T01:00:00.000Z', result: null, pnl_cents: -40 });
  });

  it('a position with no exits settles exactly as before', async () => {
    const p = newPosition('e');
    await settlePaperRows(db, finalized('no'));
    expect(row(p).pnl_cents).toBe(-160);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/paper/scoreExits.test.ts`
Expected: FAIL (the first three tests give `-160`, `160`, `240` instead of the exit-adjusted numbers).

- [ ] **Step 3: Implement**

In `src/paper/score.ts`, replace the `OpenRow` interface and the row selection/loop. The `OpenRow` interface becomes:

```ts
interface OpenRow {
  id: number;
  market_ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  entry_price_cents: number;
  /** Contracts already sold by exit fills, and what they earned (gross). */
  exited_contracts: number;
  exit_pnl_cents: number;
}
```

The `rows` query becomes:

```ts
  const rows = db
    .prepare(
      `SELECT p.id, p.market_ticker, p.side, p.contracts, p.entry_price_cents,
              COALESCE((SELECT SUM(e.contracts) FROM paper_exits e WHERE e.position_id = p.id), 0) AS exited_contracts,
              COALESCE((SELECT SUM(e.pnl_cents) FROM paper_exits e WHERE e.position_id = p.id), 0) AS exit_pnl_cents
         FROM paper_positions p
        WHERE p.settled_at IS NULL AND p.market_ticker IS NOT NULL AND p.side IS NOT NULL`
    )
    .all() as OpenRow[];
```

and inside the loop, replace the line that computes `pnl` with:

```ts
    const remaining = row.contracts - row.exited_contracts;
    if (remaining <= 0) continue; // fully exited rows are closed by recordExitFill and should not reach here
    const pnl = row.exit_pnl_cents + pnlCents(row.side, remaining, row.entry_price_cents, outcome.result);
```

Update the doc comment above `settlePaperRows` by appending: `Contracts already sold by exits are not re-scored: P&L is the exit fills plus the settlement of what remains.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/paper`
Expected: PASS (new file and the existing `score.test.ts`, `paper.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/paper/score.ts test/paper/scoreExits.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(paper): settle only the remaining contracts after exits" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wall publisher counts exits

This file is **not in git**. Follow the house convention: timestamped backups next to the file.

**Files:**
- Modify: `~/wall/paper-grid-publish.py` (`trade_cell` position query, `paper_return`)
- Test: `~/wall/tests/test_paper_grid.py`

**Interfaces:**
- Consumes: the `paper_exits` table from Task 1 (read-only, may be absent in old ledgers).
- Produces: `load_positions(c, tables) -> list[dict]` (each dict gains `exit_contracts` and `exit_pnl`); `paper_return(positions, fetch)` accounts for exits.

- [ ] **Step 1: Back up**

```bash
ts=$(date +%Y%m%d-%H%M%S); cd ~/wall
cp paper-grid-publish.py paper-grid-publish.py.bak-pre-exits-$ts
cp tests/test_paper_grid.py tests/test_paper_grid.py.bak-pre-exits-$ts
```

- [ ] **Step 2: Write the failing tests**

Add a new test class to `~/wall/tests/test_paper_grid.py`, directly above `class PublisherMaths` (the file already imports `unittest` and exposes the publisher module as `pub`; add `import sqlite3` to the top imports if absent):

```python
class PublisherExits(unittest.TestCase):
    MK = {"A": {"status": "active", "result": "", "yes_bid_dollars": "0.3000", "yes_ask_dollars": "0.3400"}}  # yes mark 30

    def fetch(self, t):
        return self.MK.get(t)

    def _db(self, with_exits=True):
        c = sqlite3.connect(":memory:")
        c.row_factory = sqlite3.Row
        c.execute("create table paper_positions (id integer primary key, created_at text, side text, contracts integer, "
                  "entry_price_cents integer, market_ticker text, settled_at text, result text, pnl_cents integer)")
        if with_exits:
            c.execute("create table paper_exits (id integer primary key, position_id integer, contracts integer, pnl_cents integer)")
        return c

    def test_load_positions_adds_exit_columns_when_table_exists(self):
        c = self._db()
        c.execute("insert into paper_positions values (1,'2026-10-12','yes',4,40,'A',null,null,null)")
        c.execute("insert into paper_exits values (1,1,1,15)")
        c.execute("insert into paper_exits values (2,1,1,10)")
        tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
        p = pub.load_positions(c, tables)[0]
        self.assertEqual((p["exit_contracts"], p["exit_pnl"]), (2, 25))

    def test_load_positions_tolerates_a_ledger_without_exit_tables(self):
        c = self._db(with_exits=False)
        c.execute("insert into paper_positions values (1,'2026-10-12','yes',4,40,'A',null,null,null)")
        tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
        p = pub.load_positions(c, tables)[0]
        self.assertNotIn("exit_contracts", p)
        self.assertEqual(pub.paper_return([p], fetch=self.fetch)["cost"], 160)

    def test_open_partially_exited_position(self):
        # 4 yes @ 40, 2 sold for +25 total, 2 remain marked at 30 (-10 each = -20)
        p = {"side": "yes", "contracts": 4, "entry_price_cents": 40, "market_ticker": "A", "settled_at": None,
             "exit_contracts": 2, "exit_pnl": 25}
        r = pub.paper_return([p], fetch=self.fetch)
        self.assertEqual((r["cost"], r["realized"], r["unrealized"], r["open"]), (160, 25, -20, 1))
        self.assertAlmostEqual(r["pct"], 5 / 160 * 100)
        self.assertEqual(r["rows"][0]["pnl"], "+5")

    def test_partially_exited_with_unknown_mark_keeps_the_sold_part(self):
        p = {"side": "yes", "contracts": 4, "entry_price_cents": 40, "market_ticker": "UNKNOWN", "settled_at": None,
             "exit_contracts": 2, "exit_pnl": 25}
        r = pub.paper_return([p], fetch=self.fetch)
        self.assertEqual((r["cost"], r["realized"], r["unrealized"], r["unknown_marks"]), (80, 25, 0, 1))

    def test_fully_exited_position_is_a_closed_realized_loss(self):
        p = {"side": "yes", "contracts": 4, "entry_price_cents": 40, "market_ticker": "A", "settled_at": "2026-10-12T01:00:00.000Z",
             "result": None, "pnl_cents": -40, "exit_contracts": 4, "exit_pnl": -40}
        r = pub.paper_return([p], fetch=self.fetch)
        self.assertEqual((r["cost"], r["realized"], r["settled"], r["open"]), (160, -40, 1, 0))
        self.assertEqual(r["rows"][0]["mark"], "exited")
        self.assertAlmostEqual(r["pct"], -25.0)
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd ~/wall && python3 -m unittest tests.test_paper_grid.PublisherExits -v 2>&1 | tail -15`
Expected: FAIL / ERROR (`module 'pub' has no attribute 'load_positions'`).

- [ ] **Step 4: Implement**

In `~/wall/paper-grid-publish.py`:

(a) Add this function above `paper_return`:

```python
def load_positions(c, tables):
    """paper_positions rows as dicts; when the ledger has paper_exits, each also carries exit_contracts / exit_pnl."""
    if "paper_positions" not in tables:
        return []
    if "paper_exits" in tables:
        sql = ("select p.*, "
               "coalesce((select sum(e.contracts) from paper_exits e where e.position_id = p.id), 0) as exit_contracts, "
               "coalesce((select sum(e.pnl_cents) from paper_exits e where e.position_id = p.id), 0) as exit_pnl "
               "from paper_positions p order by p.created_at")
    else:
        sql = "select * from paper_positions order by created_at"
    return [dict(r) for r in c.execute(sql)]
```

(b) In `trade_cell`, replace the line

```python
    positions = [dict(r) for r in c.execute("select * from paper_positions order by created_at")] if "paper_positions" in tables else []
```

with

```python
    positions = load_positions(c, tables)
```

(c) Replace the whole `paper_return` function with:

```python
def paper_return(positions, fetch=fetch_market):
    """positions: dicts from paper_positions (+ exit_contracts / exit_pnl when exits exist).
    Returns the per-trade numbers incl. the pct (None when nothing priced).
    A position sold in part books its exit P&L as realized and marks only what remains; a fully sold one is closed
    (settled_at set, result None) and reads as a realized result."""
    out = {"open": 0, "settled": 0, "cost": 0, "realized": 0, "unrealized": 0, "unknown_marks": 0, "unknown_settled": 0, "rows": [], "pct": None}
    for p in positions:
        side, n, entry = p.get("side"), p.get("contracts") or 0, p.get("entry_price_cents")
        priced = side in ("yes", "no") and n > 0 and entry
        cost = n * entry if priced else 0
        sold, exit_pnl = p.get("exit_contracts") or 0, p.get("exit_pnl") or 0
        row = {"market": p.get("market_ticker") or p.get("event_ticker") or "?", "side": side or "-", "contracts": str(n),
               "entry": str(entry) if entry else "-", "mark": "-", "pnl": "-"}
        if p.get("settled_at"):
            out["settled"] += 1
            row["mark"] = ("settled " + p["result"]) if p.get("result") else ("exited" if sold else "settled ?")
            if priced and p.get("pnl_cents") is not None:
                out["realized"] += p["pnl_cents"]; out["cost"] += cost
                row["pnl"] = "%+d" % p["pnl_cents"]
            elif priced:
                out["unknown_settled"] += 1; row["pnl"] = "?"
        else:
            out["open"] += 1
            if priced:
                if sold:
                    out["realized"] += exit_pnl
                mk = mark_cents(side, fetch(p["market_ticker"]))
                if mk is None:
                    out["unknown_marks"] += 1; row["mark"] = "?"; row["pnl"] = "?"
                    if sold:
                        out["cost"] += sold * entry   # the sold part has a known result even when the rest cannot be priced
                else:
                    u = (n - sold) * (mk - entry)
                    out["unrealized"] += u; out["cost"] += cost
                    row["mark"] = str(mk); row["pnl"] = "%+d" % (u + exit_pnl)
        out["rows"].append(row)
    if out["cost"] > 0:
        out["pct"] = (out["realized"] + out["unrealized"]) / out["cost"] * 100.0
    return out
```

- [ ] **Step 5: Run the whole wall suite**

Run: `cd ~/wall && python3 -m unittest discover -s tests 2>&1 | tail -6`
Expected: all pass (the previous 26 plus the 5 new ones; none of the existing `paper_return` expectations change because they carry no exit keys).

- [ ] **Step 6: Publish once and eyeball**

Run: `cd ~/wall && python3 paper-grid-publish.py --dry`
Expected: `{"dry_run": true, "slot": 13, ...}`. Then run `python3 paper-grid-publish.py` and confirm the tile on the wall still shows the same negative tiles as before this change (no exits exist yet, so nothing may change).

- [ ] **Step 7: Record the change**

The wall directory is not a git repo, so there is nothing to commit. Add one line to the repo's `HANDOFF.md` section for the wall (find "wall" with `grep -n "paper-grid" HANDOFF.md`) stating: "paper-grid-publish.py counts paper_exits (open partial = realized exit P&L + marked remainder; fully exited = 'exited', result NULL)". Commit that:

```bash
git add HANDOFF.md
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "docs(handoff): wall publisher counts paper exits" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Plan A self-review

- **Spec coverage:** spec section 4 (tables, derived pending state, markers) is Task 1; section 6 settlement is Task 2, wall is Task 3; section 3's "remaining = contracts − Σ fills" and markers are Task 1. Sections 2, 3 (fill mechanics), 5, 7, 8 belong to Plans B and C.
- **Placeholders:** none; every step carries its code or exact command.
- **Type consistency:** `OpenPaperPosition`, `ExitReviewRecord`, `ExitFillInput/Result`, `PendingExit` and all function names match the Interfaces block of Task 1 and are used unchanged in Task 2's tests.
