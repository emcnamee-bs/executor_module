# Perp Intake Lab — Plan C: The 7-Day Shadow Audit, Report and Wall Tile

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `intake-lab`, a separate paper-pinned service that watches the same news stream as the perp bot for 7 days, logs the prefilter's verdict and features for every item, audits a stratified random sample of the items the prefilter dropped (plus the boundary cases) with Sonnet under a $0.50/day cap, cross-checks against the perp mark's later move, writes an end-of-week report, and publishes its numbers to the wall tile in slot 10.

**Architecture:** The lab imports Plan A's `prefilter`, `escalate`-free hygiene and config, so it measures exactly what the bot does. Its own SQLite store `data/perp/lab.db` holds `items`, `audits`, `heartbeat`, `meta` and the same `model_calls` table the bot uses (so the existing `callJson` enforces the daily cap). It reads the bot's ledger `perp-paper.db` strictly read-only (marks, snapshots, journal). A `LabService` class holds all logic with injected dependencies; `main.ts` only wires timers, Redis and the Anthropic client.

**Tech Stack:** TypeScript (ESM, Node 22), better-sqlite3, zod, vitest; Python 3 (stdlib `unittest`) for the wall publisher.

**Spec:** `docs/superpowers/specs/2026-10-14-perp-intake-prefilter-and-lab-design.md` (sections 5-9). **Depends on Plan A** (`docs/superpowers/plans/2026-10-14-perp-intake-prefilter-a.md`) being merged on this branch: it provides `src/perp/intake/prefilter.ts`, `hygiene.ts`, `escalate.ts`, `src/perp/ops/commit.ts`, `config/perp-prefilter.json`.

## Where to work

All commands run **on mini-mac** (`ssh emac@mini-mac.local`) in `~/executor_module-perp-intake` (branch `feat/perp-intake-prefilter-lab`, Plan A already committed; `node_modules` symlinked). Never touch `~/executor_module-perp` (the running bot). TypeScript: `npx vitest run test/perp/<file>.test.ts`, `npx vitest run test/perp`, `npx tsc --noEmit`. Python wall tools live in `~/wall/` (NOT in git; edit with ssh/scp, back the file up first: `cp f f.bak-pre-<task>-$(date +%Y%m%d-%H%M%S)`); run their tests with `cd ~/wall && python3 -m unittest discover -s tests`. Never print the contents of `~/executor_module/.env` (API keys, Slack webhook, wall key).

**Baseline:** before Task 1 run `npx vitest run test/perp 2>&1 | tail -4` and record the passed count (Plan A's final count); the known full-suite failures (Redis NOAUTH / no API key, about 30 in 5 files) may not grow. In `~/wall`: `python3 -m unittest discover -s tests 2>&1 | tail -3` must stay green.

**Commits** (TypeScript tasks) use exactly:

```bash
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "<subject>" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Task 9 (the wall publisher) is outside git: no commit step.

## Global Constraints

- The lab never places an order, never writes to the bot's ledger, never reads live keys. The unit pins `PERP_MODE=paper` and strips `PERP_LIVE`/`NODE_OPTIONS` on the `ExecStart` line, like `perp-bot.service`; the process refuses to start otherwise. The bot's ledger is opened `mode=ro` (a write attempt must throw).
- Audit spend: `LAB_DAILY_USD_CAP` default **0.50** (UTC day) enforced by `callJson` over the lab's own `model_calls` table; paced so that on UTC hour `h` at most `min(cap, cap/24 x (h+2))` may have been spent (one hourly slice of slack).
- Sampling: 70% random / 30% boundary (decided per pick by a seeded RNG, `LAB_SEED`); random picks use **equal allocation over strata**, choosing the stratum with the fewest random audits so far among those with unaudited candidates; strata are `social`, `low_score`, `duplicate`, `cooldown`, `haiku_cap`. Boundary = a dropped non-social item with `score == threshold-1`, or a dropped social item with lexicon `score >= threshold`. Boundary results are never mixed into the random estimate.
- Candidates are dropped items (`prod_pass = 0`) received within the last 3 hours and not yet audited. An audit needs a bot snapshot newer than **10 minutes**; otherwise the item is skipped without a row. An error or refusal writes an audit row with `ok = 0` (no retry); a `SpendCapError` writes nothing.
- A **miss** = audited Sonnet bucket in {`moderate`, `major`, `shock`}. Statistics: Clopper-Pearson one-sided 95% upper bound (3/n when k = 0); the overall random estimate is the volume-weighted stratified rate, with the weighted sum of the per-stratum upper bounds as its (conservative) bound.
- Second signal: `ret_1h` and `ret_4h` from the bot's `marks` (nearest mark within 120 s at ingest, within 300 s at +1 h / +4 h); a dropped item is `moved` when `|ret_4h| >= 2 x sigma`, sigma = sample standard deviation of non-overlapping 4 h returns over the last 7 days of hourly marks (needs >= 6 returns, else no flag).
- Day 7: after `LAB_DAYS` (default **7**) days from the first logged item the lab stops all model spend, keeps logging features, writes the report once to `data/perp/intake-lab-week1.md` and sends one `[PERP-LAB]` alert; a re-run of the report script regenerates it.
- Failure handling: a model error skips that audit; no stream entry for 30 minutes sends one alert per silence (reuse `checkSilence`); an unreadable bot ledger turns its tile light red but never stops feature logging.
- The wall tile keeps at most **3 stat chips**, 4 health lights and 3 charts (the server reserves room for one row of chips; more chips overlap the charts); no headlines or secrets on the tile.
- Existing perp tests and the Plan A tests pass unedited.

## Review Focus

1. A redelivered stream entry must neither double-log an item nor change the dedup state a second time (Task 5 test).
2. The $0.50 cap under concurrency of timers: two overlapping `auditTick` calls must not both pay for the same item or exceed the cap (Task 5 test: a re-entrancy guard).
3. A bot ledger that is missing, locked or empty: every lab path that reads it must degrade (no crash, features still logged) (Tasks 4, 5 tests).
4. Statistical edge cases: k = 0, k = n, n = 0, a stratum with volume but no audits (Task 6 tests).
5. Day-7 transition exactly at the boundary: the report is generated once, spend stops, logging continues (Task 5 test).

---

## File Structure

- Create: `src/perp/lab/labDb.ts`, `features.ts`, `sampler.ts`, `audit.ts`, `marks.ts`, `stats.ts`, `report.ts`, `service.ts`, `startup.ts`, `main.ts`
- Create: `scripts/intake-lab-report.ts`; `deploy/mini-mac/intake-lab.service`
- Modify: `package.json` (scripts), `docs/runbook-perp.md`, the spec (section 5 clarifications)
- Tests: `test/perp/labDb.test.ts`, `labFeatures.test.ts`, `labSampler.test.ts`, `labAudit.test.ts`, `labMarks.test.ts`, `labStats.test.ts`, `labReport.test.ts`, `labService.test.ts`, `labStartup.test.ts`, `labDeploy.test.ts`
- Outside git: `~/wall/intake-lab-publish.py` (rewritten), `~/wall/tests/test_intake_lab_publish.py`

---

### Task 1: The lab database

**Files:**
- Create: `src/perp/lab/labDb.ts`
- Test: `test/perp/labDb.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LabItemRow {
  item_id: string; received_ms: number; published_ms: number | null; source_id: string; tier: number;
  headline: string; snippet: string | null; commit_sha: string;
  class: string; score: number; hits: string;            // hits = JSON array of pattern ids
  prod_pass: 0 | 1; prod_reason: string; dup_of: string | null;
  variants: string;                                       // JSON {"strict3":bool,"loose1":bool,"social_ok":bool}
  mark_at_ms: number | null; mark: number | null;
}
export function openLabDb(file: string): Database.Database;   // WAL; schema; model_calls via ensureModelCallsTable
export function insertItem(db: Database.Database, row: LabItemRow): boolean;   // INSERT OR IGNORE; true when inserted
export function hasItem(db: Database.Database, itemId: string): boolean;
export function firstItemMs(db: Database.Database): number | null;
export function getMeta(db: Database.Database, key: string): string | null;
export function setMeta(db: Database.Database, key: string, value: string): void;
```
  Tables: `items` (the columns above plus `ret_1h REAL`, `ret_4h REAL`), `audits(item_id PK, at_ms, stratum, kind CHECK in ('random','boundary'), bucket, direction, credibility, novelty, already_priced, confidence, rationale, miss, cost_usd, model, ok NOT NULL, error)`, `heartbeat(ts_ms PK, last_item_ms, stream_ok, bot_db_ok, marks_fresh)`, `meta(key PK, value)`, and `model_calls` (from `src/perp/model/callJson.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// test/perp/labDb.test.ts
import { describe, it, expect } from 'vitest';
import { firstItemMs, getMeta, hasItem, insertItem, openLabDb, setMeta, type LabItemRow } from '../../src/perp/lab/labDb.js';

const row = (over: Partial<LabItemRow> = {}): LabItemRow => ({
  item_id: 'a', received_ms: 1_000, published_ms: 900, source_id: 'axios_all', tier: 3, headline: 'Inflation heats up', snippet: null,
  commit_sha: 'abc1234', class: 'press', score: 6, hits: '["inflation"]', prod_pass: 1, prod_reason: 'pass', dup_of: null,
  variants: '{"strict3":true,"loose1":true,"social_ok":true}', mark_at_ms: 990, mark: 13.5, ...over,
});

describe('lab db', () => {
  it('creates every table, including the shared model_calls spend table', () => {
    const db = openLabDb(':memory:');
    const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['items', 'audits', 'heartbeat', 'meta', 'model_calls']));
  });
  it('inserts an item once; a redelivery is a no-op', () => {
    const db = openLabDb(':memory:');
    expect(insertItem(db, row())).toBe(true);
    expect(insertItem(db, row({ headline: 'changed' }))).toBe(false);
    expect(hasItem(db, 'a')).toBe(true);
    expect(hasItem(db, 'zzz')).toBe(false);
    expect((db.prepare('select headline from items').get() as { headline: string }).headline).toBe('Inflation heats up');
  });
  it('firstItemMs is the earliest received time, or null when empty', () => {
    const db = openLabDb(':memory:');
    expect(firstItemMs(db)).toBeNull();
    insertItem(db, row({ item_id: 'b', received_ms: 5_000 }));
    insertItem(db, row({ item_id: 'c', received_ms: 2_000 }));
    expect(firstItemMs(db)).toBe(2_000);
  });
  it('meta get/set round-trips and overwrites', () => {
    const db = openLabDb(':memory:');
    expect(getMeta(db, 'k')).toBeNull();
    setMeta(db, 'k', 'v1');
    setMeta(db, 'k', 'v2');
    expect(getMeta(db, 'k')).toBe('v2');
  });
  it('rejects an audit kind other than random or boundary, and an unknown prod_pass', () => {
    const db = openLabDb(':memory:');
    insertItem(db, row());
    const ins = db.prepare("insert into audits (item_id, at_ms, stratum, kind, ok) values ('a', 1, 'social', ?, 1)");
    expect(() => ins.run('weird')).toThrow();
    expect(() => insertItem(db, row({ item_id: 'x', prod_pass: 2 as never }))).toThrow();
  });
});
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run test/perp/labDb.test.ts` (module missing).

- [ ] **Step 3: Implement `src/perp/lab/labDb.ts`**

```ts
// src/perp/lab/labDb.ts
import Database from 'better-sqlite3';
import { ensureModelCallsTable } from '../model/callJson.js';

export interface LabItemRow {
  item_id: string;
  received_ms: number;
  published_ms: number | null;
  source_id: string;
  tier: number;
  headline: string;
  snippet: string | null;
  commit_sha: string;
  class: string;
  score: number;
  hits: string;
  prod_pass: 0 | 1;
  prod_reason: string;
  dup_of: string | null;
  variants: string;
  mark_at_ms: number | null;
  mark: number | null;
}

export function openLabDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      item_id TEXT PRIMARY KEY, received_ms INTEGER NOT NULL, published_ms INTEGER, source_id TEXT NOT NULL, tier INTEGER NOT NULL,
      headline TEXT NOT NULL, snippet TEXT, commit_sha TEXT NOT NULL,
      class TEXT NOT NULL, score INTEGER NOT NULL, hits TEXT NOT NULL,
      prod_pass INTEGER NOT NULL CHECK (prod_pass IN (0, 1)), prod_reason TEXT NOT NULL, dup_of TEXT, variants TEXT NOT NULL,
      mark_at_ms INTEGER, mark REAL, ret_1h REAL, ret_4h REAL
    );
    CREATE INDEX IF NOT EXISTS items_received ON items (received_ms);
    CREATE TABLE IF NOT EXISTS audits (
      item_id TEXT PRIMARY KEY REFERENCES items(item_id), at_ms INTEGER NOT NULL, stratum TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('random', 'boundary')),
      bucket TEXT, direction TEXT, credibility REAL, novelty TEXT, already_priced TEXT, confidence REAL, rationale TEXT,
      miss INTEGER, cost_usd REAL, model TEXT, ok INTEGER NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS heartbeat (
      ts_ms INTEGER PRIMARY KEY, last_item_ms INTEGER, stream_ok INTEGER NOT NULL, bot_db_ok INTEGER NOT NULL, marks_fresh INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  ensureModelCallsTable(db); // the audit spend lives here, so callJson's daily cap applies to the lab on its own
  return db;
}

export function insertItem(db: Database.Database, r: LabItemRow): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO items (item_id, received_ms, published_ms, source_id, tier, headline, snippet, commit_sha, class, score, hits,
         prod_pass, prod_reason, dup_of, variants, mark_at_ms, mark)
       VALUES (@item_id, @received_ms, @published_ms, @source_id, @tier, @headline, @snippet, @commit_sha, @class, @score, @hits,
         @prod_pass, @prod_reason, @dup_of, @variants, @mark_at_ms, @mark)`
    )
    .run(r);
  return res.changes > 0;
}

export function hasItem(db: Database.Database, itemId: string): boolean {
  return db.prepare('SELECT 1 FROM items WHERE item_id = ?').get(itemId) !== undefined;
}

export function firstItemMs(db: Database.Database): number | null {
  const row = db.prepare('SELECT MIN(received_ms) AS m FROM items').get() as { m: number | null };
  return row.m;
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row === undefined ? null : row.value;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
```

- [ ] **Step 4: Run to see it pass; typecheck** — `npx vitest run test/perp/labDb.test.ts && npx tsc --noEmit` (PASS).

- [ ] **Step 5: Commit**

```bash
git add src/perp/lab/labDb.ts test/perp/labDb.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(perp-lab): lab database (items, audits, heartbeat, meta, shared model_calls)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Feature extraction and rule variants

**Files:**
- Create: `src/perp/lab/features.ts`
- Test: `test/perp/labFeatures.test.ts`

**Interfaces:**
- Consumes: `prefilter`, `recordPass`, `createPrefilterState`, `scoreText`, `PrefilterConfig`, `PrefilterState`, `Verdict` (Plan A); `Item`; `LabItemRow` (Task 1).
- Produces:

```ts
export const VARIANT_NAMES = ['strict3', 'loose1', 'social_ok'] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];
export function variantConfigs(prod: PrefilterConfig): Record<VariantName, PrefilterConfig>;
export interface Evaluator { prodCfg: PrefilterConfig; prod: PrefilterState; variants: Record<Exclude<VariantName, 'strict3'>, { cfg: PrefilterConfig; state: PrefilterState }> }
export function makeEvaluator(prodCfg: PrefilterConfig): Evaluator;
export interface Evaluation { verdict: Verdict; variants: Record<VariantName, boolean>; lexScore: number; lexHits: string[] }
export function evaluate(ev: Evaluator, item: Pick<Item, 'item_id' | 'source_id' | 'headline' | 'snippet'>, nowMs: number): Evaluation;
export function toItemRow(item: Item, e: Evaluation, nowMs: number, commit: string, mark: { tsMs: number; mark: number } | null): LabItemRow;
```
  `strict3` is the production verdict itself; `loose1` = production with press `threshold` 1; `social_ok` = production with every `social` source removed from `sources` (so it is scored as press). The row's `score`/`hits` are the **lexicon** score and hits of the text for every item (including dropped social items, whose production verdict score is 0), so the sampler can find social items that scored >= threshold. `headline` is stored cut to 300 characters, `snippet` to 1200.

- [ ] **Step 1: Write the failing test**

```ts
// test/perp/labFeatures.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { loadPrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { evaluate, makeEvaluator, toItemRow, variantConfigs } from '../../src/perp/lab/features.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const cfg = () => loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));
let n = 0;
const item = (source_id: string, headline: string, snippet: string | null = null, over: Partial<Item> = {}): Item => ({
  item_id: `f${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline, snippet,
  url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0, provenance_gaps: [], amends_item_id: null, amendment_kind: null, ...over,
});

describe('variants', () => {
  it('derives loose1 (press threshold 1) and social_ok (no social class) from production', () => {
    const v = variantConfigs(cfg());
    expect(v.strict3.threshold).toBe(3);
    expect(v.loose1.threshold).toBe(1);
    expect(Object.values(v.social_ok.sources)).not.toContain('social');
    expect(v.social_ok.sources.oilprice_main).toBe('market_wire');
  });
});

describe('evaluate', () => {
  it('a social macro post: production drops it, social_ok and loose1 would have passed it, and its lexicon score is kept', () => {
    const ev = makeEvaluator(cfg());
    const e = evaluate(ev, item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall'), NOW);
    expect(e.verdict).toMatchObject({ pass: false, reason: 'source_class_drop' });
    expect(e.variants).toEqual({ strict3: false, loose1: false, social_ok: true });
    expect(e.lexScore).toBeGreaterThanOrEqual(3);
    expect(e.lexHits).toContain('inflation');
  });
  it('a score-2 press item is dropped in production but passes under loose1', () => {
    const ev = makeEvaluator(cfg());
    const e = evaluate(ev, item('ukrinform_news', 'Zelensky briefs Burnham on Russian attacks against Ukraine'), NOW);
    expect(e.verdict).toMatchObject({ pass: false, reason: 'low_score' });
    expect(e.variants).toEqual({ strict3: false, loose1: true, social_ok: true });
    expect(e.lexScore).toBe(2);
  });
  it('each variant keeps its own dedup state, and production commits its passes', () => {
    const ev = makeEvaluator(cfg());
    evaluate(ev, item('axios_all', 'Inflation heats up as gas prices surge'), NOW);
    const dup = evaluate(ev, item('thehill_news', 'Inflation heats up as gas prices surge again'), NOW);
    expect(dup.verdict.reason).toBe('duplicate');
    expect(dup.variants.loose1).toBe(false); // its own state saw the first one too
  });
});

describe('toItemRow', () => {
  it('builds a row with the lexicon score, JSON hits and variants, cut text, and the mark', () => {
    const ev = makeEvaluator(cfg());
    const it = item('axios_all', 'Inflation heats up as gas prices surge ' + 'x'.repeat(400), 's'.repeat(2000));
    const e = evaluate(ev, it, NOW);
    const r = toItemRow(it, e, NOW, 'abc1234', { tsMs: NOW - 1000, mark: 13.55 });
    expect(r).toMatchObject({ item_id: it.item_id, received_ms: NOW, source_id: 'axios_all', tier: 3, commit_sha: 'abc1234', class: 'press', prod_pass: 1, prod_reason: 'pass', mark_at_ms: NOW - 1000, mark: 13.55 });
    expect(r.headline).toHaveLength(300);
    expect(r.snippet).toHaveLength(1200);
    expect(JSON.parse(r.hits)).toContain('inflation');
    expect(JSON.parse(r.variants)).toEqual({ strict3: true, loose1: true, social_ok: true });
    expect(r.published_ms).toBe(NOW - 60_000);
  });
  it('null publish time and null mark are stored as null', () => {
    const ev = makeEvaluator(cfg());
    const it = item('axios_all', 'Quiet day', null, { source_publish_ts: 'garbage' });
    const r = toItemRow(it, evaluate(ev, it, NOW), NOW, 'c', null);
    expect(r.published_ms).toBeNull();
    expect(r.mark).toBeNull();
    expect(r.mark_at_ms).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run test/perp/labFeatures.test.ts` (FAIL, module missing).

- [ ] **Step 3: Implement `src/perp/lab/features.ts`**

```ts
// src/perp/lab/features.ts
//
// What the lab records about every item: the production prefilter verdict (the SAME function the bot runs), the lexicon score
// and hits, and what two looser rule variants would have done. Each variant owns its dedup/cap state, so a replay of the same week
// through a different rule set stays internally consistent.
import type { Item } from '../../item.js';
import {
  createPrefilterState, prefilter, recordPass, scoreText, type PrefilterConfig, type PrefilterState, type Verdict,
} from '../intake/prefilter.js';
import type { LabItemRow } from './labDb.js';

export const VARIANT_NAMES = ['strict3', 'loose1', 'social_ok'] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

export function variantConfigs(prod: PrefilterConfig): Record<VariantName, PrefilterConfig> {
  const noSocial = Object.fromEntries(Object.entries(prod.sources).filter(([, c]) => c !== 'social')) as PrefilterConfig['sources'];
  return {
    strict3: prod,
    loose1: { ...prod, threshold: 1 },
    social_ok: { ...prod, sources: noSocial },
  };
}

export interface Evaluator {
  prodCfg: PrefilterConfig;
  prod: PrefilterState;
  variants: Record<Exclude<VariantName, 'strict3'>, { cfg: PrefilterConfig; state: PrefilterState }>;
}

export function makeEvaluator(prodCfg: PrefilterConfig): Evaluator {
  const v = variantConfigs(prodCfg);
  return {
    prodCfg,
    prod: createPrefilterState(),
    variants: { loose1: { cfg: v.loose1, state: createPrefilterState() }, social_ok: { cfg: v.social_ok, state: createPrefilterState() } },
  };
}

export interface Evaluation {
  verdict: Verdict;
  variants: Record<VariantName, boolean>;
  lexScore: number;
  lexHits: string[];
}

type Evaluable = Pick<Item, 'item_id' | 'source_id' | 'headline' | 'snippet'>;

export function evaluate(ev: Evaluator, item: Evaluable, nowMs: number): Evaluation {
  const verdict = prefilter(item, ev.prodCfg, ev.prod, nowMs);
  if (verdict.pass) recordPass(ev.prod, item, verdict, nowMs, ev.prodCfg);
  const lex = scoreText(item.headline, item.snippet, ev.prodCfg);
  const run = (v: { cfg: PrefilterConfig; state: PrefilterState }): boolean => {
    const r = prefilter(item, v.cfg, v.state, nowMs);
    if (r.pass) recordPass(v.state, item, r, nowMs, v.cfg);
    return r.pass;
  };
  return {
    verdict,
    variants: { strict3: verdict.pass, loose1: run(ev.variants.loose1), social_ok: run(ev.variants.social_ok) },
    lexScore: lex.score,
    lexHits: lex.hits,
  };
}

export function toItemRow(item: Item, e: Evaluation, nowMs: number, commit: string, mark: { tsMs: number; mark: number } | null): LabItemRow {
  const published = Date.parse(item.source_publish_ts ?? item.first_seen_ts);
  return {
    item_id: item.item_id,
    received_ms: nowMs,
    published_ms: Number.isFinite(published) ? published : null,
    source_id: item.source_id,
    tier: item.trust_tier,
    headline: item.headline.slice(0, 300),
    snippet: item.snippet === null ? null : item.snippet.slice(0, 1200),
    commit_sha: commit,
    class: e.verdict.sourceClass,
    score: e.lexScore,
    hits: JSON.stringify(e.lexHits),
    prod_pass: e.verdict.pass ? 1 : 0,
    prod_reason: e.verdict.reason,
    dup_of: e.verdict.dupOf ?? null,
    variants: JSON.stringify(e.variants),
    mark_at_ms: mark === null ? null : mark.tsMs,
    mark: mark === null ? null : mark.mark,
  };
}
```

- [ ] **Step 4: Run to see it pass; typecheck** — `npx vitest run test/perp/labFeatures.test.ts && npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/perp/lab/features.ts test/perp/labFeatures.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(perp-lab): per-item features and the loose1 / social_ok rule variants" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The audit sampler and budget pacing

**Files:**
- Create: `src/perp/lab/sampler.ts`
- Test: `test/perp/labSampler.test.ts`

**Interfaces:**
- Consumes: `LabItemRow`, `openLabDb` (Task 1).
- Produces:

```ts
export type Stratum = 'social' | 'low_score' | 'duplicate' | 'cooldown' | 'haiku_cap';
export const STRATA: readonly Stratum[];
export type AuditKind = 'random' | 'boundary';
export interface Candidate { itemId: string; stratum: Stratum; boundary: boolean }
export const BOUNDARY_SHARE = 0.3;
export const CANDIDATE_WINDOW_MS = 3 * 3_600_000;
export function stratumOf(prodReason: string): Stratum | null;
export function isBoundary(row: { class: string; score: number; prod_pass: number; prod_reason: string }, threshold: number): boolean;
export function pacedAllowanceUsd(capUsd: number, nowMs: number): number;
export function canSpendNow(capUsd: number, spentTodayUsd: number, nowMs: number): boolean;
export function makeRng(seed: number): () => number;               // mulberry32, uniform in [0, 1)
export function listCandidates(db: Database.Database, sinceMs: number, threshold: number): Candidate[];
export function randomAuditCounts(db: Database.Database): Record<Stratum, number>;
export function chooseCandidate(cands: Candidate[], audited: Record<Stratum, number>, rng: () => number): { candidate: Candidate; kind: AuditKind } | null;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/perp/labSampler.test.ts
import { describe, it, expect } from 'vitest';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
import {
  canSpendNow, chooseCandidate, isBoundary, listCandidates, makeRng, pacedAllowanceUsd, randomAuditCounts, stratumOf, STRATA, type Candidate, type Stratum,
} from '../../src/perp/lab/sampler.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const row = (over: Partial<LabItemRow>): LabItemRow => ({
  item_id: 'x', received_ms: NOW - 60_000, published_ms: null, source_id: 'axios_all', tier: 3, headline: 'h', snippet: null, commit_sha: 'c', class: 'press',
  score: 1, hits: '[]', prod_pass: 0, prod_reason: 'low_score', dup_of: null, variants: '{}', mark_at_ms: null, mark: null, ...over,
});
const zero = (): Record<Stratum, number> => ({ social: 0, low_score: 0, duplicate: 0, cooldown: 0, haiku_cap: 0 });

describe('stratumOf / isBoundary', () => {
  it('maps drop reasons to strata and a pass to none', () => {
    expect(stratumOf('source_class_drop')).toBe('social');
    expect(stratumOf('low_score')).toBe('low_score');
    expect(stratumOf('duplicate')).toBe('duplicate');
    expect(stratumOf('cooldown')).toBe('cooldown');
    expect(stratumOf('haiku_cap')).toBe('haiku_cap');
    expect(stratumOf('pass')).toBeNull();
    expect(STRATA).toHaveLength(5);
  });
  it('boundary = non-social low score at threshold-1, or social at/above the threshold', () => {
    expect(isBoundary({ class: 'press', score: 2, prod_pass: 0, prod_reason: 'low_score' }, 3)).toBe(true);
    expect(isBoundary({ class: 'press', score: 1, prod_pass: 0, prod_reason: 'low_score' }, 3)).toBe(false);
    expect(isBoundary({ class: 'social', score: 3, prod_pass: 0, prod_reason: 'source_class_drop' }, 3)).toBe(true);
    expect(isBoundary({ class: 'social', score: 2, prod_pass: 0, prod_reason: 'source_class_drop' }, 3)).toBe(false);
    expect(isBoundary({ class: 'press', score: 2, prod_pass: 1, prod_reason: 'pass' }, 3)).toBe(false);
    expect(isBoundary({ class: 'press', score: 5, prod_pass: 0, prod_reason: 'duplicate' }, 3)).toBe(false);
  });
});

describe('pacing', () => {
  const at = (h: number) => Date.UTC(2026, 9, 14, h, 30, 0);
  it('allows two hourly slices at the start of the UTC day and the full cap from hour 22', () => {
    expect(pacedAllowanceUsd(0.5, at(0))).toBeCloseTo((0.5 / 24) * 2);
    expect(pacedAllowanceUsd(0.5, at(10))).toBeCloseTo((0.5 / 24) * 12);
    expect(pacedAllowanceUsd(0.5, at(22))).toBeCloseTo(0.5);
    expect(pacedAllowanceUsd(0.5, at(23))).toBeCloseTo(0.5);
  });
  it('canSpendNow is strictly below the allowance', () => {
    expect(canSpendNow(0.5, 0, at(0))).toBe(true);
    expect(canSpendNow(0.5, (0.5 / 24) * 2, at(0))).toBe(false);
    expect(canSpendNow(0.5, 0.5, at(23))).toBe(false);
  });
});

describe('makeRng', () => {
  it('is reproducible per seed, in [0,1), and differs between seeds', () => {
    const a = makeRng(7); const b = makeRng(7); const c = makeRng(8);
    const xs = [a(), a(), a()]; const ys = [b(), b(), b()];
    expect(xs).toEqual(ys);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect([c(), c(), c()]).not.toEqual(xs);
  });
});

describe('listCandidates / randomAuditCounts', () => {
  it('lists unaudited dropped items inside the window, never passes or audited ones', () => {
    const db = openLabDb(':memory:');
    insertItem(db, row({ item_id: 'drop1' }));
    insertItem(db, row({ item_id: 'passed', prod_pass: 1, prod_reason: 'pass' }));
    insertItem(db, row({ item_id: 'old', received_ms: NOW - 4 * 3_600_000 }));
    insertItem(db, row({ item_id: 'audited' }));
    insertItem(db, row({ item_id: 'soc', class: 'social', prod_reason: 'source_class_drop', score: 4 }));
    db.prepare("insert into audits (item_id, at_ms, stratum, kind, ok) values ('audited', 1, 'low_score', 'random', 1)").run();
    const c = listCandidates(db, NOW - 3 * 3_600_000, 3);
    expect(c.map((x) => x.itemId).sort()).toEqual(['drop1', 'soc']);
    expect(c.find((x) => x.itemId === 'soc')).toMatchObject({ stratum: 'social', boundary: true });
    expect(c.find((x) => x.itemId === 'drop1')).toMatchObject({ stratum: 'low_score', boundary: false });
  });
  it('counts only random audits per stratum', () => {
    const db = openLabDb(':memory:');
    insertItem(db, row({ item_id: 'a' })); insertItem(db, row({ item_id: 'b' })); insertItem(db, row({ item_id: 'c' }));
    const ins = db.prepare('insert into audits (item_id, at_ms, stratum, kind, ok) values (?, 1, ?, ?, 1)');
    ins.run('a', 'low_score', 'random'); ins.run('b', 'low_score', 'boundary'); ins.run('c', 'social', 'random');
    expect(randomAuditCounts(db)).toEqual({ ...zero(), low_score: 1, social: 1 });
  });
});

describe('chooseCandidate', () => {
  const cands: Candidate[] = [
    { itemId: 'a1', stratum: 'social', boundary: false }, { itemId: 'a2', stratum: 'social', boundary: true },
    { itemId: 'b1', stratum: 'low_score', boundary: false }, { itemId: 'c1', stratum: 'duplicate', boundary: false },
  ];
  it('returns null with no candidates', () => {
    expect(chooseCandidate([], zero(), makeRng(1))).toBeNull();
  });
  it('random picks use equal allocation: the least-audited stratum wins', () => {
    const rng = () => 0.99; // never boundary
    expect(chooseCandidate(cands, { ...zero(), social: 5, low_score: 2, duplicate: 3 }, rng)).toMatchObject({ kind: 'random', candidate: { stratum: 'low_score' } });
    expect(chooseCandidate(cands, { ...zero(), social: 0, low_score: 2, duplicate: 3 }, rng)?.candidate.stratum).toBe('social');
  });
  it('a boundary pick is taken only from boundary candidates, and falls back to random when there are none', () => {
    const lowRng = () => 0.0; // wants boundary
    expect(chooseCandidate(cands, zero(), lowRng)).toMatchObject({ kind: 'boundary', candidate: { itemId: 'a2' } });
    const noBoundary = cands.filter((c) => !c.boundary);
    expect(chooseCandidate(noBoundary, zero(), lowRng)?.kind).toBe('random');
  });
  it('over many seeded draws about 30% are boundary', () => {
    const rng = makeRng(42);
    let b = 0; const n = 2000;
    for (let i = 0; i < n; i++) if (chooseCandidate(cands, zero(), rng)?.kind === 'boundary') b += 1;
    expect(b / n).toBeGreaterThan(0.25);
    expect(b / n).toBeLessThan(0.35);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run test/perp/labSampler.test.ts`.

- [ ] **Step 3: Implement `src/perp/lab/sampler.ts`**

```ts
// src/perp/lab/sampler.ts
//
// Which dropped item to audit next, and whether the day's budget allows it (spec section 5). All selection is pure given an RNG.
import type Database from 'better-sqlite3';

export type Stratum = 'social' | 'low_score' | 'duplicate' | 'cooldown' | 'haiku_cap';
export const STRATA: readonly Stratum[] = ['social', 'low_score', 'duplicate', 'cooldown', 'haiku_cap'];
export type AuditKind = 'random' | 'boundary';
export interface Candidate { itemId: string; stratum: Stratum; boundary: boolean }

export const BOUNDARY_SHARE = 0.3;
export const CANDIDATE_WINDOW_MS = 3 * 3_600_000;

export function stratumOf(prodReason: string): Stratum | null {
  switch (prodReason) {
    case 'source_class_drop': return 'social';
    case 'low_score': return 'low_score';
    case 'duplicate': return 'duplicate';
    case 'cooldown': return 'cooldown';
    case 'haiku_cap': return 'haiku_cap';
    default: return null;
  }
}

export function isBoundary(row: { class: string; score: number; prod_pass: number; prod_reason: string }, threshold: number): boolean {
  if (row.prod_pass !== 0) return false;
  if (row.class === 'social') return row.score >= threshold;
  return row.prod_reason === 'low_score' && row.score === threshold - 1;
}

/** The most the lab may have spent by now (UTC day): the schedule of cap/24 per hour plus one hourly slice of slack. */
export function pacedAllowanceUsd(capUsd: number, nowMs: number): number {
  const hour = new Date(nowMs).getUTCHours();
  return Math.min(capUsd, (capUsd / 24) * (hour + 2));
}

export function canSpendNow(capUsd: number, spentTodayUsd: number, nowMs: number): boolean {
  return spentTodayUsd < pacedAllowanceUsd(capUsd, nowMs);
}

/** mulberry32: a tiny seeded generator, uniform in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function listCandidates(db: Database.Database, sinceMs: number, threshold: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT i.item_id, i.class, i.score, i.prod_pass, i.prod_reason
         FROM items i LEFT JOIN audits a ON a.item_id = i.item_id
        WHERE a.item_id IS NULL AND i.prod_pass = 0 AND i.received_ms >= ?
        ORDER BY i.received_ms ASC`
    )
    .all(sinceMs) as Array<{ item_id: string; class: string; score: number; prod_pass: number; prod_reason: string }>;
  const out: Candidate[] = [];
  for (const r of rows) {
    const stratum = stratumOf(r.prod_reason);
    if (stratum !== null) out.push({ itemId: r.item_id, stratum, boundary: isBoundary(r, threshold) });
  }
  return out;
}

export function randomAuditCounts(db: Database.Database): Record<Stratum, number> {
  const counts = { social: 0, low_score: 0, duplicate: 0, cooldown: 0, haiku_cap: 0 } as Record<Stratum, number>;
  const rows = db.prepare("SELECT stratum, COUNT(*) AS n FROM audits WHERE kind = 'random' GROUP BY stratum").all() as Array<{ stratum: Stratum; n: number }>;
  for (const r of rows) if (r.stratum in counts) counts[r.stratum] = r.n;
  return counts;
}

export function chooseCandidate(cands: Candidate[], audited: Record<Stratum, number>, rng: () => number): { candidate: Candidate; kind: AuditKind } | null {
  if (cands.length === 0) return null;
  const boundary = cands.filter((c) => c.boundary);
  if (rng() < BOUNDARY_SHARE && boundary.length > 0) {
    return { candidate: boundary[Math.floor(rng() * boundary.length)], kind: 'boundary' };
  }
  // Random sample: equal allocation, so the rare strata (duplicate, cooldown, cap) get data too. Ties go to the earlier stratum.
  let best: Stratum | null = null;
  for (const s of STRATA) {
    if (!cands.some((c) => c.stratum === s)) continue;
    if (best === null || audited[s] < audited[best]) best = s;
  }
  const pool = cands.filter((c) => c.stratum === best);
  return { candidate: pool[Math.floor(rng() * pool.length)], kind: 'random' };
}
```

- [ ] **Step 4: Run to see it pass; typecheck** — `npx vitest run test/perp/labSampler.test.ts && npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/perp/lab/sampler.ts test/perp/labSampler.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(perp-lab): stratified audit sampler, boundary picks and budget pacing" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The audit step and the marks cross-check

**Files:**
- Create: `src/perp/lab/audit.ts`, `src/perp/lab/marks.ts`
- Test: `test/perp/labAudit.test.ts`, `test/perp/labMarks.test.ts`

**Interfaces:**
- Consumes: `extractImpact`, `ModelDeps`, `summarizeContext`, `SpendCapError`, `modelSpendTodayUsd`, `markNear`, `hourlyMarks`, `recordMark`, `saveSnapshot`, `openPerpDb` (existing); Tasks 1-3.
- Produces:

```ts
// audit.ts
export const CONTEXT_MAX_AGE_MS = 10 * 60_000;
export const MISS_BUCKETS: ReadonlySet<string>;   // moderate, major, shock
export type AuditOutcome = 'audited' | 'no_context' | 'cap' | 'error';
export interface AuditRow { item_id: string; received_ms: number; published_ms: number | null; source_id: string; tier: number; headline: string; snippet: string | null }
export interface AuditDeps { labDb: Database.Database; botDb: Database.Database; modelDeps: ModelDeps; now: () => number; extract?: typeof extractImpact }
export function latestContext(botDb: Database.Database, nowMs: number, maxAgeMs?: number): string | null;
export function rowToItem(row: AuditRow): Item;
export function auditItem(deps: AuditDeps, row: AuditRow, stratum: Stratum, kind: AuditKind): Promise<AuditOutcome>;
// marks.ts
export function markAtIngest(botDb: Database.Database, receivedMs: number): { tsMs: number; mark: number } | null;   // nearest mark within 120 s
export function sigma4h(botDb: Database.Database, nowMs: number): number | null;
export function movedFlag(ret4h: number | null, sigma: number | null): boolean;
export function fillReturns(labDb: Database.Database, botDb: Database.Database, nowMs: number): number;   // number of rows updated
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/perp/labAudit.test.ts
import { describe, it, expect } from 'vitest';
import type { ImpactAssessment, Snapshot } from '../../src/perp/types.js';
import { SpendCapError } from '../../src/perp/model/callJson.js';
import { openPerpDb, saveSnapshot } from '../../src/perp/store/db.js';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
import { auditItem, latestContext, rowToItem, type AuditRow } from '../../src/perp/lab/audit.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const snap = (tsMs: number): Snapshot => ({
  tsMs, perp: { bid: 13.75, ask: 13.76, mark: 13.755, marketOpen: true, nextCloseTsMs: tsMs + 26 * 3_600_000, fundingEstimate: 0.0001 },
  returns: { d1: 0.0123, d5: -0.0041 }, realizedWeeklySigma: null, macro: { vix: { value: 16.2, change1d: -0.3, asOf: '2026-10-13' } },
  events: [], kalshiEvents: [], freshness: { perpAgeMs: 1000, macroAgeMs: 3_600_000 },
});
const itemRow = (over: Partial<LabItemRow> = {}): LabItemRow => ({
  item_id: 'i1', received_ms: NOW - 30_000, published_ms: NOW - 90_000, source_id: 'bluesky_geopolitics', tier: 4, headline: 'Fed to cut rates', snippet: 'details', commit_sha: 'c',
  class: 'social', score: 6, hits: '[]', prod_pass: 0, prod_reason: 'source_class_drop', dup_of: null, variants: '{}', mark_at_ms: null, mark: null, ...over,
});
const assessment = (bucket: ImpactAssessment['bucket']): ImpactAssessment => ({
  itemId: 'i1', receivedAtMs: NOW, publishedAtMs: NOW, direction: 'down', bucket, horizon: 'days', credibility: 0.4, novelty: 'new', alreadyPriced: 'unclear', confidence: 0.7, rationale: 'because',
});
function setup(extract: (...a: any[]) => Promise<ImpactAssessment>, snapshotAt: number | null = NOW - 60_000) {
  const labDb = openLabDb(':memory:');
  const botDb = openPerpDb(':memory:');
  if (snapshotAt !== null) saveSnapshot(botDb, snap(snapshotAt));
  insertItem(labDb, itemRow());
  const modelDeps = { client: {} as never, db: labDb, dailyUsdCap: 0.5, now: () => NOW };
  const row = labDb.prepare('select item_id, received_ms, published_ms, source_id, tier, headline, snippet from items').get() as AuditRow;
  return { labDb, botDb, row, deps: { labDb, botDb, modelDeps, now: () => NOW, extract } };
}
const auditRow = (db: ReturnType<typeof openLabDb>) => db.prepare('select * from audits').get() as Record<string, unknown> | undefined;

describe('latestContext', () => {
  it('builds the bot-style context from the newest snapshot, flat and with no news pressure', () => {
    const botDb = openPerpDb(':memory:');
    saveSnapshot(botDb, snap(NOW - 120_000));
    const text = latestContext(botDb, NOW)!;
    expect(text).toContain('perp mark 13.755');
    expect(text).toContain('position: flat');
  });
  it('is null when there is no snapshot or it is older than 10 minutes', () => {
    const botDb = openPerpDb(':memory:');
    expect(latestContext(botDb, NOW)).toBeNull();
    saveSnapshot(botDb, snap(NOW - 11 * 60_000));
    expect(latestContext(botDb, NOW)).toBeNull();
  });
});

describe('rowToItem', () => {
  it('rebuilds a valid Item the bot prompt can use', () => {
    const it = rowToItem({ item_id: 'i1', received_ms: NOW, published_ms: NOW - 1000, source_id: 's', tier: 3, headline: 'h', snippet: null });
    expect(it).toMatchObject({ item_id: 'i1', source_id: 's', trust_tier: 3, headline: 'h', snippet: null, event_type: 'item', replay: false });
    expect(it.source_publish_ts).toBe(new Date(NOW - 1000).toISOString());
  });
});

describe('auditItem', () => {
  it('records the assessment, flags a miss for moderate or higher, and takes the cost from model_calls', async () => {
    const { labDb, botDb, row, deps } = setup(async () => assessment('moderate'));
    labDb.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'impact', 'claude-sonnet-5-5', 'i1', 10, 5, 0.0042, 1)").run(NOW);
    expect(await auditItem(deps, row, 'social', 'random')).toBe('audited');
    expect(auditRow(labDb)).toMatchObject({ item_id: 'i1', stratum: 'social', kind: 'random', bucket: 'moderate', direction: 'down', miss: 1, ok: 1, cost_usd: 0.0042, rationale: 'because' });
    botDb.close();
  });
  it('minor is not a miss', async () => {
    const { labDb, row, deps } = setup(async () => assessment('minor'));
    await auditItem(deps, row, 'low_score', 'boundary');
    expect(auditRow(labDb)).toMatchObject({ bucket: 'minor', miss: 0, kind: 'boundary' });
  });
  it.each(['major', 'shock'] as const)('%s is a miss', async (b) => {
    const { labDb, row, deps } = setup(async () => assessment(b));
    await auditItem(deps, row, 'social', 'random');
    expect(auditRow(labDb)).toMatchObject({ miss: 1 });
  });
  it('skips without a row when there is no fresh market context', async () => {
    const { labDb, row, deps } = setup(async () => assessment('minor'), null);
    expect(await auditItem(deps, row, 'social', 'random')).toBe('no_context');
    expect(auditRow(labDb)).toBeUndefined();
  });
  it('a spend-cap refusal writes nothing and reports cap', async () => {
    const { labDb, row, deps } = setup(async () => { throw new SpendCapError('cap'); });
    expect(await auditItem(deps, row, 'social', 'random')).toBe('cap');
    expect(auditRow(labDb)).toBeUndefined();
  });
  it('any other model error writes an ok=0 row (no retry) and reports error', async () => {
    const { labDb, row, deps } = setup(async () => { throw new Error('503 overloaded'); });
    expect(await auditItem(deps, row, 'social', 'random')).toBe('error');
    expect(auditRow(labDb)).toMatchObject({ ok: 0, miss: null, error: '503 overloaded' });
  });
  it('auditing the same item twice never writes two rows', async () => {
    const { labDb, row, deps } = setup(async () => assessment('minor'));
    await auditItem(deps, row, 'social', 'random');
    await auditItem(deps, row, 'social', 'random');
    expect((labDb.prepare('select count(*) as n from audits').get() as { n: number }).n).toBe(1);
  });
});
```

```ts
// test/perp/labMarks.test.ts
import { describe, it, expect } from 'vitest';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
import { fillReturns, markAtIngest, movedFlag, sigma4h } from '../../src/perp/lab/marks.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const item = (over: Partial<LabItemRow>): LabItemRow => ({
  item_id: 'a', received_ms: NOW - 5 * H, published_ms: null, source_id: 's', tier: 3, headline: 'h', snippet: null, commit_sha: 'c', class: 'press', score: 1,
  hits: '[]', prod_pass: 0, prod_reason: 'low_score', dup_of: null, variants: '{}', mark_at_ms: NOW - 5 * H, mark: 100, ...over,
});

describe('markAtIngest', () => {
  it('returns the nearest mark within 120 s, else null', () => {
    const bot = openPerpDb(':memory:');
    recordMark(bot, NOW - 30_000, 13.5);
    expect(markAtIngest(bot, NOW)).toEqual({ tsMs: NOW - 30_000, mark: 13.5 });
    expect(markAtIngest(bot, NOW + 10 * 60_000)).toBeNull();
    expect(markAtIngest(openPerpDb(':memory:'), NOW)).toBeNull();
  });
});

describe('fillReturns', () => {
  it('fills ret_1h and ret_4h from later marks once they are due, and leaves recent or unpriced items alone', () => {
    const bot = openPerpDb(':memory:'); const lab = openLabDb(':memory:');
    recordMark(bot, NOW - 5 * H + H, 101); // +1h
    recordMark(bot, NOW - 5 * H + 4 * H, 104); // +4h
    insertItem(lab, item({ item_id: 'due' }));
    insertItem(lab, item({ item_id: 'recent', received_ms: NOW - 30 * 60_000, mark_at_ms: NOW - 30 * 60_000 }));
    insertItem(lab, item({ item_id: 'nomark', mark: null, mark_at_ms: null }));
    expect(fillReturns(lab, bot, NOW)).toBe(1);
    const r = lab.prepare('select item_id, ret_1h, ret_4h from items order by item_id').all() as Array<{ item_id: string; ret_1h: number | null; ret_4h: number | null }>;
    const due = r.find((x) => x.item_id === 'due')!;
    expect(due.ret_1h).toBeCloseTo(0.01, 9);
    expect(due.ret_4h).toBeCloseTo(0.04, 9);
    expect(r.find((x) => x.item_id === 'recent')).toMatchObject({ ret_1h: null, ret_4h: null });
    expect(r.find((x) => x.item_id === 'nomark')).toMatchObject({ ret_1h: null, ret_4h: null });
    expect(fillReturns(lab, bot, NOW)).toBe(0); // idempotent
  });
  it('a missing later mark leaves the return null instead of inventing one', () => {
    const bot = openPerpDb(':memory:'); const lab = openLabDb(':memory:');
    insertItem(lab, item({ item_id: 'gap' }));
    expect(fillReturns(lab, bot, NOW)).toBe(0);
    expect((lab.prepare('select ret_1h from items').get() as { ret_1h: number | null }).ret_1h).toBeNull();
  });
});

describe('sigma4h / movedFlag', () => {
  it('is null with too little history and a positive number with enough', () => {
    const bot = openPerpDb(':memory:');
    expect(sigma4h(bot, NOW)).toBeNull();
    let m = 100;
    for (let h = 0; h < 80; h++) { m *= h % 8 < 4 ? 1.004 : 0.996; recordMark(bot, NOW - (80 - h) * H + 1000, m); }
    const s = sigma4h(bot, NOW);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0);
    expect(s!).toBeLessThan(0.02);
  });
  it('flags only when |ret_4h| reaches twice sigma, and never without both inputs', () => {
    expect(movedFlag(0.02, 0.01)).toBe(true);
    expect(movedFlag(-0.02, 0.01)).toBe(true);
    expect(movedFlag(0.0199, 0.01)).toBe(false);
    expect(movedFlag(null, 0.01)).toBe(false);
    expect(movedFlag(0.05, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run test/perp/labAudit.test.ts test/perp/labMarks.test.ts`.

- [ ] **Step 3: Implement**

```ts
// src/perp/lab/audit.ts
//
// One audit: ask Sonnet (the bot's own impact prompt, so labels are comparable) how much a DROPPED item should have mattered.
// Spend, cap and the model_calls row are handled by callJson on the lab's own database.
import type Database from 'better-sqlite3';
import { ItemSchema, type Item } from '../../item.js';
import { SpendCapError } from '../model/callJson.js';
import { summarizeContext } from '../model/context.js';
import type { ModelDeps } from '../model/gate.js';
import { extractImpact } from '../model/impact.js';
import type { Snapshot } from '../types.js';
import type { AuditKind, Stratum } from './sampler.js';

export const CONTEXT_MAX_AGE_MS = 10 * 60_000;
export const MISS_BUCKETS: ReadonlySet<string> = new Set(['moderate', 'major', 'shock']);
export type AuditOutcome = 'audited' | 'no_context' | 'cap' | 'error';

export interface AuditRow {
  item_id: string; received_ms: number; published_ms: number | null; source_id: string; tier: number; headline: string; snippet: string | null;
}
export interface AuditDeps {
  labDb: Database.Database;
  botDb: Database.Database;
  modelDeps: ModelDeps;
  now: () => number;
  extract?: typeof extractImpact;
}

/** The bot's market context from its newest snapshot (read-only), as if flat with no news pressure; null when none is fresh. */
export function latestContext(botDb: Database.Database, nowMs: number, maxAgeMs: number = CONTEXT_MAX_AGE_MS): string | null {
  const row = botDb.prepare('SELECT ts_ms, json FROM snapshots ORDER BY ts_ms DESC LIMIT 1').get() as { ts_ms: number; json: string } | undefined;
  if (row === undefined || nowMs - row.ts_ms > maxAgeMs) return null;
  return summarizeContext({ snapshot: JSON.parse(row.json) as Snapshot, position: null, pressureNow: 0, topItems: [] });
}

export function rowToItem(row: Pick<AuditRow, 'item_id' | 'received_ms' | 'published_ms' | 'source_id' | 'tier' | 'headline' | 'snippet'>): Item {
  const received = new Date(row.received_ms).toISOString();
  return ItemSchema.parse({
    item_id: row.item_id, dedup_id: row.item_id, source_id: row.source_id, adapter: 'lab', trust_tier: row.tier, headline: row.headline,
    snippet: row.snippet, source_publish_ts: row.published_ms === null ? null : new Date(row.published_ms).toISOString(),
    first_seen_ts: received, emitted_ts: received,
  });
}

export async function auditItem(deps: AuditDeps, row: AuditRow, stratum: Stratum, kind: AuditKind): Promise<AuditOutcome> {
  const now = deps.now();
  const context = latestContext(deps.botDb, now);
  if (context === null) return 'no_context';
  const extract = deps.extract ?? extractImpact;
  try {
    const a = await extract(deps.modelDeps, rowToItem(row), context, now);
    const cost = deps.labDb
      .prepare("SELECT cost_usd FROM model_calls WHERE item_id = ? AND stage = 'impact' ORDER BY id DESC LIMIT 1")
      .get(row.item_id) as { cost_usd: number } | undefined;
    deps.labDb
      .prepare(
        `INSERT OR IGNORE INTO audits (item_id, at_ms, stratum, kind, bucket, direction, credibility, novelty, already_priced, confidence, rationale, miss, cost_usd, model, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
      )
      .run(row.item_id, now, stratum, kind, a.bucket, a.direction, a.credibility, a.novelty, a.alreadyPriced, a.confidence, a.rationale,
        MISS_BUCKETS.has(a.bucket) ? 1 : 0, cost?.cost_usd ?? null, deps.modelDeps.impactModel ?? 'claude-sonnet-5-5');
    return 'audited';
  } catch (err) {
    if (err instanceof SpendCapError) return 'cap';
    deps.labDb
      .prepare(
        `INSERT OR IGNORE INTO audits (item_id, at_ms, stratum, kind, miss, ok, error) VALUES (?, ?, ?, ?, NULL, 0, ?)`
      )
      .run(row.item_id, now, stratum, kind, (err instanceof Error ? err.message : String(err)).slice(0, 300));
    return 'error';
  }
}
```

```ts
// src/perp/lab/marks.ts
//
// The second signal: what the perp mark did after each item. Everything reads the bot's ledger read-only.
import type Database from 'better-sqlite3';
import { hourlyMarks, markNear } from '../store/db.js';

const H = 3_600_000;
const INGEST_GAP_MS = 120_000;
const LATER_GAP_MS = 300_000;
const FILL_LOOKBACK_MS = 12 * H;

export function markAtIngest(botDb: Database.Database, receivedMs: number): { tsMs: number; mark: number } | null {
  return markNear(botDb, receivedMs, INGEST_GAP_MS);
}

/** Sample standard deviation of non-overlapping 4 h returns over the last 7 days of hourly marks; null with fewer than 6 returns. */
export function sigma4h(botDb: Database.Database, nowMs: number): number | null {
  const hm = hourlyMarks(botDb, nowMs - 7 * 24 * H);
  if (hm.length === 0) return null;
  const byHour = new Map<number, number>();
  for (const m of hm) byHour.set(Math.floor(m.tsMs / H), m.mark);
  const hours = [...byHour.keys()];
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours);
  const rets: number[] = [];
  for (let h = minH; h + 4 <= maxH; h += 4) {
    const a = byHour.get(h);
    const b = byHour.get(h + 4);
    if (a !== undefined && b !== undefined && a > 0) rets.push(b / a - 1);
  }
  if (rets.length < 6) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance);
}

export function movedFlag(ret4h: number | null, sigma: number | null): boolean {
  return ret4h !== null && sigma !== null && Math.abs(ret4h) >= 2 * sigma;
}

/** Fill ret_1h / ret_4h for items whose horizon has passed (within the last 12 h). Returns the number of rows changed. Never invents a return. */
export function fillReturns(labDb: Database.Database, botDb: Database.Database, nowMs: number): number {
  const rows = labDb
    .prepare(
      `SELECT item_id, received_ms, mark, ret_1h, ret_4h FROM items
        WHERE mark IS NOT NULL AND received_ms >= ?
          AND ((ret_1h IS NULL AND received_ms <= ?) OR (ret_4h IS NULL AND received_ms <= ?))`
    )
    .all(nowMs - FILL_LOOKBACK_MS, nowMs - H, nowMs - 4 * H) as Array<{ item_id: string; received_ms: number; mark: number; ret_1h: number | null; ret_4h: number | null }>;
  const upd1 = labDb.prepare('UPDATE items SET ret_1h = ? WHERE item_id = ?');
  const upd4 = labDb.prepare('UPDATE items SET ret_4h = ? WHERE item_id = ?');
  let changed = 0;
  for (const r of rows) {
    let did = false;
    if (r.ret_1h === null && r.received_ms <= nowMs - H) {
      const m = markNear(botDb, r.received_ms + H, LATER_GAP_MS);
      if (m !== null && r.mark > 0) { upd1.run(m.mark / r.mark - 1, r.item_id); did = true; }
    }
    if (r.ret_4h === null && r.received_ms <= nowMs - 4 * H) {
      const m = markNear(botDb, r.received_ms + 4 * H, LATER_GAP_MS);
      if (m !== null && r.mark > 0) { upd4.run(m.mark / r.mark - 1, r.item_id); did = true; }
    }
    if (did) changed += 1;
  }
  return changed;
}
```

- [ ] **Step 4: Run to see them pass; typecheck** — `npx vitest run test/perp/labAudit.test.ts test/perp/labMarks.test.ts && npx tsc --noEmit`. 

- [ ] **Step 5: Commit**

```bash
git add src/perp/lab/audit.ts src/perp/lab/marks.ts test/perp/labAudit.test.ts test/perp/labMarks.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(perp-lab): Sonnet audit of dropped items and the mark-move cross-check" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Statistics and the report generator

**Files:**
- Create: `src/perp/lab/stats.ts`, `src/perp/lab/report.ts`, `scripts/intake-lab-report.ts`
- Modify: `package.json` (script `intake-lab-report`)
- Test: `test/perp/labStats.test.ts`, `test/perp/labReport.test.ts`

**Interfaces:**
- Consumes: Tasks 1-4, `parseArgs` (`src/perp/ops/args.ts`).
- Produces:

```ts
// stats.ts
export function binomCdf(k: number, n: number, p: number): number;                       // P(X <= k)
export function clopperPearsonUpper(k: number, n: number, confidence?: number): number;  // one-sided; n<=0 or k>=n => 1
export interface StratumCount { volume: number; n: number; k: number }
export function stratifiedEstimate(strata: StratumCount[]): { rate: number | null; upper95: number | null; n: number; k: number };
// report.ts
export const BASELINE_SONNET_RATE = 0.31;   // share of gate calls that escalated before the prefilter, measured 2026-10-14
export function buildReport(labDb: Database.Database, botDb: Database.Database | null, nowMs: number): string;   // markdown
// scripts/intake-lab-report.ts:  npm run intake-lab-report -- --lab data/perp/lab.db [--bot data/perp/perp-paper.db] [--out data/perp/intake-lab-week1.md]
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/perp/labStats.test.ts
import { describe, it, expect } from 'vitest';
import { binomCdf, clopperPearsonUpper, stratifiedEstimate } from '../../src/perp/lab/stats.js';

describe('binomCdf', () => {
  it('matches known values', () => {
    expect(binomCdf(0, 10, 0.5)).toBeCloseTo(1 / 1024, 6);
    expect(binomCdf(10, 10, 0.3)).toBeCloseTo(1, 9);
    expect(binomCdf(1, 2, 0.5)).toBeCloseTo(0.75, 9);
  });
});

describe('clopperPearsonUpper', () => {
  it('k = 0 is about 3/n (the rule of three)', () => {
    expect(clopperPearsonUpper(0, 400)).toBeCloseTo(1 - Math.pow(0.05, 1 / 400), 5);
    expect(clopperPearsonUpper(0, 400)).toBeGreaterThan(0.0073);
    expect(clopperPearsonUpper(0, 400)).toBeLessThan(0.0076);
  });
  it('matches a known exact bound: 1 miss in 100', () => {
    expect(clopperPearsonUpper(1, 100)).toBeCloseTo(0.0466, 3);
  });
  it('edge cases: nothing audited or everything missed means no information', () => {
    expect(clopperPearsonUpper(0, 0)).toBe(1);
    expect(clopperPearsonUpper(5, 5)).toBe(1);
    expect(clopperPearsonUpper(7, 5)).toBe(1);
  });
  it('is monotone in k and shrinks with n', () => {
    expect(clopperPearsonUpper(2, 100)).toBeGreaterThan(clopperPearsonUpper(1, 100));
    expect(clopperPearsonUpper(0, 800)).toBeLessThan(clopperPearsonUpper(0, 400));
  });
});

describe('stratifiedEstimate', () => {
  it('weights each stratum by its volume and ignores strata with no audits or no volume', () => {
    const e = stratifiedEstimate([{ volume: 900, n: 100, k: 1 }, { volume: 100, n: 100, k: 0 }, { volume: 500, n: 0, k: 0 }, { volume: 0, n: 50, k: 5 }]);
    expect(e.n).toBe(200);
    expect(e.k).toBe(1);
    expect(e.rate).toBeCloseTo((900 * 0.01 + 100 * 0) / 1000, 9);
    expect(e.upper95!).toBeCloseTo(0.9 * clopperPearsonUpper(1, 100) + 0.1 * clopperPearsonUpper(0, 100), 9);
  });
  it('is null when nothing usable was audited', () => {
    expect(stratifiedEstimate([])).toEqual({ rate: null, upper95: null, n: 0, k: 0 });
    expect(stratifiedEstimate([{ volume: 10, n: 0, k: 0 }])).toEqual({ rate: null, upper95: null, n: 0, k: 0 });
  });
});
```

```ts
// test/perp/labReport.test.ts
import { describe, it, expect } from 'vitest';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';
import { ensureModelCallsTable } from '../../src/perp/model/callJson.js';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
import { buildReport } from '../../src/perp/lab/report.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0);
const row = (over: Partial<LabItemRow>): LabItemRow => ({
  item_id: 'x', received_ms: NOW - 2 * H, published_ms: null, source_id: 'axios_all', tier: 3, headline: 'A headline', snippet: null, commit_sha: 'abc1234', class: 'press',
  score: 1, hits: '[]', prod_pass: 0, prod_reason: 'low_score', dup_of: null, variants: '{"strict3":false,"loose1":false,"social_ok":false}', mark_at_ms: null, mark: null, ...over,
});

function fixture() {
  const lab = openLabDb(':memory:');
  const bot = openPerpDb(':memory:');
  ensureModelCallsTable(bot);
  insertItem(lab, row({ item_id: 'p1', prod_pass: 1, prod_reason: 'pass', score: 6, variants: '{"strict3":true,"loose1":true,"social_ok":true}' }));
  insertItem(lab, row({ item_id: 'p2', prod_pass: 1, prod_reason: 'pass', score: 4, variants: '{"strict3":true,"loose1":true,"social_ok":true}' }));
  for (let i = 0; i < 6; i++) insertItem(lab, row({ item_id: `s${i}`, source_id: 'bluesky_geopolitics', class: 'social', prod_reason: 'source_class_drop', score: i === 0 ? 5 : 0, variants: i === 0 ? '{"strict3":false,"loose1":false,"social_ok":true}' : '{"strict3":false,"loose1":false,"social_ok":false}' }));
  for (let i = 0; i < 4; i++) insertItem(lab, row({ item_id: `l${i}`, prod_reason: 'low_score', score: 2, variants: '{"strict3":false,"loose1":true,"social_ok":true}' }));
  insertItem(lab, row({ item_id: 'd0', prod_reason: 'duplicate', dup_of: 'p1', score: 6 }));
  const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, ?, ?, ?, ?, ?, ?, 1)");
  a.run('s0', NOW - H, 'social', 'boundary', 'moderate', 'down', 'Surprise Fed comment moves rates', 1);
  a.run('s1', NOW - H, 'social', 'random', 'minor', 'neutral', 'rant', 0);
  a.run('s2', NOW - H, 'social', 'random', 'minor', 'neutral', 'rant', 0);
  a.run('l0', NOW - H, 'low_score', 'random', 'minor', 'neutral', 'meh', 0);
  a.run('l1', NOW - H, 'low_score', 'boundary', 'minor', 'neutral', 'meh', 0);
  a.run('d0', NOW - H, 'duplicate', 'random', 'minor', 'neutral', 'repeat', 0);
  bot.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'gate', 'claude-haiku-5-5', 'g', 1, 1, 0.0001, 1)").run(NOW - 3 * H);
  bot.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'impact', 'claude-sonnet-5-5', 'i', 1, 1, 0.004, 1)").run(NOW - 3 * H);
  recordMark(bot, NOW - 2 * H, 100);
  return { lab, bot };
}

describe('buildReport', () => {
  it('states the funnel, the per-stratum audit results, the misses and the bound', () => {
    const { lab, bot } = fixture();
    const md = buildReport(lab, bot, NOW);
    expect(md).toContain('# Intake lab report');
    expect(md).toMatch(/Items logged: 13\b/);
    expect(md).toMatch(/Passed the prefilter \(to Haiku\): 2\b/);
    expect(md).toMatch(/social\s*\|\s*6\s*\|\s*2\s*\|\s*0\b/);                 // stratum | volume | random audited | random misses
    expect(md).toMatch(/low_score\s*\|\s*4\s*\|\s*1\s*\|\s*0\b/);
    expect(md).toContain('95% upper bound');
    expect(md).toContain('Surprise Fed comment moves rates');                 // the one miss, with its headline context
    expect(md).toMatch(/Boundary samples[\s\S]*1 miss/i);
  });
  it('compares the rule variants: what each would add and which misses it would have caught', () => {
    const { lab, bot } = fixture();
    const md = buildReport(lab, bot, NOW);
    expect(md).toMatch(/loose1\s*\|\s*6\b/);        // 2 passed + 4 low-score pass under loose1
    expect(md).toMatch(/social_ok\s*\|\s*7\b/);     // 2 + 1 social post + 4 low-score
    expect(md).toMatch(/social_ok[^\n]*\|\s*1\s*\|?/); // it would have caught the single audited miss
  });
  it('estimates the saving from the bot actual per-call costs', () => {
    const { lab, bot } = fixture();
    const md = buildReport(lab, bot, NOW);
    expect(md).toMatch(/Estimated model spend avoided: \$[0-9.]+/);
  });
  it('recommends keeping the filter when there are too few audits, and says so plainly', () => {
    const { lab, bot } = fixture();
    expect(buildReport(lab, bot, NOW)).toMatch(/Not enough audited items/i);
  });
  it('recommends keeping the production filter when many random audits found no miss', () => {
    const lab = openLabDb(':memory:');
    for (let i = 0; i < 150; i++) insertItem(lab, row({ item_id: `n${i}`, class: 'social', prod_reason: 'source_class_drop', source_id: 'bluesky_geopolitics' }));
    const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, 'social', 'random', 'minor', 'neutral', 'x', 0, 1)");
    for (let i = 0; i < 150; i++) a.run(`n${i}`, NOW - H);
    const md = buildReport(lab, null, NOW);
    expect(md).toMatch(/Keep the production filter/i);
  });
  it('works without a bot database and with an empty lab', () => {
    expect(() => buildReport(openLabDb(':memory:'), null, NOW)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run test/perp/labStats.test.ts test/perp/labReport.test.ts`.

- [ ] **Step 3: Implement `src/perp/lab/stats.ts`**

```ts
// src/perp/lab/stats.ts
//
// The numbers the tile and the report show: an exact one-sided upper bound on a miss rate, and a volume-weighted stratified estimate.

/** P(X <= k) for X ~ Binomial(n, p), by the pmf recurrence (n is a few thousand at most). */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let pmf = Math.pow(1 - p, n);
  let cdf = pmf;
  for (let i = 0; i < k; i++) {
    pmf *= ((n - i) / (i + 1)) * (p / (1 - p));
    cdf += pmf;
  }
  return Math.min(1, cdf);
}

/** Clopper-Pearson one-sided upper confidence bound for a proportion k/n (default 95%). No information (n <= 0 or k >= n) is 1. */
export function clopperPearsonUpper(k: number, n: number, confidence = 0.95): number {
  if (!(n > 0) || k >= n) return 1;
  const alpha = 1 - confidence;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface StratumCount { volume: number; n: number; k: number }

/** Volume-weighted miss rate over strata that have both volume and audits; the bound is the weighted sum of the per-stratum bounds (conservative). */
export function stratifiedEstimate(strata: StratumCount[]): { rate: number | null; upper95: number | null; n: number; k: number } {
  const usable = strata.filter((s) => s.n > 0 && s.volume > 0);
  if (usable.length === 0) return { rate: null, upper95: null, n: 0, k: 0 };
  const total = usable.reduce((t, s) => t + s.volume, 0);
  let rate = 0;
  let upper = 0;
  for (const s of usable) {
    const w = s.volume / total;
    rate += w * (s.k / s.n);
    upper += w * clopperPearsonUpper(s.k, s.n);
  }
  return { rate, upper95: upper, n: usable.reduce((t, s) => t + s.n, 0), k: usable.reduce((t, s) => t + s.k, 0) };
}
```

- [ ] **Step 4: Implement `src/perp/lab/report.ts`**

```ts
// src/perp/lab/report.ts
//
// The end-of-week report (spec section 6). Pure over the lab database (and, read-only, the bot's); returns markdown.
import type Database from 'better-sqlite3';
import { STRATA, type Stratum } from './sampler.js';
import { sigma4h, movedFlag } from './marks.js';
import { clopperPearsonUpper, stratifiedEstimate, type StratumCount } from './stats.js';

/** Share of gate calls that escalated to Sonnet before the prefilter existed (measured 2026-10-14 from the bot ledger). */
export const BASELINE_SONNET_RATE = 0.31;
const MIN_AUDITS_FOR_VERDICT = 100;
const pct = (x: number | null, d = 2): string => (x === null ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const one = <T>(db: Database.Database, sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
const all = <T>(db: Database.Database, sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

export function buildReport(labDb: Database.Database, botDb: Database.Database | null, nowMs: number): string {
  const L: string[] = [];
  const items = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items').n;
  const passed = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items WHERE prod_pass = 1').n;
  const range = one<{ a: number | null; b: number | null }>(labDb, 'SELECT MIN(received_ms) AS a, MAX(received_ms) AS b FROM items');
  L.push('# Intake lab report', '');
  L.push(`Generated ${new Date(nowMs).toISOString()}. Items logged: ${items}. Window: ${range.a === null ? 'n/a' : new Date(range.a).toISOString()} to ${range.b === null ? 'n/a' : new Date(range.b).toISOString()}.`, '');

  L.push('## Funnel', '');
  L.push(`- Items logged: ${items}`);
  L.push(`- Passed the prefilter (to Haiku): ${passed} (${items === 0 ? 'n/a' : pct(passed / items, 1)})`);
  L.push('', '| Drop reason | Items |', '|---|---|');
  for (const r of all<{ prod_reason: string; n: number }>(labDb, 'SELECT prod_reason, COUNT(*) AS n FROM items GROUP BY prod_reason ORDER BY n DESC')) L.push(`| ${r.prod_reason} | ${r.n} |`);
  L.push('', '| Source | Items | Passed |', '|---|---|---|');
  for (const r of all<{ source_id: string; n: number; p: number }>(labDb, 'SELECT source_id, COUNT(*) AS n, SUM(prod_pass) AS p FROM items GROUP BY source_id ORDER BY n DESC LIMIT 20')) L.push(`| ${r.source_id} | ${r.n} | ${r.p} |`);

  L.push('', '## Audit: did the filter drop anything that mattered?', '');
  L.push('A miss is an audited dropped item that Sonnet rates moderate, major or shock. Random samples are unbiased; boundary samples target the likeliest misses and are reported separately.', '');
  L.push('| Stratum | Volume dropped | Random audited | Random misses | 95% upper bound |', '|---|---|---|---|---|');
  const counts: StratumCount[] = [];
  for (const s of STRATA) {
    const volume = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items WHERE prod_pass = 0 AND prod_reason = ?', stratumReason(s)).n;
    const a = one<{ n: number; k: number | null }>(labDb, "SELECT COUNT(*) AS n, SUM(miss) AS k FROM audits WHERE kind = 'random' AND ok = 1 AND stratum = ?", s);
    const k = a.k ?? 0;
    counts.push({ volume, n: a.n, k });
    L.push(`| ${s} | ${volume} | ${a.n} | ${k} | ${a.n === 0 ? 'n/a' : pct(clopperPearsonUpper(k, a.n))} |`);
  }
  const est = stratifiedEstimate(counts);
  L.push('', `Overall random estimate: ${est.n} audited, ${est.k} miss${est.k === 1 ? '' : 'es'}, rate ${pct(est.rate)}, 95% upper bound ${pct(est.upper95)} (volume-weighted; the bound is the weighted sum of per-stratum bounds, so it is conservative).`);
  const bd = one<{ n: number; k: number | null }>(labDb, "SELECT COUNT(*) AS n, SUM(miss) AS k FROM audits WHERE kind = 'boundary' AND ok = 1");
  L.push('', `Boundary samples (not part of the estimate): ${bd.n} audited, ${bd.k ?? 0} miss${(bd.k ?? 0) === 1 ? '' : 'es'}.`);
  const failed = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM audits WHERE ok = 0').n;
  if (failed > 0) L.push(`${failed} audit call(s) failed and were not retried.`);

  L.push('', '## Every miss', '');
  const misses = all<{ item_id: string; source_id: string; headline: string; stratum: string; kind: string; bucket: string; direction: string; rationale: string }>(
    labDb, 'SELECT i.item_id, i.source_id, i.headline, a.stratum, a.kind, a.bucket, a.direction, a.rationale FROM audits a JOIN items i ON i.item_id = a.item_id WHERE a.miss = 1 ORDER BY a.at_ms'
  );
  if (misses.length === 0) L.push('None.');
  for (const m of misses) L.push(`- [${m.kind}/${m.stratum}] ${m.source_id}: ${m.headline.slice(0, 160)} -> ${m.bucket} ${m.direction}. ${m.rationale.slice(0, 200)}`);

  L.push('', '## Dropped items followed by an unusually large move (second signal)', '');
  const sigma = botDb === null ? null : sigma4h(botDb, nowMs);
  if (sigma === null) L.push('Not enough price history to estimate the 4 h volatility.');
  else {
    const moved = all<{ source_id: string; headline: string; prod_reason: string; ret_4h: number }>(labDb, 'SELECT source_id, headline, prod_reason, ret_4h FROM items WHERE prod_pass = 0 AND ret_4h IS NOT NULL ORDER BY received_ms')
      .filter((r) => movedFlag(r.ret_4h, sigma));
    L.push(`Flagged when |4 h return| >= 2 x sigma (sigma = ${pct(sigma)}). Supporting evidence only: other news also moves the price. ${moved.length} flagged.`);
    for (const r of moved.slice(0, 30)) L.push(`- ${r.source_id} (${r.prod_reason}): ${r.headline.slice(0, 140)}  ret_4h ${pct(r.ret_4h)}`);
  }

  L.push('', '## Rule variants', '', '| Variant | Would pass | Extra vs production | Audited extras | Misses it would have caught |', '|---|---|---|---|---|');
  for (const v of ['strict3', 'loose1', 'social_ok']) {
    const would = one<{ n: number }>(labDb, `SELECT COUNT(*) AS n FROM items WHERE json_extract(variants, '$.${v}') = 1`).n;
    const extra = one<{ n: number }>(labDb, `SELECT COUNT(*) AS n FROM items WHERE json_extract(variants, '$.${v}') = 1 AND prod_pass = 0`).n;
    const ex = one<{ n: number; k: number | null }>(labDb, `SELECT COUNT(*) AS n, SUM(a.miss) AS k FROM items i JOIN audits a ON a.item_id = i.item_id WHERE json_extract(i.variants, '$.${v}') = 1 AND i.prod_pass = 0 AND a.ok = 1`);
    L.push(`| ${v} | ${would} | ${extra} | ${ex.n} | ${ex.k ?? 0} |`);
  }

  L.push('', '## Cost', '');
  if (botDb === null) L.push('No bot ledger supplied: spend estimate unavailable.');
  else try {
    const avg = (stage: string): number | null => one<{ a: number | null }>(botDb, 'SELECT AVG(cost_usd) AS a FROM model_calls WHERE stage = ? AND ok = 1', stage).a;
    const g = avg('gate');
    const s = avg('impact');
    const sonnetCalls = all<{ payload: string }>(botDb, "SELECT payload FROM journal WHERE kind = 'intake_outcome'").filter((r) => JSON.parse(r.payload).escalated === true).length;
    if (g === null || s === null) L.push('The bot ledger has no gate/impact cost rows yet: spend estimate unavailable.');
    else {
      const saved = (items - passed) * g + Math.max(0, items * BASELINE_SONNET_RATE - sonnetCalls) * s;
      L.push(`Estimated model spend avoided: $${saved.toFixed(2)} (unfiltered Haiku reads ${items} vs ${passed}; Sonnet calls at the pre-prefilter rate ${(BASELINE_SONNET_RATE * 100).toFixed(0)}% vs ${sonnetCalls}; average cost per gate call $${g.toFixed(5)}, per impact call $${s.toFixed(5)}).`);
    }
  } catch {
    L.push('The bot ledger could not be read for costs: spend estimate unavailable.');
  }
  const labSpend = one<{ s: number | null }>(labDb, 'SELECT SUM(cost_usd) AS s FROM model_calls').s ?? 0;
  L.push(`Lab audit spend: $${labSpend.toFixed(2)}.`);

  L.push('', '## Recommendation', '');
  if (est.n < MIN_AUDITS_FOR_VERDICT) L.push(`Not enough audited items (${est.n} random audits; ${MIN_AUDITS_FOR_VERDICT} needed) for a verdict: keep the production filter and keep collecting.`);
  else if (est.k === 0) L.push(`Keep the production filter. No miss in ${est.n} random audits; the 95% upper bound on the miss rate is ${pct(est.upper95)}. Consider loosening only if the bot is starved of news it should read.`);
  else {
    const where = counts.map((c, i) => ({ s: STRATA[i], c })).filter((x) => x.c.k > 0).map((x) => `${x.s} (${x.c.k}/${x.c.n})`).join(', ');
    L.push(`Review the ${est.k} miss${est.k === 1 ? '' : 'es'} above before changing anything. Misses came from: ${where}. If they share a pattern, add it to the lexicon; if they are social posts, consider allow-listing that account class (variant social_ok shows the cost).`);
  }
  L.push('');
  return L.join('\n');
}

function stratumReason(s: Stratum): string {
  return s === 'social' ? 'source_class_drop' : s;
}
```

- [ ] **Step 5: Implement the script and wire npm**

```ts
// scripts/intake-lab-report.ts
// Regenerates the intake-lab report from the preserved databases (read-only on both).
// Usage: npm run intake-lab-report -- --lab data/perp/lab.db [--bot data/perp/perp-paper.db] [--out data/perp/intake-lab-week1.md]
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { buildReport } from '../src/perp/lab/report.js';
import { parseArgs } from '../src/perp/ops/args.js';

const USAGE = 'usage: intake-lab-report --lab <lab.db> [--bot <perp-paper.db>] [--out <file.md>]';
const args = parseArgs(process.argv.slice(2), { values: ['lab', 'bot', 'out'] });
if (!args.ok || args.values.lab === undefined) {
  if (!args.ok) console.error(args.error);
  console.error(USAGE);
  process.exit(2);
}
const lab = new Database(args.values.lab, { readonly: true, fileMustExist: true });
const bot = args.values.bot === undefined ? null : new Database(args.values.bot, { readonly: true, fileMustExist: true });
const md = buildReport(lab, bot, Date.now());
if (args.values.out === undefined) console.log(md);
else {
  fs.writeFileSync(args.values.out, md);
  console.log(`wrote ${args.values.out}`);
}
```

Add to `package.json` scripts: `"intake-lab-report": "tsx scripts/intake-lab-report.ts",`.

- [ ] **Step 6: Run to see the tests pass; typecheck** — `npx vitest run test/perp/labStats.test.ts test/perp/labReport.test.ts && npx tsc --noEmit`. If a regex in the report tests does not match the table cell format you produced, adjust the **code's** table cell text only if the test states the spec's meaning; otherwise report the mismatch, never loosen a test to pass.

- [ ] **Step 7: Commit**

```bash
git add src/perp/lab/stats.ts src/perp/lab/report.ts scripts/intake-lab-report.ts package.json test/perp/labStats.test.ts test/perp/labReport.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(perp-lab): Clopper-Pearson bounds, stratified estimate and the end-of-week report" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The lab service (logic, lifecycle, startup rules)

**Files:**
- Create: `src/perp/lab/service.ts`, `src/perp/lab/startup.ts`
- Test: `test/perp/labService.test.ts`, `test/perp/labStartup.test.ts`

**Interfaces:**
- Consumes: Tasks 1-5, `hygieneSkip` (Plan A), `parseItemFields`, `checkSilence`, `modelSpendTodayUsd`, `StreamEntry`.
- Produces:

```ts
// startup.ts
export interface LabConfig { capUsd: number; days: number; seed: number; dataDir: string; botDbPath: string; prefilterFile: string }
export function assertPaperOnly(env: NodeJS.ProcessEnv): void;                 // throws unless PERP_MODE === 'paper' and PERP_LIVE unset
export function resolveLabConfig(env: NodeJS.ProcessEnv, repoRoot: string): LabConfig;
// service.ts
export type EntryResult = 'logged' | 'duplicate' | 'skipped' | 'parse_error' | 'error';
export interface LabServiceDeps {
  labDb: Database.Database; botDb: Database.Database | null; evaluator: Evaluator; cfg: PrefilterConfig; now: () => number; commit: string;
  capUsd: number; days: number; rng: () => number;
  audit: (row: AuditRow, stratum: Stratum, kind: AuditKind) => Promise<AuditOutcome>;
  alert: (message: string) => void | Promise<void>;
  writeReport: (markdown: string) => void;
}
export class LabService {
  constructor(deps: LabServiceDeps);
  readonly counters: Record<string, number>;
  get lastEntryAtMs(): number | null;
  handleEntry(entry: StreamEntry): Promise<EntryResult>;
  auditActive(): boolean;
  auditTick(): Promise<'inactive' | 'paced' | 'idle' | 'busy' | AuditOutcome>;
  fillMarks(): number;
  recordHeartbeat(): void;
  silenceTick(): Promise<void>;
  maybeReport(): Promise<boolean>;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/perp/labStartup.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { assertPaperOnly, resolveLabConfig } from '../../src/perp/lab/startup.js';

const env = (o: Record<string, string | undefined> = {}) => ({ PERP_MODE: 'paper', ...o }) as NodeJS.ProcessEnv;

describe('assertPaperOnly', () => {
  it('accepts a pinned paper process', () => {
    expect(() => assertPaperOnly(env())).not.toThrow();
  });
  it('refuses anything else', () => {
    expect(() => assertPaperOnly({} as NodeJS.ProcessEnv)).toThrow(/PERP_MODE/);
    expect(() => assertPaperOnly(env({ PERP_MODE: 'live' }))).toThrow(/PERP_MODE/);
    expect(() => assertPaperOnly(env({ PERP_MODE: 'demo' }))).toThrow(/PERP_MODE/);
    expect(() => assertPaperOnly(env({ PERP_LIVE: 'KXUS500PERP:3' }))).toThrow(/PERP_LIVE/);
  });
});

describe('resolveLabConfig', () => {
  it('defaults: $0.50/day, 7 days, paths under the repo data dir', () => {
    const c = resolveLabConfig(env(), '/repo');
    expect(c).toMatchObject({ capUsd: 0.5, days: 7 });
    expect(c.dataDir).toBe(path.join('/repo', 'data', 'perp'));
    expect(c.botDbPath).toBe(path.join('/repo', 'data', 'perp', 'perp-paper.db'));
    expect(c.prefilterFile).toBe(path.join('/repo', 'config', 'perp-prefilter.json'));
    expect(Number.isInteger(c.seed)).toBe(true);
  });
  it('reads overrides and rejects nonsense', () => {
    expect(resolveLabConfig(env({ LAB_DAILY_USD_CAP: '0.25', LAB_DAYS: '3', LAB_SEED: '42' }), '/r')).toMatchObject({ capUsd: 0.25, days: 3, seed: 42 });
    expect(() => resolveLabConfig(env({ LAB_DAILY_USD_CAP: '0' }), '/r')).toThrow(/LAB_DAILY_USD_CAP/);
    expect(() => resolveLabConfig(env({ LAB_DAILY_USD_CAP: '5' }), '/r')).toThrow(/LAB_DAILY_USD_CAP/); // the lab's audit budget is small by design
    expect(() => resolveLabConfig(env({ LAB_DAYS: '0' }), '/r')).toThrow(/LAB_DAYS/);
    expect(() => resolveLabConfig(env({ LAB_SEED: 'x' }), '/r')).toThrow(/LAB_SEED/);
  });
});
```

```ts
// test/perp/labService.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { loadPrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { makeEvaluator } from '../../src/perp/lab/features.js';
import { firstItemMs, getMeta, openLabDb } from '../../src/perp/lab/labDb.js';
import { makeRng } from '../../src/perp/lab/sampler.js';
import { LabService, type LabServiceDeps } from '../../src/perp/lab/service.js';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0); // UTC hour 12: allowance = cap/24 x 14
let n = 0;
const item = (source_id: string, headline: string, over: Partial<Item> = {}): Item => ({
  item_id: `s${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline, snippet: null,
  url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0, provenance_gaps: [], amends_item_id: null, amendment_kind: null, ...over,
});
const entry = (it: Item) => ({ id: `${n}-0`, fields: { json: JSON.stringify(it) } });

function mk(over: Partial<LabServiceDeps> = {}, clock = { t: NOW }) {
  const labDb = openLabDb(':memory:');
  const botDb = openPerpDb(':memory:');
  recordMark(botDb, NOW - 30_000, 13.5);
  const cfg = loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));
  const alerts: string[] = []; const audits: string[] = []; const reports: string[] = [];
  const svc = new LabService({
    labDb, botDb, evaluator: makeEvaluator(cfg), cfg, now: () => clock.t, commit: 'abc1234', capUsd: 0.5, days: 7, rng: makeRng(1),
    audit: async (row) => { audits.push(row.item_id); return 'audited'; },
    alert: (m) => { alerts.push(m); }, writeReport: (md) => { reports.push(md); }, ...over,
  });
  return { svc, labDb, botDb, alerts, audits, reports, clock };
}
const items = (db: ReturnType<typeof openLabDb>) => db.prepare('select item_id, prod_pass, prod_reason, class, mark from items order by received_ms, item_id').all() as Array<Record<string, unknown>>;

describe('handleEntry', () => {
  it('logs a passing item with the production verdict, lexicon features and the mark at ingest', async () => {
    const { svc, labDb } = mk();
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')))).toBe('logged');
    expect(items(labDb)[0]).toMatchObject({ prod_pass: 1, prod_reason: 'pass', class: 'press', mark: 13.5 });
  });
  it('logs a dropped social post with its drop reason', async () => {
    const { svc, labDb } = mk();
    await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    expect(items(labDb)[0]).toMatchObject({ prod_pass: 0, prod_reason: 'source_class_drop', class: 'social' });
  });
  it('applies the shared hygiene: replays and stale items are skipped and not logged', async () => {
    const { svc, labDb } = mk();
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation', { replay: true })))).toBe('skipped');
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation', { source_publish_ts: new Date(NOW - 7 * H).toISOString() })))).toBe('skipped');
    expect(items(labDb)).toHaveLength(0);
  });
  it('an unparseable entry is a parse_error and never throws', async () => {
    const { svc } = mk();
    expect(await svc.handleEntry({ id: '1-0', fields: {} })).toBe('parse_error');
    expect(await svc.handleEntry({ id: '1-1', fields: { json: '{nope' } })).toBe('parse_error');
  });
  it('a redelivered entry neither double-logs nor changes the dedup state a second time', async () => {
    const { svc, labDb } = mk();
    const first = item('axios_all', 'Inflation heats up as gas prices surge');
    expect(await svc.handleEntry(entry(first))).toBe('logged');
    expect(await svc.handleEntry(entry(first))).toBe('duplicate');
    // had the redelivery re-run the prefilter it would now look like a duplicate of itself; a later fresh item must still see only ONE earlier pass
    expect(items(labDb)).toHaveLength(1);
    await svc.handleEntry(entry(item('thehill_news', 'Inflation heats up as gas prices surge again')));
    expect(items(labDb)[1]).toMatchObject({ prod_reason: 'duplicate' });
  });
  it('works with no bot database: features are still logged, the mark is null', async () => {
    const { svc, labDb } = mk({ botDb: null });
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')))).toBe('logged');
    expect(items(labDb)[0].mark).toBeNull();
  });
  it('a bot database that throws on read degrades to a null mark instead of failing the entry', async () => {
    const { svc, labDb, botDb } = mk();
    botDb.close();
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')))).toBe('logged');
    expect(items(labDb)[0].mark).toBeNull();
  });
  it('tracks when the last entry arrived, even for an unparseable one', async () => {
    const { svc } = mk();
    expect(svc.lastEntryAtMs).toBeNull();
    await svc.handleEntry({ id: '1-0', fields: {} });
    expect(svc.lastEntryAtMs).toBe(NOW);
  });
});

describe('auditTick', () => {
  const dropped = async (svc: LabService) => { await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall'))); };
  it('audits one candidate per tick through the injected audit function', async () => {
    const { svc, audits } = mk();
    await dropped(svc);
    expect(await svc.auditTick()).toBe('audited');
    expect(audits).toHaveLength(1);
  });
  it('is idle when there is nothing to audit', async () => {
    const { svc } = mk();
    expect(await svc.auditTick()).toBe('idle');
  });
  it('is paced: once the day allowance is spent it does not audit', async () => {
    const { svc, labDb, audits } = mk();
    await dropped(svc);
    labDb.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'impact', 'm', 'z', 1, 1, 0.3, 1)").run(NOW - 1000);
    expect(await svc.auditTick()).toBe('paced');
    expect(audits).toHaveLength(0);
  });
  it('two overlapping ticks never pay for the same item twice (re-entrancy guard)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const audits: string[] = [];
    const { svc } = mk({ audit: async (row) => { audits.push(row.item_id); await gate; return 'audited'; } });
    await dropped(svc);
    const a = svc.auditTick();
    const b = svc.auditTick();
    release();
    expect([await a, await b].sort()).toEqual(['audited', 'busy']);
    expect(audits).toHaveLength(1);
  });
  it('after the audit window (day 7) it is inactive and spends nothing, but logging continues', async () => {
    const clock = { t: NOW };
    const { svc, audits, labDb } = mk({}, clock);
    await dropped(svc);
    clock.t = NOW + 7 * 24 * H + 1;
    expect(svc.auditActive()).toBe(false);
    expect(await svc.auditTick()).toBe('inactive');
    expect(audits).toHaveLength(0);
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge', {
      source_publish_ts: new Date(clock.t - 60_000).toISOString(), first_seen_ts: new Date(clock.t - 50_000).toISOString() })))).toBe('logged');
    expect(items(labDb).length).toBe(2);
  });
  it('the window boundary is exact: still active one millisecond before 7 days, inactive at 7 days', async () => {
    const clock = { t: NOW };
    const { svc } = mk({}, clock);
    await dropped(svc);
    clock.t = NOW + 7 * 24 * H - 1;
    expect(svc.auditActive()).toBe(true);
    clock.t = NOW + 7 * 24 * H;
    expect(svc.auditActive()).toBe(false);
  });
});

describe('maybeReport / heartbeat / silence / marks', () => {
  it('writes the report and alerts exactly once, only after the window closes', async () => {
    const clock = { t: NOW };
    const { svc, reports, alerts, labDb } = mk({}, clock);
    await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    expect(await svc.maybeReport()).toBe(false);
    clock.t = NOW + 7 * 24 * H;
    expect(await svc.maybeReport()).toBe(true);
    expect(await svc.maybeReport()).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('# Intake lab report');
    expect(alerts.filter((a) => a.startsWith('[PERP-LAB]'))).toHaveLength(1);
    expect(getMeta(labDb, 'report_done')).not.toBeNull();
  });
  it('records a heartbeat with stream, bot db and marks health', async () => {
    const { svc, labDb } = mk();
    await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')));
    svc.recordHeartbeat();
    expect(labDb.prepare('select stream_ok, bot_db_ok, marks_fresh from heartbeat').get()).toEqual({ stream_ok: 1, bot_db_ok: 1, marks_fresh: 1 });
  });
  it('heartbeat reports an unreadable bot db as 0 without throwing', () => {
    const { svc, labDb, botDb } = mk();
    botDb.close();
    expect(() => svc.recordHeartbeat()).not.toThrow();
    expect(labDb.prepare('select bot_db_ok, marks_fresh from heartbeat').get()).toEqual({ bot_db_ok: 0, marks_fresh: 0 });
  });
  it('alerts once when the stream has been silent for more than 30 minutes, and re-arms after an entry', async () => {
    const clock = { t: NOW };
    const { svc, alerts } = mk({}, clock);
    await svc.silenceTick();
    expect(alerts).toHaveLength(0);
    clock.t = NOW + 31 * 60_000;
    await svc.silenceTick();
    await svc.silenceTick();
    expect(alerts.filter((a) => /no IIP items/i.test(a))).toHaveLength(1);
  });
  it('fillMarks returns 0 with no bot db and never throws', () => {
    const { svc } = mk({ botDb: null });
    expect(svc.fillMarks()).toBe(0);
  });
  it('firstItemMs reflects the first logged item (the 7-day clock)', async () => {
    const { svc, labDb } = mk();
    expect(firstItemMs(labDb)).toBeNull();
    await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')));
    expect(firstItemMs(labDb)).toBe(NOW);
  });
});
```

- [ ] **Step 2: Run to see them fail** — `npx vitest run test/perp/labStartup.test.ts test/perp/labService.test.ts`.

- [ ] **Step 3: Implement `src/perp/lab/startup.ts`**

```ts
// src/perp/lab/startup.ts
import path from 'node:path';

export interface LabConfig { capUsd: number; days: number; seed: number; dataDir: string; botDbPath: string; prefilterFile: string }

/** The lab is paper-only by construction: it must be started with PERP_MODE=paper pinned and no PERP_LIVE (the unit pins both). */
export function assertPaperOnly(env: NodeJS.ProcessEnv): void {
  if (env.PERP_MODE !== 'paper') throw new Error(`the intake lab runs only with PERP_MODE=paper (got ${JSON.stringify(env.PERP_MODE)})`);
  if (env.PERP_LIVE !== undefined) throw new Error('the intake lab refuses to start with PERP_LIVE set');
}

export function resolveLabConfig(env: NodeJS.ProcessEnv, repoRoot: string): LabConfig {
  const num = (name: string, fallback: number, ok: (n: number) => boolean, rule: string): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name} must be ${rule}, got ${JSON.stringify(raw)}`);
    return n;
  };
  const dataDir = env.LAB_DATA_DIR ?? path.join(repoRoot, 'data', 'perp');
  return {
    capUsd: num('LAB_DAILY_USD_CAP', 0.5, (n) => n > 0 && n <= 2, 'a number of dollars above 0 and at most 2 (the audit budget is small by design)'),
    days: num('LAB_DAYS', 7, (n) => Number.isInteger(n) && n >= 1 && n <= 30, 'a whole number of days from 1 to 30'),
    seed: num('LAB_SEED', 20261014, (n) => Number.isInteger(n) && n >= 0, 'a non-negative integer'),
    dataDir,
    botDbPath: env.LAB_BOT_DB ?? path.join(dataDir, 'perp-paper.db'),
    prefilterFile: env.PERP_PREFILTER_FILE ?? path.join(repoRoot, 'config', 'perp-prefilter.json'),
  };
}
```

- [ ] **Step 4: Implement `src/perp/lab/service.ts`**

```ts
// src/perp/lab/service.ts
//
// All the lab's logic behind injected dependencies (clock, audit, alerts, report writer) so it is testable without Redis or a model.
import type Database from 'better-sqlite3';
import { parseItemFields } from '../../item.js';
import type { StreamEntry } from '../../redis/consumer.js';
import { hygieneSkip } from '../intake/hygiene.js';
import { checkSilence } from '../intake/silence.js';
import type { PrefilterConfig } from '../intake/prefilter.js';
import { modelSpendTodayUsd } from '../model/callJson.js';
import type { AuditOutcome, AuditRow } from './audit.js';
import { evaluate, toItemRow, type Evaluator } from './features.js';
import { firstItemMs, getMeta, hasItem, insertItem, setMeta } from './labDb.js';
import { fillReturns, markAtIngest } from './marks.js';
import { buildReport } from './report.js';
import { CANDIDATE_WINDOW_MS, canSpendNow, chooseCandidate, listCandidates, randomAuditCounts, type AuditKind, type Stratum } from './sampler.js';

export type EntryResult = 'logged' | 'duplicate' | 'skipped' | 'parse_error' | 'error';
const DAY_MS = 86_400_000;

export interface LabServiceDeps {
  labDb: Database.Database;
  botDb: Database.Database | null;
  evaluator: Evaluator;
  cfg: PrefilterConfig;
  now: () => number;
  commit: string;
  capUsd: number;
  days: number;
  rng: () => number;
  audit: (row: AuditRow, stratum: Stratum, kind: AuditKind) => Promise<AuditOutcome>;
  alert: (message: string) => void | Promise<void>;
  writeReport: (markdown: string) => void;
}

export class LabService {
  readonly counters: Record<string, number> = { logged: 0, duplicate: 0, skipped: 0, parse_error: 0, error: 0 };
  private lastEntryAt: number | null = null;
  private readonly startedAt: number;
  private silence = { alerted: false };
  private auditing = false;

  constructor(private readonly d: LabServiceDeps) {
    this.startedAt = d.now();
  }

  get lastEntryAtMs(): number | null {
    return this.lastEntryAt;
  }

  private count(r: EntryResult): EntryResult {
    this.counters[r] += 1;
    return r;
  }

  async handleEntry(entry: StreamEntry): Promise<EntryResult> {
    try {
      const now = this.d.now();
      this.lastEntryAt = now;
      const parsed = parseItemFields(entry.fields);
      if (!parsed.ok) return this.count('parse_error');
      const item = parsed.item;
      if (hygieneSkip(item, now) !== null) return this.count('skipped');
      // A redelivered entry must not re-run the prefilter: its dedup/cap state has already seen this item.
      if (hasItem(this.d.labDb, item.item_id)) return this.count('duplicate');
      const evaluation = evaluate(this.d.evaluator, item, now);
      let mark: { tsMs: number; mark: number } | null = null;
      if (this.d.botDb !== null) {
        try { mark = markAtIngest(this.d.botDb, now); } catch { mark = null; } // an unreadable bot ledger must not stop feature logging
      }
      return this.count(insertItem(this.d.labDb, toItemRow(item, evaluation, now, this.d.commit, mark)) ? 'logged' : 'duplicate');
    } catch (err) {
      console.error('[perp-lab] entry failed:', err instanceof Error ? err.message : String(err));
      return this.count('error');
    }
  }

  /** True until `days` days after the first logged item. */
  auditActive(): boolean {
    const first = firstItemMs(this.d.labDb);
    return first === null || this.d.now() - first < this.d.days * DAY_MS;
  }

  async auditTick(): Promise<'inactive' | 'paced' | 'idle' | 'busy' | AuditOutcome> {
    if (this.auditing) return 'busy';
    this.auditing = true;
    try {
      const now = this.d.now();
      if (!this.auditActive()) return 'inactive';
      if (!canSpendNow(this.d.capUsd, modelSpendTodayUsd(this.d.labDb, now), now)) return 'paced';
      const pick = chooseCandidate(listCandidates(this.d.labDb, now - CANDIDATE_WINDOW_MS, this.d.cfg.threshold), randomAuditCounts(this.d.labDb), this.d.rng);
      if (pick === null) return 'idle';
      const row = this.d.labDb
        .prepare('SELECT item_id, received_ms, published_ms, source_id, tier, headline, snippet FROM items WHERE item_id = ?')
        .get(pick.candidate.itemId) as AuditRow;
      return await this.d.audit(row, pick.candidate.stratum, pick.kind);
    } finally {
      this.auditing = false;
    }
  }

  fillMarks(): number {
    if (this.d.botDb === null) return 0;
    try { return fillReturns(this.d.labDb, this.d.botDb, this.d.now()); } catch { return 0; }
  }

  recordHeartbeat(): void {
    const now = this.d.now();
    let botOk = 0;
    let marksFresh = 0;
    if (this.d.botDb !== null) {
      try {
        const r = this.d.botDb.prepare('SELECT MAX(ts_ms) AS m FROM marks').get() as { m: number | null };
        botOk = 1;
        marksFresh = r.m !== null && now - r.m < 120_000 ? 1 : 0;
      } catch { botOk = 0; marksFresh = 0; }
    }
    const last = this.d.labDb.prepare('SELECT MAX(received_ms) AS m FROM items').get() as { m: number | null };
    const streamOk = this.lastEntryAt !== null && now - this.lastEntryAt < 30 * 60_000 ? 1 : 0;
    this.d.labDb.prepare('INSERT OR REPLACE INTO heartbeat (ts_ms, last_item_ms, stream_ok, bot_db_ok, marks_fresh) VALUES (?, ?, ?, ?, ?)').run(now, last.m, streamOk, botOk, marksFresh);
  }

  async silenceTick(): Promise<void> {
    const q = checkSilence(this.silence, this.d.now(), this.lastEntryAt, this.startedAt);
    this.silence = q.state;
    if (q.alert) {
      try {
        await this.d.alert(`[PERP-LAB] no IIP items for ${Math.round(q.silentForMs / 60_000)} minutes: the lab is not seeing the news stream`);
      } catch (err) {
        console.error('[perp-lab] alert failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Once the audit window has closed: build and write the report, alert, and remember it was done. */
  async maybeReport(): Promise<boolean> {
    if (this.auditActive() || getMeta(this.d.labDb, 'report_done') !== null) return false;
    const md = buildReport(this.d.labDb, this.d.botDb, this.d.now());
    this.d.writeReport(md);
    setMeta(this.d.labDb, 'report_done', new Date(this.d.now()).toISOString());
    try {
      await this.d.alert('[PERP-LAB] the 7-day audit is complete; the report is in data/perp/intake-lab-week1.md');
    } catch (err) {
      console.error('[perp-lab] alert failed:', err instanceof Error ? err.message : String(err));
    }
    return true;
  }
}
```

- [ ] **Step 5: Run to see them pass; typecheck** — `npx vitest run test/perp/labStartup.test.ts test/perp/labService.test.ts && npx tsc --noEmit`. Note: the test name for "silence" relies on `checkSilence` semantics from `src/perp/intake/silence.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/perp/lab/service.ts src/perp/lab/startup.ts test/perp/labService.test.ts test/perp/labStartup.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(perp-lab): lab service (logging, paced audits, day-7 lifecycle, heartbeat) and startup rules" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The lab process, its systemd unit, and docs

**Files:**
- Create: `src/perp/lab/main.ts`, `deploy/mini-mac/intake-lab.service`
- Modify: `package.json` (script `perp-lab`), `docs/runbook-perp.md`
- Test: `test/perp/labDeploy.test.ts`

**Interfaces:**
- Consumes: everything above; `createRedisClient`, `StreamConsumer`, `acquireLedgerLock`, `sendAlert`, `Anthropic`, `loadPrefilterConfig`, `makeEvaluator`, `openLabDb`, `auditItem`, `currentCommit`.
- Produces: the runnable `intake-lab` process (`npm run perp-lab`); unit `deploy/mini-mac/intake-lab.service`.

- [ ] **Step 1: Write the failing deploy test**

```ts
// test/perp/labDeploy.test.ts
// The lab unit must be paper-pinned on its ExecStart line (an env file cannot undo it) and sandboxed like the bot.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertPaperOnly } from '../../src/perp/lab/startup.js';

const text = fs.readFileSync(path.resolve(__dirname, '../../deploy/mini-mac/intake-lab.service'), 'utf-8');
const execStart = text.split('\n').find((l) => l.trim().startsWith('ExecStart='))!.trim().slice('ExecStart='.length);

function effectiveEnv(envFiles: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...envFiles };
  const argv = execStart.split(/\s+/);
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-u') { delete env[argv[++i]]; continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[i]);
    if (!kv) break;
    env[kv[1]] = kv[2];
  }
  return env as NodeJS.ProcessEnv;
}

describe('intake-lab.service', () => {
  it('pins PERP_MODE=paper and strips PERP_LIVE and NODE_OPTIONS on the ExecStart line, and runs the lab main', () => {
    expect(execStart).toMatch(/^\/usr\/bin\/env -u PERP_LIVE -u NODE_OPTIONS PERP_MODE=paper /);
    expect(execStart).toContain('src/perp/lab/main.ts');
  });
  it('a hostile env file still yields a paper-only start', () => {
    const env = effectiveEnv({ PERP_MODE: 'live', PERP_LIVE: 'KXUS500PERP:3', NODE_OPTIONS: '--require /tmp/evil.js' });
    expect(() => assertPaperOnly(env)).not.toThrow();
    expect(env.PERP_LIVE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
  it('is sandboxed like the bot: read-only home, writes only under the perp data dir, no new privileges', () => {
    expect(text).toMatch(/^ProtectHome=read-only$/m);
    expect(text).toMatch(/^ProtectSystem=strict$/m);
    expect(text).toMatch(/^NoNewPrivileges=yes$/m);
    expect(text).toMatch(/^ReadWritePaths=%h\/executor_module-perp\/data$/m);
  });
  it('starts after the bot and uses the shared secrets file, with the optional lab tunables file', () => {
    expect(text).toMatch(/^After=.*perp-bot\.service/m);
    expect(text).toMatch(/^EnvironmentFile=%h\/executor_module\/\.env$/m);
    expect(text).toMatch(/^EnvironmentFile=-%h\/executor_module\/\.env\.perp$/m);
  });
});
```

- [ ] **Step 2: Run to see it fail** — `npx vitest run test/perp/labDeploy.test.ts` (unit file missing).

- [ ] **Step 3: Create the unit file** `deploy/mini-mac/intake-lab.service` (modelled on `perp-bot.service`):

```ini
[Unit]
# SHADOW lab for the perp bot's news prefilter (design: docs/superpowers/specs/2026-10-14-perp-intake-prefilter-and-lab-design.md).
# It places no orders and writes only data/perp/lab.db: it logs every news item's prefilter verdict, audits a small sample of dropped
# items with Sonnet under LAB_DAILY_USD_CAP (default $0.50/day) for LAB_DAYS (default 7) days, and reads the bot's ledger read-only.
# Install: cp this file to ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now intake-lab
# Secrets come from the shared %h/executor_module/.env (ANTHROPIC_API_KEY, REDIS_URL, SLACK_WEBHOOK_URL); tunables (LAB_*, PERP_PREFILTER_FILE)
# may go in the optional %h/executor_module/.env.perp. The paper pin is on the ExecStart line, not in Environment=: an env file cannot undo it.
Description=US500 perp bot news-intake lab (paper, shadow)
After=network-online.target redis-server.service iip.service perp-bot.service
Wants=network-online.target

StartLimitIntervalSec=3600
StartLimitBurst=30

[Service]
Type=simple
WorkingDirectory=%h/executor_module-perp
EnvironmentFile=%h/executor_module/.env
EnvironmentFile=-%h/executor_module/.env.perp
ExecStart=/usr/bin/env -u PERP_LIVE -u NODE_OPTIONS PERP_MODE=paper %h/executor_module-perp/node_modules/.bin/tsx %h/executor_module-perp/src/perp/lab/main.ts

Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=intake-lab

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/executor_module-perp/data
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Create `src/perp/lab/main.ts`**

```ts
// src/perp/lab/main.ts
//
// Wiring only: Redis consumer group, timers, the Anthropic client. All behaviour lives in LabService (service.ts), which is tested.
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendAlert, setAlertTrade } from '../../alert.js';
import { acquireLedgerLock } from '../../decide/ledgerLock.js';
import { createRedisClient } from '../../redis/client.js';
import { StreamConsumer } from '../../redis/consumer.js';
import { loadPrefilterConfig } from '../intake/prefilter.js';
import type { ModelDeps } from '../model/gate.js';
import { currentCommit } from '../ops/commit.js';
import { auditItem } from './audit.js';
import { makeEvaluator } from './features.js';
import { openLabDb } from './labDb.js';
import { makeRng } from './sampler.js';
import { LabService } from './service.js';
import { assertPaperOnly, resolveLabConfig } from './startup.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AUDIT_TICK_MS = 20_000;
const MARKS_TICK_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const HOUSEKEEPING_MS = 5 * 60_000;

export async function main(): Promise<void> {
  assertPaperOnly(process.env);
  const cfg = resolveLabConfig(process.env, REPO_ROOT);
  const prefilterCfg = loadPrefilterConfig(cfg.prefilterFile);
  mkdirSync(cfg.dataDir, { recursive: true });
  const labPath = path.join(cfg.dataDir, 'lab.db');
  const lock = acquireLedgerLock(labPath);
  process.once('exit', () => lock.release());
  const labDb = openLabDb(labPath);
  setAlertTrade('perp-lab');

  let botDb: Database.Database | null = null;
  try {
    botDb = new Database(cfg.botDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error('[perp-lab] bot ledger not readable (features are still logged):', err instanceof Error ? err.message : String(err));
  }

  const commit = currentCommit(REPO_ROOT);
  const anthropic = new Anthropic();
  const modelDeps: ModelDeps = { client: anthropic as unknown as ModelDeps['client'], db: labDb, dailyUsdCap: cfg.capUsd };
  const reportPath = path.join(cfg.dataDir, 'intake-lab-week1.md');
  const service = new LabService({
    labDb, botDb, evaluator: makeEvaluator(prefilterCfg), cfg: prefilterCfg, now: () => Date.now(), commit, capUsd: cfg.capUsd, days: cfg.days, rng: makeRng(cfg.seed),
    audit: (row, stratum, kind) => (botDb === null ? Promise.resolve('no_context' as const) : auditItem({ labDb, botDb, modelDeps, now: () => Date.now() }, row, stratum, kind)),
    alert: (m) => sendAlert(m),
    writeReport: (md) => writeFileSync(reportPath, md),
  });

  console.log(`[perp-lab] starting capUsd=${cfg.capUsd} days=${cfg.days} seed=${cfg.seed} commit=${commit} lab=${labPath} bot=${cfg.botDbPath}`);
  const redis = createRedisClient();
  await redis.connect();
  const consumer = new StreamConsumer(redis, { streamKey: 'iip:items', groupName: 'perp-lab', consumerName: 'perp-lab-primary', startId: '$' });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  // Every timer callback is wrapped: an exception in a timer would kill the process, and the lab must keep logging.
  const safe = (what: string, fn: () => unknown): (() => void) => () => {
    Promise.resolve()
      .then(fn)
      .catch((err) => console.error(`[perp-lab] ${what} failed:`, err instanceof Error ? err.message : String(err)));
  };
  const timers = [
    setInterval(safe('audit', () => service.auditTick()), AUDIT_TICK_MS),
    setInterval(safe('marks', () => service.fillMarks()), MARKS_TICK_MS),
    setInterval(safe('heartbeat', () => service.recordHeartbeat()), HEARTBEAT_MS),
    setInterval(safe('housekeeping', async () => { await service.silenceTick(); await service.maybeReport(); }), HOUSEKEEPING_MS),
  ];

  try {
    await consumer.run(async (entry) => {
      await service.handleEntry(entry); // never rejects
    }, controller.signal);
  } finally {
    for (const t of timers) clearInterval(t);
    await redis.quit().catch(() => undefined);
    botDb?.close();
    labDb.close();
  }
}

main().catch((err) => {
  console.error('[perp-lab] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

Add to `package.json` scripts: `"perp-lab": "tsx src/perp/lab/main.ts",`.

- [ ] **Step 5: Document** in `docs/runbook-perp.md` a section `## Intake lab (7-day prefilter audit)`: what it is and that it never trades; the unit (`deploy/mini-mac/intake-lab.service`, install and enable commands, restart together with `perp-bot`); tunables (`LAB_DAILY_USD_CAP` default 0.50, `LAB_DAYS` 7, `LAB_SEED`, `LAB_BOT_DB`); where data lives (`data/perp/lab.db`, tables); how to query it read-only (python `mode=ro` examples for the funnel and the audits); the report (`data/perp/intake-lab-week1.md`, regenerate with `npm run intake-lab-report -- --lab data/perp/lab.db --bot data/perp/perp-paper.db --out data/perp/intake-lab-week1.md`); the tile (slot 10, `~/wall/intake-lab-publish.py`, `LAB_WALL_SLOT`); how to stop it (`systemctl --user disable --now intake-lab`, data stays).

Also make these clarifications in the spec (`docs/superpowers/specs/2026-10-14-perp-intake-prefilter-and-lab-design.md`, section 5) so it matches what was built: the audit spend is recorded in the lab's own `model_calls` table (the same table the bot uses, so `callJson`'s daily cap enforces the $0.50) instead of a separate `spend` table; pacing is `allowed(h) = min(cap, cap/24 x (h+2))` for UTC hour `h` (one hourly slice of slack) instead of "2x carry-over"; `items` also stores the snippet (up to 1200 characters) and the publish time; the report is written to `data/perp/intake-lab-week1.md` (the only writable directory under `ProtectSystem=strict`); audit context is the bot's newest snapshot (at most 10 minutes old) summarised as if flat with no news pressure; the lab computes the lexicon score for social items itself (the production verdict reports 0 for them) so boundary social posts can be found.

- [ ] **Step 6: Run the tests, the perp suite, the typecheck; start the process dry**

Run: `npx vitest run test/perp/labDeploy.test.ts && npx vitest run test/perp && npx tsc --noEmit`
Expected: PASS.

Then confirm the process refuses to start unpinned (no Redis or network is touched):
`env -u PERP_MODE npx tsx src/perp/lab/main.ts 2>&1 | tail -2` → `[perp-lab] fatal: the intake lab runs only with PERP_MODE=paper ...` and exit code 1. Do **not** start the real lab or touch the live bot's database in this task; deployment is an operator step.

- [ ] **Step 7: Commit**

```bash
git add src/perp/lab/main.ts deploy/mini-mac/intake-lab.service package.json docs/runbook-perp.md test/perp/labDeploy.test.ts docs/superpowers/specs/2026-10-14-perp-intake-prefilter-and-lab-design.md
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "feat(perp-lab): the lab process, its paper-pinned systemd unit and the runbook section" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end check against a copy of the real data (no model calls)

**Files:**
- Test: `test/perp/labEndToEnd.test.ts`

This task adds one integration test that drives `LabService` through a realistic sequence with the real prefilter config and a fake audit function, and then builds the report, to catch interface drift between Tasks 1-7.

- [ ] **Step 1: Write the test**

```ts
// test/perp/labEndToEnd.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { loadPrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { makeEvaluator } from '../../src/perp/lab/features.js';
import { openLabDb } from '../../src/perp/lab/labDb.js';
import { makeRng } from '../../src/perp/lab/sampler.js';
import { LabService } from '../../src/perp/lab/service.js';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
let n = 0;
const item = (source_id: string, headline: string, at: number): Item => ({
  item_id: `e${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline, snippet: null, url: null,
  raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null, source_publish_ts: new Date(at - 60_000).toISOString(),
  first_seen_ts: new Date(at - 50_000).toISOString(), emitted_ts: new Date(at - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0,
  provenance_gaps: [], amends_item_id: null, amendment_kind: null,
});

describe('lab end to end (fake audit, no model)', () => {
  it('logs a day of mixed traffic, audits dropped items within the pace, fills returns, and reports', async () => {
    const clock = { t: T0 };
    const labDb = openLabDb(':memory:'); const botDb = openPerpDb(':memory:');
    for (let h = 0; h <= 30; h++) recordMark(botDb, T0 + h * H, 100 + h * 0.1);
    const cfg = loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));
    const audited: string[] = [];
    const svc = new LabService({
      labDb, botDb, evaluator: makeEvaluator(cfg), cfg, now: () => clock.t, commit: 'abc1234', capUsd: 0.5, days: 7, rng: makeRng(3),
      audit: async (row, stratum, kind) => {
        audited.push(row.item_id);
        labDb.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, ?, ?, 'minor', 'neutral', 'x', 0, 1)").run(row.item_id, clock.t, stratum, kind);
        return 'audited';
      },
      alert: () => undefined, writeReport: () => undefined,
    });
    const feed = [
      ['axios_all', 'Inflation heats up as gas prices surge'], ['bluesky_geopolitics', 'Inflation and the Fed: rates must fall'], ['ukrinform_news', 'Zelensky briefs Burnham on Russian attacks'],
      ['thehill_news', 'Inflation heats up as gas prices surge again'], ['oilprice_main', 'Crude inventories fall'], ['bluesky_geopolitics', 'A rant about everything'],
    ];
    for (let i = 0; i < 60; i++) {
      const [src, head] = feed[i % feed.length];
      clock.t = T0 + i * 5 * 60_000;
      await svc.handleEntry({ id: `${i}-0`, fields: { json: JSON.stringify(item(src, `${head} #${i}`, clock.t)) } });
      await svc.auditTick();
    }
    const total = (labDb.prepare('select count(*) as n from items').get() as { n: number }).n;
    expect(total).toBe(60);
    expect(audited.length).toBeGreaterThan(0);
    expect(new Set(audited).size).toBe(audited.length); // never the same item twice
    clock.t = T0 + 6 * H;
    expect(svc.fillMarks()).toBeGreaterThan(0);
    clock.t = T0 + 8 * 24 * H;
    expect(await svc.maybeReport()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it** — `npx vitest run test/perp/labEndToEnd.test.ts`. Expected: PASS. If it fails, the failure is an interface mismatch between earlier tasks: fix the code (not the test) and say which task's interface was wrong.

- [ ] **Step 3: Full perp suite and typecheck** — `npx vitest run test/perp && npx tsc --noEmit`.

- [ ] **Step 4: Commit**

```bash
git add test/perp/labEndToEnd.test.ts
git -c user.name="Eamon McNamee" -c user.email="224684024+emcnamee-bs@users.noreply.github.com" commit -m "test(perp-lab): end-to-end run of the lab service with a fake audit" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The wall tile switches to the lab's numbers (outside git)

**Files (on mini-mac, not in git):**
- Rewrite: `~/wall/intake-lab-publish.py` (back up first)
- Create: `~/wall/tests/test_intake_lab_publish.py`

**Context.** The current script (slot 10, project `intake-lab`) shows the bot's baseline and runs as an executable script on import. Rewrite it into importable pieces: `cp_upper(k, n)` (Clopper-Pearson, pure), `build_spec(inputs)` (pure; `inputs['mode']` is `'baseline'` or `'lab'`), `gather()` (reads databases read-only), `main()`. Keep the baseline behaviour byte-for-byte for `mode='baseline'`. Layout rules from the wall: at most **3** stat chips (labels <= 16 chars, values <= 12), health lights <= 4 (names <= 18), charts <= 3 (titles <= 22, subtitles <= 26, kpi labels <= 12, values <= 10), `status_label` <= 14 chars, no headlines, `slot` from `LAB_WALL_SLOT` (default 10).

- [ ] **Step 1: Back up and write the failing tests**

```bash
cd ~/wall && cp intake-lab-publish.py intake-lab-publish.py.bak-pre-labmode-$(date +%Y%m%d-%H%M%S)
```

`~/wall/tests/test_intake_lab_publish.py`:

```python
import importlib.util, os, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("intake_lab_publish", os.path.join(HERE, "..", "intake-lab-publish.py"))
pub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pub)   # must not touch any database or the network on import

H = 3600
NOW = 1_792_000_000


def lab_inputs(**over):
    base = {
        "mode": "lab", "now": NOW, "slot": 10, "branch": "feat/perp-intake-prefilter-lab", "bot_up": True, "lab_up": True,
        "items_24h": 900, "passed_24h": 60, "audited_total": 420, "random_audited": 400, "random_misses": 0, "boundary_audited": 20, "boundary_misses": 1,
        "spend_today": 0.21, "cap": 0.5, "first_ms": (NOW - 2 * 86400) * 1000, "days": 7, "last_item_age_s": 40,
        "stream_ok": True, "bot_db_ok": True, "marks_fresh": True, "report_done": False,
        "hourly_passed": [[NOW - (3 - i) * H, 5 + i] for i in range(4)], "hourly_audits": [[NOW - (3 - i) * H, 10 + i] for i in range(4)],
        "hourly_spend": [[NOW - (3 - i) * H, 0.01 * (i + 1)] for i in range(4)],
    }
    base.update(over)
    return base


def baseline_inputs(**over):
    base = {
        "mode": "baseline", "now": NOW, "slot": 10, "branch": "feat/x", "bot_ok": True, "svc": True, "lab_exists": False, "last_gate_s": 120, "mark_age": 3,
        "h24": 935, "gate_err": 47, "s24": 278, "to_sonnet_pct": 31.0, "minor_pct": 100.0, "spend24": 1.28, "daily_cap": 5.0, "fresh_news": True,
        "haiku_pts": [[NOW - H, 100]], "sonnet_pts": [[NOW - H, 30]], "spend_pts": [[NOW - H, 0.1]],
    }
    base.update(over)
    return base


def within_limits(spec_):
    for s in spec_["stats"]:
        assert len(s["label"]) <= 16 and len(s["value"]) <= 12, s
    assert len(spec_["stats"]) <= 3
    assert len(spec_["health"]) <= 4
    for h in spec_["health"]:
        assert len(h["name"]) <= 18, h
    assert len(spec_["charts"]) <= 3
    for c in spec_["charts"]:
        assert len(c["title"]) <= 22 and len(c.get("subtitle", "")) <= 26, c
        for k in c["kpis"]:
            assert len(k["label"]) <= 12 and len(k["value"]) <= 10, k
    assert len(spec_["status_label"]) <= 14


class CpUpper(unittest.TestCase):
    def test_known_values(self):
        self.assertAlmostEqual(pub.cp_upper(0, 400), 1 - 0.05 ** (1 / 400), places=5)
        self.assertAlmostEqual(pub.cp_upper(1, 100), 0.0466, places=3)
        self.assertEqual(pub.cp_upper(0, 0), 1.0)
        self.assertEqual(pub.cp_upper(5, 5), 1.0)


class LabMode(unittest.TestCase):
    def test_status_chips_lights_charts(self):
        s = pub.build_spec(lab_inputs())
        within_limits(s)
        self.assertEqual(s["project"], "intake-lab")
        self.assertEqual(s["slot"], 10)
        self.assertEqual(s["status"], "ok")
        self.assertEqual(s["status_label"], "DAY 3/7")
        self.assertEqual([c["title"] for c in s["charts"]], ["Funnel", "Audit", "Lab spend"])
        labels = [x["label"] for x in s["stats"]]
        self.assertEqual(labels, ["Items 24h", "To Haiku", "Audited"])
        self.assertEqual(s["stats"][1]["value"], "6.7%")      # 60 of 900
        self.assertEqual(s["stats"][2]["value"], "420")

    def test_audit_chart_shows_misses_and_the_upper_bound(self):
        s = pub.build_spec(lab_inputs())
        audit = [c for c in s["charts"] if c["title"] == "Audit"][0]
        kp = {k["label"]: k["value"] for k in audit["kpis"]}
        self.assertEqual(kp["MISSES"], "0/400")
        self.assertTrue(kp["UB 95%"].endswith("%"))
        self.assertAlmostEqual(float(kp["UB 95%"].rstrip("%")), pub.cp_upper(0, 400) * 100, delta=0.06)

    def test_a_miss_turns_the_misses_kpi_bad(self):
        s = pub.build_spec(lab_inputs(random_misses=2))
        audit = [c for c in s["charts"] if c["title"] == "Audit"][0]
        self.assertEqual([k for k in audit["kpis"] if k["label"] == "MISSES"][0]["state"], "bad")

    def test_spend_chart_kpis(self):
        s = pub.build_spec(lab_inputs())
        sp = [c for c in s["charts"] if c["title"] == "Lab spend"][0]
        kp = {k["label"]: k["value"] for k in sp["kpis"]}
        self.assertEqual(kp["TODAY"], "$0.21")
        self.assertEqual(kp["CAP"], "$0.50")

    def test_audit_complete_after_the_window(self):
        s = pub.build_spec(lab_inputs(first_ms=(NOW - 8 * 86400) * 1000, report_done=True))
        self.assertEqual(s["status_label"], "AUDIT DONE")
        self.assertIn("complete", s["task"].lower())

    def test_lights_reflect_health(self):
        s = pub.build_spec(lab_inputs(stream_ok=False, bot_db_ok=False, lab_up=False))
        st = {h["name"]: h["state"] for h in s["health"]}
        self.assertEqual(st["Lab"], "down")
        self.assertEqual(st["News"], "degraded")
        self.assertEqual(st["Bot DB"], "down")
        self.assertEqual(s["status"], "fail")

    def test_budget_light_when_the_cap_is_nearly_spent(self):
        s = pub.build_spec(lab_inputs(spend_today=0.5))
        self.assertEqual({h["name"]: h["state"] for h in s["health"]}["Budget"], "degraded")

    def test_no_headlines_or_secrets_in_the_payload(self):
        import json
        blob = json.dumps(pub.build_spec(lab_inputs())).lower()
        for bad in ("wall_key", "api_key", "webhook", "headline"):
            self.assertNotIn(bad, blob)


class BaselineMode(unittest.TestCase):
    def test_baseline_unchanged_in_shape(self):
        s = pub.build_spec(baseline_inputs())
        within_limits(s)
        self.assertEqual(s["status_label"], "DESIGN PHASE")
        self.assertEqual([x["label"] for x in s["stats"]], ["Haiku 24h", "Sonnet 24h", "Spend 24h"])
        self.assertEqual([c["title"] for c in s["charts"]], ["Haiku reads", "Sonnet calls", "Model spend"])
        self.assertEqual({h["name"]: h["state"] for h in s["health"]}["Lab"], "unknown")

    def test_bot_down_is_a_failure(self):
        s = pub.build_spec(baseline_inputs(svc=False))
        self.assertEqual(s["status"], "fail")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to see them fail** — `cd ~/wall && python3 -m unittest tests.test_intake_lab_publish 2>&1 | tail -6` (the current script has no `build_spec`/`cp_upper`; importing it also runs its side effects, which is itself the first thing to fix).

- [ ] **Step 3: Rewrite `~/wall/intake-lab-publish.py`** with exactly this content (it was run against the test file above, against the live bot ledger in baseline mode, against a synthetic `lab.db` built from the Task 1 schema in lab mode, and server-validated with a dry-run POST; the baseline branch reproduces the current tile)

```python
#!/usr/bin/env python3
"""Publish the intake-lab tile (project intake-lab, slot LAB_WALL_SLOT, default 10) to the Grafana wall. Runs ON mini-mac, read-only.

BASELINE mode (no data/perp/lab.db yet): the perp bot's own numbers (Haiku reads, Sonnet calls, spend) from its paper ledger.
LAB mode: the intake lab's numbers from lab.db (items, prefilter pass rate, audits, misses with the 95% upper bound, lab spend).
The wall key is read from the slot-writer's own .env and never printed. Usage: intake-lab-publish.py [--dry] [--print]
Importing this module has no side effects (the tests import it).
"""
import json, os, sqlite3, subprocess, sys, time, urllib.error, urllib.request

HOME = os.path.expanduser("~")
BOT_DB = f"{HOME}/executor_module-perp/data/perp/perp-paper.db"
LAB_DB = f"{HOME}/executor_module-perp/data/perp/lab.db"
WORK_DIR = f"{HOME}/executor_module-perp-intake"
URL = "http://localhost:8088"
SLUG, NAME = "intake-lab", "Intake lab"
BUCKET, N = 3600, 12                      # 12 hourly buckets
LAB_CAP_USD = float(os.environ.get("LAB_DAILY_USD_CAP", "0.5"))
LAB_DAYS = int(os.environ.get("LAB_DAYS", "7"))
DAILY_CAP_USD = float(os.environ.get("PERP_DAILY_USD_CAP", "5"))
REPORT_FILE = "data/perp/intake-lab-week1.md"


def cp_upper(k, n, confidence=0.95):
    """Clopper-Pearson one-sided upper bound of k/n (same maths as src/perp/lab/stats.ts). No information (n <= 0 or k >= n) is 1."""
    if n <= 0 or k >= n:
        return 1.0
    alpha = 1 - confidence

    def cdf(p):
        pmf = (1 - p) ** n
        total = pmf
        for i in range(k):
            pmf *= (n - i) / (i + 1) * p / (1 - p)
            total += pmf
        return total

    lo, hi = k / n, 1.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if cdf(mid) > alpha:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def bucketed(rows, first_ms, now):
    """rows: [(epoch_seconds, value)] -> hourly points from the first hour with data (no invented history), at most N hours."""
    end = now - now % BUCKET + BUCKET
    start = end - BUCKET * N
    first = max(start, (first_ms // 1000) - (first_ms // 1000) % BUCKET) if first_ms else start
    n = max(1, (end - first) // BUCKET)
    b = [0.0] * n
    for t, v in rows:
        i = (int(t) - first) // BUCKET
        if 0 <= i < n:
            b[i] += v
    return [[first + i * BUCKET, round(b[i], 4)] for i in range(n)]


def _pct(x):
    return "%.1f%%" % x


def _baseline(i):
    status, label = ("fail", "BOT DOWN") if (not i["bot_ok"] or not i["svc"]) else (
        ("ok", "LAB RUNNING") if i["lab_exists"] else ("building", "DESIGN PHASE"))
    gs = i["last_gate_s"]
    minor = i["minor_pct"]
    return {
        "project": SLUG, "name": NAME, "slot": i["slot"], "status": status, "status_label": label, "branch": i["branch"],
        "activity": {"state": "active" if (gs is not None and gs < 900) else "idle", "label": "gate %dm ago" % (gs // 60) if gs is not None else "no calls"},
        "task": "Spec in review: code prefilter (A) + 7-day audit lab (C)",
        "summary": "Baseline of the perp bot's news intake (Haiku reads, Sonnet calls, spend) that the code prefilter and the 7-day intake lab will be measured against.",
        "stats": [
            {"label": "Haiku 24h", "value": str(i["h24"]), "explain": "News items sent to the Haiku gate in the last 24 h. Today every item that passes the hygiene checks is sent; the prefilter is meant to cut this by 80%+."},
            {"label": "Sonnet 24h", "value": str(i["s24"]), "explain": "Items escalated to the Sonnet impact assessment in the last 24 h. Target: down 70%+ with the prefilter."},
            {"label": "Spend 24h", "value": "$%.2f" % i["spend24"], "explain": "Estimated model spend of the perp bot in the last 24 h (cost_usd in its ledger). Default daily cap is $%.0f. Gate errors in the last 24 h: %d (those items are lost)." % (i["daily_cap"], i["gate_err"])},
        ],
        "health": [
            {"name": "Perp bot", "state": "up" if i["svc"] else "down", "explain": "perp-bot.service (paper mode) is running."},
            {"name": "Ledger", "state": "up" if i["bot_ok"] else "down", "explain": "The bot's paper ledger could be read read-only."},
            {"name": "News", "state": "up" if i["fresh_news"] else ("degraded" if gs is not None else "unknown"), "explain": "A news item reached the Haiku gate in the last 30 minutes."},
            {"name": "Lab", "state": "up" if i["lab_exists"] else "unknown",
             "explain": "The intake lab writes data/perp/lab.db. Not built yet." if not i["lab_exists"] else "The intake lab database exists."},
        ],
        "charts": [
            {"title": "Haiku reads", "subtitle": "gate calls / hour", "kind": "bar", "span_label": "%dh" % len(i["haiku_pts"]),
             "points": i["haiku_pts"], "explain": "Hourly count of news items the bot sent to Haiku. Baseline for the prefilter.",
             "kpis": [{"label": "24H", "value": str(i["h24"])}, {"label": "ERR", "value": str(i["gate_err"]), "state": "bad" if i["gate_err"] else "ok"}]},
            {"title": "Sonnet calls", "subtitle": "impact calls / hour", "kind": "bar", "span_label": "%dh" % len(i["sonnet_pts"]),
             "points": i["sonnet_pts"], "explain": "Hourly Sonnet impact calls (each about $0.004). RATE = share of gate calls escalated to Sonnet; MINOR = share of Sonnet assessments rated minor (no market effect).",
             "kpis": [{"label": "RATE", "value": "%.0f%%" % i["to_sonnet_pct"]}, {"label": "MINOR", "value": ("%.0f%%" % minor) if minor is not None else "?"}]},
            {"title": "Model spend", "subtitle": "USD / hour", "kind": "line", "span_label": "%dh" % len(i["spend_pts"]),
             "points": i["spend_pts"], "explain": "Hourly model spend of the perp bot (Haiku gate plus Sonnet impact).",
             "kpis": [{"label": "24H", "value": "$%.2f" % i["spend24"]}, {"label": "CAP/DAY", "value": "$%.0f" % i["daily_cap"]}]},
        ],
    }


def _lab(i):
    now, first_ms, days = i["now"], i["first_ms"], i["days"]
    window_s = days * 86400
    elapsed = None if first_ms is None else now - first_ms // 1000
    done = elapsed is not None and elapsed >= window_s
    if first_ms is None:
        label = "STARTING"
    elif done:
        label = "AUDIT DONE"
    else:
        label = "DAY %d/%d" % (min(days, elapsed // 86400 + 1), days)
    if not i["lab_up"]:
        status, label = "fail", "LAB DOWN"
    elif not i["bot_up"]:
        status, label = "fail", "BOT DOWN"
    elif not i["stream_ok"]:
        status = "warn"
    else:
        status = "ok"
    if done:
        task = "7-day audit complete; report in %s" % REPORT_FILE
    else:
        ends = time.strftime("%b %d", time.gmtime(first_ms // 1000 + window_s)) if first_ms is not None else "7 days after the first item"
        task = "Validating prefilter A: audit $%.2f/day, ends %s UTC" % (i["cap"], ends)
    items, passed = i["items_24h"], i["passed_24h"]
    pass_rate = (100.0 * passed / items) if items else None
    k, n = i["random_misses"], i["random_audited"]
    ub = cp_upper(k, n) * 100 if n else None
    age = i["last_item_age_s"]
    return {
        "project": SLUG, "name": NAME, "slot": i["slot"], "status": status, "status_label": label, "branch": i["branch"],
        "activity": {"state": "active" if (age is not None and age < 900) else "idle", "label": "item %dm ago" % (age // 60) if age is not None else "no items"},
        "task": task,
        "summary": "The perp bot's news prefilter, audited for %d days: every item's verdict is logged, a small random sample of dropped items is judged by Sonnet (budget $%.2f/day), and any miss is counted." % (days, i["cap"]),
        "stats": [
            {"label": "Items 24h", "value": str(items), "explain": "News items the lab saw in the last 24 h (after the replay and age checks)."},
            {"label": "To Haiku", "value": _pct(pass_rate) if pass_rate is not None else "n/a", "explain": "Share of items the code prefilter lets through to Haiku. Before the prefilter this was about 100%."},
            {"label": "Audited", "value": str(i["audited_total"]), "explain": "Dropped items judged by Sonnet so far (random sample plus boundary cases)."},
        ],
        "health": [
            {"name": "Lab", "state": "up" if i["lab_up"] else "down", "explain": "intake-lab.service is running or has written a heartbeat in the last 5 minutes."},
            {"name": "News", "state": "up" if i["stream_ok"] else "degraded", "explain": "The lab received a news item in the last 30 minutes."},
            {"name": "Bot DB", "state": "up" if i["bot_db_ok"] else "down", "explain": "The lab can read the perp bot's ledger (read-only) for market context and price marks."},
            {"name": "Budget", "state": "degraded" if i["spend_today"] >= 0.9 * i["cap"] else "up", "explain": "Lab audit spend today against its daily cap; amber at 90%."},
        ],
        "charts": [
            {"title": "Funnel", "subtitle": "to Haiku / hour", "kind": "bar", "span_label": "%dh" % len(i["hourly_passed"]),
             "points": i["hourly_passed"], "explain": "Hourly count of items that passed the prefilter and reached Haiku.",
             "kpis": [{"label": "SEEN 24H", "value": str(items)}, {"label": "PASS", "value": _pct(pass_rate) if pass_rate is not None else "n/a"}]},
            {"title": "Audit", "subtitle": "audits / hour", "kind": "bar", "span_label": "%dh" % len(i["hourly_audits"]),
             "points": i["hourly_audits"], "explain": "Hourly Sonnet audits of dropped items. MISSES = random audits rated moderate or higher over random audits; UB 95% = the exact 95% upper bound on the miss rate.",
             "kpis": [{"label": "MISSES", "value": "%d/%d" % (k, n), "state": "bad" if k else "ok"}, {"label": "UB 95%", "value": _pct(ub) if ub is not None else "n/a"}]},
            {"title": "Lab spend", "subtitle": "USD / hour", "kind": "line", "span_label": "%dh" % len(i["hourly_spend"]),
             "points": i["hourly_spend"], "explain": "Hourly Sonnet audit spend of the lab; capped per UTC day.",
             "kpis": [{"label": "TODAY", "value": "$%.2f" % i["spend_today"]}, {"label": "CAP", "value": "$%.2f" % i["cap"]}]},
        ],
    }


def build_spec(i):
    """Pure: inputs dict -> tile spec. i['mode'] is 'baseline' or 'lab' (keys: see tests/test_intake_lab_publish.py)."""
    return _lab(i) if i["mode"] == "lab" else _baseline(i)


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout


def ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _gather_baseline(now, slot, branch):
    bot_ok = os.path.exists(BOT_DB)
    haiku_rows, sonnet_rows, spend_rows = [], [], []
    first_ms = None
    h24 = s24 = gate_err = 0
    spend24 = 0.0
    minor = assessed = 0
    last_gate_s = mark_age = None
    start = now - now % BUCKET + BUCKET - BUCKET * N
    if bot_ok:
        try:
            c = ro(BOT_DB)
            day_ms = (now - 86400) * 1000
            first_ms = c.execute("select min(called_at_ms) from model_calls").fetchone()[0]
            for ts, stage, ok, cost in c.execute("select called_at_ms, stage, ok, cost_usd from model_calls where called_at_ms >= ?", (start * 1000,)):
                t = ts // 1000
                spend_rows.append((t, cost or 0))
                if stage == "gate":
                    haiku_rows.append((t, 1))
                elif stage == "impact":
                    sonnet_rows.append((t, 1))
            h24, gate_err = c.execute("select count(*), coalesce(sum(ok=0),0) from model_calls where stage='gate' and called_at_ms>=?", (day_ms,)).fetchone()
            s24 = c.execute("select count(*) from model_calls where stage='impact' and called_at_ms>=?", (day_ms,)).fetchone()[0]
            spend24 = c.execute("select coalesce(sum(cost_usd),0) from model_calls where called_at_ms>=?", (day_ms,)).fetchone()[0]
            for (j,) in c.execute("select json from assessments where received_ms >= ?", (day_ms,)):
                assessed += 1
                minor += 1 if json.loads(j).get("bucket") == "minor" else 0
            lg = c.execute("select max(called_at_ms) from model_calls where stage='gate'").fetchone()[0]
            last_gate_s = None if lg is None else now - lg // 1000
            lm = c.execute("select max(ts_ms) from marks").fetchone()[0]
            mark_age = None if lm is None else now - lm // 1000
            c.close()
        except Exception as e:                      # the tile must say so, not crash
            print("bot ledger read failed:", type(e).__name__, file=sys.stderr)
            bot_ok = False
    return {
        "mode": "baseline", "now": now, "slot": slot, "branch": branch, "bot_ok": bot_ok,
        "svc": sh("systemctl --user is-active perp-bot").strip() == "active", "lab_exists": os.path.exists(LAB_DB),
        "last_gate_s": last_gate_s, "mark_age": mark_age, "h24": h24, "gate_err": gate_err, "s24": s24,
        "to_sonnet_pct": (100.0 * s24 / max(1, h24 - gate_err)) if h24 else 0.0,
        "minor_pct": (100.0 * minor / assessed) if assessed else None, "spend24": spend24, "daily_cap": DAILY_CAP_USD,
        "fresh_news": last_gate_s is not None and last_gate_s < 1800,
        "haiku_pts": bucketed(haiku_rows, first_ms, now), "sonnet_pts": bucketed(sonnet_rows, first_ms, now), "spend_pts": bucketed(spend_rows, first_ms, now),
    }


def _gather_lab(now, slot, branch):
    i = {"mode": "lab", "now": now, "slot": slot, "branch": branch, "cap": LAB_CAP_USD, "days": LAB_DAYS,
         "bot_up": sh("systemctl --user is-active perp-bot").strip() == "active", "lab_up": False,
         "items_24h": 0, "passed_24h": 0, "audited_total": 0, "random_audited": 0, "random_misses": 0, "boundary_audited": 0, "boundary_misses": 0,
         "spend_today": 0.0, "first_ms": None, "last_item_age_s": None, "stream_ok": False, "bot_db_ok": False, "marks_fresh": False, "report_done": False,
         "hourly_passed": [], "hourly_audits": [], "hourly_spend": []}
    try:
        c = ro(LAB_DB)
        day_ms = (now - 86400) * 1000
        i["first_ms"] = c.execute("select min(received_ms) from items").fetchone()[0]
        i["items_24h"], p = c.execute("select count(*), coalesce(sum(prod_pass),0) from items where received_ms >= ?", (day_ms,)).fetchone()
        i["passed_24h"] = int(p)
        i["audited_total"] = c.execute("select count(*) from audits where ok = 1").fetchone()[0]
        i["random_audited"], rm = c.execute("select count(*), coalesce(sum(miss),0) from audits where ok = 1 and kind = 'random'").fetchone()
        i["random_misses"] = int(rm)
        i["boundary_audited"], bm = c.execute("select count(*), coalesce(sum(miss),0) from audits where ok = 1 and kind = 'boundary'").fetchone()
        i["boundary_misses"] = int(bm)
        day_start = now - now % 86400
        i["spend_today"] = c.execute("select coalesce(sum(cost_usd),0) from model_calls where called_at_ms >= ?", (day_start * 1000,)).fetchone()[0]
        li = c.execute("select max(received_ms) from items").fetchone()[0]
        i["last_item_age_s"] = None if li is None else max(0, now - li // 1000)
        hb = c.execute("select ts_ms, stream_ok, bot_db_ok, marks_fresh from heartbeat order by ts_ms desc limit 1").fetchone()
        hb_fresh = hb is not None and now - hb[0] // 1000 < 300
        if hb_fresh:
            i["stream_ok"], i["bot_db_ok"], i["marks_fresh"] = bool(hb[1]), bool(hb[2]), bool(hb[3])
        i["lab_up"] = hb_fresh or sh("systemctl --user is-active intake-lab").strip() == "active"
        i["report_done"] = c.execute("select 1 from meta where key = 'report_done'").fetchone() is not None
        since = (now - BUCKET * N) * 1000
        i["hourly_passed"] = bucketed([(t // 1000, v) for t, v in c.execute("select received_ms, prod_pass from items where received_ms >= ?", (since,))], i["first_ms"], now)
        i["hourly_audits"] = bucketed([(t // 1000, 1) for (t,) in c.execute("select at_ms from audits where ok = 1 and at_ms >= ?", (since,))], i["first_ms"], now)
        i["hourly_spend"] = bucketed([(t // 1000, v or 0) for t, v in c.execute("select called_at_ms, cost_usd from model_calls where called_at_ms >= ?", (since,))], i["first_ms"], now)
        c.close()
    except Exception as e:                          # the tile must say so, not crash
        print("lab database read failed:", type(e).__name__, file=sys.stderr)
        i["lab_up"] = False
        i["hourly_passed"] = i["hourly_audits"] = i["hourly_spend"] = bucketed([], None, now)
    return i


def gather(now=None):
    """Read the databases (mode=ro) and return the inputs dict for build_spec. Never raises: an unreadable database becomes a False flag."""
    now = int(now or time.time())
    slot = int(os.environ.get("LAB_WALL_SLOT", "10"))
    branch = sh(f"git -C {WORK_DIR} branch --show-current").strip() or "main"
    return (_gather_lab if os.path.exists(LAB_DB) else _gather_baseline)(now, slot, branch)


def wall_key():
    for line in open(f"{HOME}/monitoring/slot-writer/.env"):
        if line.startswith("WALL_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("WALL_KEY not found")


def main(argv):
    spec = build_spec(gather())
    if "--print" in argv:
        print(json.dumps(spec, indent=1))
    path = "/snapshot" + ("?dry=1" if "--dry" in argv else "")
    req = urllib.request.Request(URL + path, data=json.dumps(spec).encode(), method="POST",
                                 headers={"X-Wall-Key": wall_key(), "Content-Type": "application/json"})
    try:
        print(urllib.request.urlopen(req, timeout=60).read().decode()[:400])
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:600])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

Layout facts baked into it: 3 stat chips, 4 lights, 3 charts, `status_label` at most 14 characters; the lab-mode window is `LAB_DAYS` (default 7) and the cap shown is `LAB_DAILY_USD_CAP` (default 0.5), read from the environment of the publisher (set them in its systemd unit only if the lab's values are changed).

- [ ] **Step 4: Run the tests until they pass; run the whole wall test suite; publish once**

Run: `cd ~/wall && python3 -m unittest discover -s tests 2>&1 | tail -4` (all pass, including the existing paper-grid tests).
Run: `python3 intake-lab-publish.py --dry --print 2>&1 | head -30` then `python3 intake-lab-publish.py` (baseline mode still, since no `lab.db` yet) and confirm `{"slot": 10, "reused": true, ...}`. Do not remove the timer; it keeps running the new script.

- [ ] **Step 5: Verify on the wall** (the operator or controller does this with a screenshot; the implementer reports the spec JSON): the tile in slot 10 must still show the baseline, nothing clipped, three chips on one row.

(No commit: the wall tools are not in git.)

---

## Deploy (operator steps; not part of any task above)

Done by the operator after the final review, together with Plan A's deploy:

1. Fast-forward `~/executor_module-perp` (the bot's checkout, kept on `main`) to the branch head; both units will record that commit.
2. `cp deploy/mini-mac/intake-lab.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now intake-lab`; restart `perp-bot` in the same step. Check both start lines show the same `commit=`.
3. The 7-day clock starts at the first logged item; the tile switches from baseline to lab mode by itself (`~/wall/intake-lab-publish.py` runs every 2 minutes).
4. Day 7: the report appears in `data/perp/intake-lab-week1.md` and one `[PERP-LAB]` Slack message is sent; decide on the recommended config change.
5. Stop at any time: `systemctl --user disable --now intake-lab` (the data stays); the bot is unaffected.
