// test/decide/pipelineMulti.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { recordExitReview } from '../../src/paper/exits.js';
import { runDecisionPipeline, type PipelineDeps } from '../../src/decide/pipeline.js';
import * as gateModule from '../../src/decide/gate.js';
import * as triageModule from '../../src/decide/triage.js';
import * as decideMultiModule from '../../src/decide/decideMulti.js';
import type { ActiveLadder, BandMarket } from '../../src/decide/kalshi.js';
import { makeItem } from '../paper/exitFixtures.js';

const mk = (ticker: string, label: string, bid: number, ask: number): BandMarket => ({
  ticker, label, floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active',
  yesBidCents: bid, yesAskCents: ask, yesAskSizeContracts: 200, yesBidSizeContracts: 200,
});
// exclusive Fed-style set: mids 60 / 30 / 10
const ladder: ActiveLadder = { eventTicker: 'FED-EV', strikeDate: null, bands: [mk('F-HOLD', 'Hold', 59, 61), mk('F-CUT', 'Cut 25bps', 29, 31), mk('F-HIKE', 'Hike 25bps', 9, 11)] };
const mv = (market: string, shift: number, confidence = 1) => ({ market, shift, confidence });

describe('runDecisionPipeline: multi trades', () => {
  let dir: string;
  let db: Database.Database;
  let deps: PipelineDeps;
  const root = mkdtempSync(path.join(tmpdir(), 'pipemulti-profile-'));
  const loadMulti = (group: 'ladder' | 'exclusive' | 'independent') => {
    writeProfile(root, `kxmulti-${group}`, { profile: { seriesTicker: 'KXFEDDECISION', marketStructure: 'multi', outcomeGroup: group, maxMagnitude: 25, magnitudeUnit: 'bps' } });
    return loadProfile(`kxmulti-${group}`, root);
  };
  const decide = (over: Partial<Awaited<ReturnType<typeof decideMultiModule.decideMulti>>>) =>
    vi.spyOn(decideMultiModule, 'decideMulti').mockResolvedValue({ shouldTrade: true, moves: [], reasoning: 'because', ...over });
  const positions = () => db.prepare(`SELECT item_id, source_item_id, leg, market_ticker, side, structure, contracts, entry_price_cents FROM paper_positions ORDER BY id`).all() as any[];
  const decisionFor = (id: string) => db.prepare(`SELECT reason, would_trade FROM decisions WHERE item_id = ?`).get(id) as { reason: string; would_trade: number } | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pipemulti-'));
    db = openLedger(path.join(dir, 'l.db'));
    process.env.KALSHI_DRY_RUN = 'true';
    delete process.env.EXECUTOR_LIVE_TRADE;
    delete process.env.EXECUTOR_TRADING_HALTED;
    vi.spyOn(gateModule, 'runGate').mockResolvedValue({ relevant: true, reason: 'moves the Fed' });
    vi.spyOn(triageModule, 'triageItem').mockResolvedValue({ verdict: 'escalate', reason: 'meaningful' });
    deps = {
      anthropicClient: {} as Anthropic, ollamaClient: {} as any, db, fetchLadder: async () => ladder,
      kalshiClient: { getPositions: async () => ({ market_positions: [] }) } as any,
      profile: loadMulti('exclusive'), fetchArticle: async () => null,
    };
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.KALSHI_DRY_RUN;
  });

  it('buys YES on a raised market and NO on a lowered one (two legs on an exclusive set)', async () => {
    decide({ moves: [mv('F-CUT', 20), mv('F-HOLD', -20)], reasoning: 'a cut is likelier' });
    await runDecisionPipeline(makeItem(), deps);
    const rows = positions();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.item_id, r.source_item_id, r.leg, r.structure])).toEqual([
      ['news-1', 'news-1', 1, 'multi'], ['news-1#2', 'news-1', 2, 'multi'],
    ]);
    expect(rows.map((r) => r.side).sort()).toEqual(['no', 'yes']);
    const d = decisionFor('news-1')!;
    expect(d.would_trade).toBe(0);
    expect(d.reason).toMatch(/^\[PAPER multi\].*F-CUT.*\+.*F-HOLD.*a cut is likelier/);
  });

  it('opens only one leg on a ladder group, even with two good moves', async () => {
    deps = { ...deps, profile: loadMulti('ladder') };
    decide({ moves: [mv('F-HIKE', 8), mv('F-CUT', 5)] });
    await runDecisionPipeline(makeItem(), deps);
    expect(positions()).toHaveLength(1);
  });

  it('does nothing but log when the model declines or its answer is invalid', async () => {
    decide({ shouldTrade: false, moves: [], reasoning: 'invalid multi answer: shifts net to 20' });
    await runDecisionPipeline(makeItem(), deps);
    expect(positions()).toHaveLength(0);
    expect(decisionFor('news-1')!.reason).toMatch(/invalid multi answer/);
  });

  it('declines when no move clears the price/spread/edge gates, listing why', async () => {
    const tight: ActiveLadder = { ...ladder, bands: [mk('F-HOLD', 'Hold', 94, 96), mk('F-CUT', 'Cut 25bps', 2, 4)] };
    deps = { ...deps, fetchLadder: async () => tight };
    decide({ moves: [mv('F-HOLD', 3), mv('F-CUT', -3)] });
    await runDecisionPipeline(makeItem(), deps);
    expect(positions()).toHaveLength(0);
    expect(decisionFor('news-1')!.reason).toMatch(/F-HOLD: price 96c outside/);
  });

  it('is idempotent: a redelivered item neither re-buys nor duplicates a leg', async () => {
    const spy = decide({ moves: [mv('F-CUT', 20), mv('F-HOLD', -20)] });
    await runDecisionPipeline(makeItem(), deps);
    await runDecisionPipeline(makeItem(), deps);
    expect(positions()).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('drops a leg whose market already had a sell trigger, without losing the other leg', async () => {
    const heldId = recordPaperPosition(db, {
      trade: 'kxmulti-exclusive', itemId: 'old', structure: 'multi', eventTicker: 'FED-EV', marketTicker: 'F-CUT', side: 'yes', contracts: 2,
      entryPriceCents: 30, direction: 'up', magnitude: 5, edgeCents: 3, reasoning: 'r', ladderJson: '[]',
    });
    recordExitReview(db, {
      trade: 'kxmulti-exclusive', itemId: 'older', positionId: heldId, shift: -5, confidence: 1, reason: 'r', midCents: 30, fairAfterCents: 25,
      lossCents: 5, exitCostCents: 1, verdict: 'sell', verdictReason: 'x', lagJson: null,
    });
    decide({ moves: [mv('F-CUT', 20), mv('F-HOLD', -20)] });
    await runDecisionPipeline(makeItem(), deps);
    const fresh = positions().filter((r) => r.item_id !== 'old');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ market_ticker: 'F-HOLD', side: 'no', leg: 1, item_id: 'news-1' });
  });

  it('respects the kill switch, a rumor and the gate like every other structure', async () => {
    const spy = decide({ moves: [mv('F-CUT', 20), mv('F-HOLD', -20)] });
    process.env.EXECUTOR_TRADING_HALTED = 'true';
    await runDecisionPipeline(makeItem({ item_id: 'a' }), deps);
    delete process.env.EXECUTOR_TRADING_HALTED;
    await runDecisionPipeline(makeItem({ item_id: 'b', trust_tier: 5, corroborations: 0, story_key: null }), deps);
    vi.spyOn(gateModule, 'runGate').mockResolvedValue({ relevant: false, reason: 'unrelated' });
    await runDecisionPipeline(makeItem({ item_id: 'c' }), deps);
    expect(spy).not.toHaveBeenCalled();
    expect(positions()).toHaveLength(0);
  });

  it('never writes a would_trade decision row and never reaches an order', async () => {
    decide({ moves: [mv('F-CUT', 20), mv('F-HOLD', -20)] });
    const getPositions = vi.fn(async () => ({ market_positions: [] }));
    await runDecisionPipeline(makeItem(), { ...deps, kalshiClient: { getPositions } as any });
    expect(getPositions).not.toHaveBeenCalled();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE would_trade = 1`).get() as { n: number }).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM orders`).get() as { n: number }).n).toBe(0);
  });

  const seedSell = (market: string) => {
    const heldId = recordPaperPosition(db, {
      trade: 'kxmulti-exclusive', itemId: `old-${market}`, structure: 'multi', eventTicker: 'FED-EV', marketTicker: market, side: 'yes', contracts: 2,
      entryPriceCents: 30, direction: 'up', magnitude: 5, edgeCents: 3, reasoning: 'r', ladderJson: '[]',
    });
    recordExitReview(db, {
      trade: 'kxmulti-exclusive', itemId: `older-${market}`, positionId: heldId, shift: -5, confidence: 1, reason: 'r', midCents: 30, fairAfterCents: 25,
      lossCents: 5, exitCostCents: 1, verdict: 'sell', verdictReason: 'x', lagJson: null,
    });
  };
  const fresh = () => positions().filter((r) => !String(r.item_id).startsWith('old-'));

  it('a sell-triggered best-edge market does not take a leg slot on an exclusive group (two legs still open)', async () => {
    seedSell('F-CUT');
    decide({ moves: [mv('F-CUT', 20), mv('F-HOLD', -20), mv('F-HIKE', 5)] });
    await runDecisionPipeline(makeItem(), deps);
    const rows = fresh();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.market_ticker).sort()).toEqual(['F-HIKE', 'F-HOLD']);
    expect(decisionFor('news-1')!.reason).toMatch(/^\[PAPER multi\]/);
  });

  it('a sell-triggered best move on a ladder group falls through to the second-best, not zero legs', async () => {
    deps = { ...deps, profile: loadMulti('ladder') };
    seedSell('F-CUT');
    decide({ moves: [mv('F-CUT', 20), mv('F-HIKE', 8)] });
    await runDecisionPipeline(makeItem(), deps);
    const rows = fresh();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ market_ticker: 'F-HIKE', side: 'yes', leg: 1 });
  });

  it('records why when every move is on a sell-triggered market', async () => {
    seedSell('F-CUT');
    decide({ moves: [mv('F-CUT', 20)] });
    await runDecisionPipeline(makeItem(), deps);
    expect(fresh()).toHaveLength(0);
    expect(decisionFor('news-1')!.reason).toMatch(/exit trigger already fired on F-CUT; not re-entering/);
  });

  it('records a skip, not a crash, when the model returns trade=true with no moves', async () => {
    decide({ moves: [] });
    await runDecisionPipeline(makeItem(), deps);
    expect(positions()).toHaveLength(0);
    expect(decisionFor('news-1')!.reason).toBe('multi sizing: no moves to size');
  });

  it('tags legs and the decision row when the low-tier relaxation is on (paper only)', async () => {
    decide({ moves: [mv('F-CUT', 20), mv('F-HOLD', -20)], reasoning: 'a cut is likelier' });
    await runDecisionPipeline(makeItem({ trust_tier: 4, story_key: null, corroborations: 0 }), { ...deps, paperLowTier: true });
    const legs = db.prepare(`SELECT reasoning FROM paper_positions`).all() as { reasoning: string }[];
    expect(legs).toHaveLength(2);
    for (const l of legs) expect(l.reasoning).toMatch(/^\[low-tier relaxed: tier 4\] a cut is likelier/);
    expect(decisionFor('news-1')!.reason).toMatch(/^\[low-tier relaxed: tier 4\] \[PAPER multi\]/);
  });
});
