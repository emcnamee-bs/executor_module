// test/decide/pipelineUnified.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openLedger, recordDecision, tripBreaker, MAX_TRADES_PER_WINDOW } from '../../src/decide/ledger.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { runDecisionPipeline, type PipelineDeps } from '../../src/decide/pipeline.js';
import * as gateModule from '../../src/decide/gate.js';
import * as triageModule from '../../src/decide/triage.js';
import * as decideModule from '../../src/decide/decide.js';
import * as unifiedModule from '../../src/decide/unifiedDecide.js';
import type { UnifiedDecision, UnifiedContext } from '../../src/decide/unifiedDecide.js';
import type { ActiveLadder, BandMarket } from '../../src/decide/kalshi.js';
import { thresholdBands, makeItem } from '../paper/exitFixtures.js';

describe('runDecisionPipeline in unified mode', () => {
  let dir: string;
  let db: Database.Database;
  let deps: PipelineDeps;
  let alerts: string[];
  let decideCalls: UnifiedContext[];
  const ladder: ActiveLadder = { eventTicker: 'EV', strikeDate: null, bands: thresholdBands(1) };
  const root = mkdtempSync(path.join(tmpdir(), 'pipeunified-profile-'));
  writeProfile(root, 'kxwti', { profile: { seriesTicker: 'KXWTI', marketStructure: 'threshold', maxMagnitude: 10, magnitudeUnit: 'USD/bbl' } });
  writeProfile(root, 'kxfeddecision', { profile: { seriesTicker: 'KXFEDDECISION', marketStructure: 'multi', outcomeGroup: 'exclusive', maxMagnitude: 25, magnitudeUnit: 'bps' } });
  const wti = loadProfile('kxwti', root);
  const fed = loadProfile('kxfeddecision', root);

  const decision = (over: Partial<UnifiedDecision> = {}): UnifiedDecision => ({
    assessment: { shift: -2, confidence: 1, reason: 'bearish' }, moves: [], reasoning: 'bearish', positions: new Map(), entry: { action: 'none', reason: 'nothing to buy' }, ...over,
  });
  const answer = (d: UnifiedDecision) => vi.spyOn(unifiedModule, 'positionAwareDecide').mockImplementation(async (_c, _db, ctx) => { decideCalls.push(ctx); return d; });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pipeunified-'));
    db = openLedger(path.join(dir, 'l.db'));
    alerts = [];
    decideCalls = [];
    process.env.KALSHI_DRY_RUN = 'true';
    delete process.env.EXECUTOR_LIVE_TRADE;
    delete process.env.EXECUTOR_TRADING_HALTED;
    vi.spyOn(gateModule, 'runGate').mockResolvedValue({ relevant: true, reason: 'moves WTI' });
    vi.spyOn(triageModule, 'triageItem').mockResolvedValue({ verdict: 'escalate', reason: 'meaningful' });
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({ direction: 'down', magnitudePts: 2, shouldTrade: true, reasoning: 'classic' });
    deps = {
      anthropicClient: {} as Anthropic, ollamaClient: {} as any, db, fetchLadder: async () => ladder, kalshiClient: { getPositions: async () => ({ market_positions: [] }) } as any,
      profile: wti, fetchArticle: async () => null, decisionMode: 'unified',
      exit: { fetchLadderForEvent: async () => ladder, fetchTrajectory: async () => [{ minutesAgo: 5, markCents: 50 }], alert: (m: string) => { alerts.push(m); } },
    };
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.KALSHI_DRY_RUN;
    delete process.env.EXECUTOR_LIVE_TRADE;
    delete process.env.EXECUTOR_TRADING_HALTED;
  });

  const heldYes = (market = 'T-94', itemId = 'p1') =>
    recordPaperPosition(db, { trade: 'kxwti', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: market, side: 'yes', contracts: 4, entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]' });
  const sellOn = (id: number) => new Map([[id, { action: 'sell' as const, reason: 'loses value' }]]);
  const holdOn = (id: number) => new Map([[id, { action: 'hold' as const, reason: 'priced in' }]]);
  const reviews = () => db.prepare(`SELECT position_id AS p, verdict, model_action AS a, decision_mode AS m, verdict_reason AS why FROM paper_exit_reviews ORDER BY id`).all() as any[];
  const positions = () => db.prepare(`SELECT item_id, market_ticker, side, structure FROM paper_positions ORDER BY id`).all() as any[];
  const entryRow = (id: string) => db.prepare(`SELECT reason FROM decisions WHERE item_id = ?`).get(id) as { reason: string } | undefined;
  const aiStages = () => (db.prepare(`SELECT stage FROM ai_calls`).all() as Array<{ stage: string }>).map((r) => r.stage);

  it('no positions and a buy: ONE call (no triage, no classic decide), a paper position through the normal sizing', async () => {
    const spy = answer(decision({ entry: { action: 'buy', reason: 'mispriced' } }));
    await runDecisionPipeline(makeItem(), deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(triageModule.triageItem).not.toHaveBeenCalled();
    expect(decideModule.decideTrade).not.toHaveBeenCalled();
    expect(decideCalls[0]).toMatchObject({ entryAllowed: true, positions: [] });
    expect(positions()).toHaveLength(1);
    expect(positions()[0].structure).toBe('threshold');
    expect(entryRow('news-1')).toBeDefined();
  });

  it('a held position, model sell and the rule agrees: sold, recorded as unified, entry none', async () => {
    const id = heldYes();
    answer(decision({ positions: sellOn(id) }));
    await runDecisionPipeline(makeItem(), deps);
    expect(reviews()).toEqual([expect.objectContaining({ p: id, verdict: 'sell', a: 'sell', m: 'unified' })]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_exits WHERE status IN ('filled','partial')`).get() as { n: number }).n).toBe(1);
    expect(positions()).toHaveLength(1); // no new entry
  });

  it('the model holds although the rule would sell: no sale, the disagreement is recorded', async () => {
    const id = heldYes();
    answer(decision({ positions: holdOn(id) }));
    await runDecisionPipeline(makeItem(), deps);
    expect(reviews()).toEqual([expect.objectContaining({ verdict: 'hold', a: 'hold', why: expect.stringMatching(/model recommended hold/) })]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_exits`).get() as { n: number }).n).toBe(0);
  });

  it('the model sells although the rule vetoes (no expected loss): no sale', async () => {
    const id = heldYes();
    answer(decision({ assessment: { shift: 0, confidence: 1, reason: 'neutral' }, positions: sellOn(id) }));
    await runDecisionPipeline(makeItem(), deps);
    expect(reviews()).toEqual([expect.objectContaining({ verdict: 'hold', a: 'sell', why: expect.stringMatching(/rule vetoed/) })]);
  });

  it('sells a position and refuses to buy the same market back in the same answer', async () => {
    const id = heldYes('T-90');
    answer(decision({ positions: sellOn(id), entry: { action: 'buy', reason: 'cheap' } }));
    await runDecisionPipeline(makeItem(), deps);
    expect(reviews()[0].verdict).toBe('sell');
    expect(positions().filter((p) => p.item_id !== 'p1')).toHaveLength(0);
    expect(entryRow('news-1')!.reason).toMatch(/exit trigger already fired/);
  });

  it('an entry blocker (kill switch) still reviews held positions, telling the model entry is unavailable', async () => {
    const id = heldYes();
    process.env.EXECUTOR_TRADING_HALTED = 'true';
    answer(decision({ positions: sellOn(id), entry: { action: 'buy', reason: 'cheap' } }));
    await runDecisionPipeline(makeItem(), deps);
    expect(decideCalls[0].entryAllowed).toBe(false);
    expect(reviews()[0].verdict).toBe('sell');
    expect(entryRow('news-1')!.reason).toMatch(/kill switch/);
    expect(positions()).toHaveLength(1);
  });

  it('makes no call when nothing is held and entry is blocked, or when the gate rejects', async () => {
    const spy = answer(decision());
    process.env.EXECUTOR_TRADING_HALTED = 'true';
    await runDecisionPipeline(makeItem({ item_id: 'a' }), deps);
    expect(gateModule.runGate).not.toHaveBeenCalled(); // nothing held, entry blocked: not even the gate runs
    delete process.env.EXECUTOR_TRADING_HALTED;
    vi.spyOn(gateModule, 'runGate').mockResolvedValue({ relevant: false, reason: 'unrelated' });
    heldYes();
    await runDecisionPipeline(makeItem({ item_id: 'b' }), deps);
    expect(spy).not.toHaveBeenCalled();
    expect(entryRow('b')!.reason).toMatch(/gate: not relevant/);
  });

  it('a redelivered item is not processed again', async () => {
    const id = heldYes();
    const spy = answer(decision({ positions: sellOn(id) }));
    await runDecisionPipeline(makeItem(), deps);
    await runDecisionPipeline(makeItem(), deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reviews()).toHaveLength(1);
  });

  it('a model failure writes an error review for every position, alerts once, and records an entry skip; nothing is sold or bought', async () => {
    const a = heldYes('T-94', 'p1');
    const b = heldYes('T-90', 'p2');
    vi.spyOn(unifiedModule, 'positionAwareDecide').mockRejectedValue(new Error('overloaded'));
    await runDecisionPipeline(makeItem(), deps);
    expect(reviews().map((r) => [r.p, r.verdict])).toEqual([[a, 'error'], [b, 'error']]);
    expect(alerts.filter((m) => /UNIFIED/.test(m))).toHaveLength(1);
    expect(entryRow('news-1')!.reason).toMatch(/unified decision failed.*overloaded/);
    expect(positions()).toHaveLength(2);
  });

  it('an unavailable market gets a hold review and is left out of the call', async () => {
    const id = heldYes('GONE-1');
    const spy = answer(decision());
    await runDecisionPipeline(makeItem(), deps);
    expect(reviews()).toEqual([expect.objectContaining({ p: id, verdict: 'hold', why: expect.stringMatching(/market not open/) })]);
    expect(decideCalls[0].positions).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is classic when the process is live-capable or not dry-run (re-read per item)', async () => {
    const spy = answer(decision({ entry: { action: 'buy', reason: 'cheap' } }));
    process.env.EXECUTOR_LIVE_TRADE = 'KXWTI';
    await runDecisionPipeline(makeItem({ item_id: 'a' }), deps);
    expect(decideModule.decideTrade).toHaveBeenCalledTimes(1); // the classic path really ran for 'a'
    delete process.env.EXECUTOR_LIVE_TRADE;
    delete process.env.KALSHI_DRY_RUN;
    await runDecisionPipeline(makeItem({ item_id: 'b' }), deps);
    expect(spy).not.toHaveBeenCalled();
  });

  it('classic mode is unchanged: no unified call, the classic decide runs', async () => {
    const spy = answer(decision());
    await runDecisionPipeline(makeItem(), { ...deps, decisionMode: 'classic', exit: undefined });
    expect(spy).not.toHaveBeenCalled();
    expect(decideModule.decideTrade).toHaveBeenCalled();
  });

  it('an active-event fetch failure is recorded like classic (a pipeline error skip) and positions are still reviewed', async () => {
    const id = heldYes();
    answer(decision({ positions: sellOn(id) }));
    await runDecisionPipeline(makeItem(), { ...deps, fetchLadder: async () => { throw new Error('kalshi down'); } });
    expect(reviews()[0].verdict).toBe('sell');
    expect(entryRow('news-1')!.reason).toMatch(/pipeline error: kalshi down/);
  });

  it('makes only decide_unified model calls through the real client path (no triage / decide / exit_review rows)', async () => {
    vi.restoreAllMocks();
    vi.spyOn(gateModule, 'runGate').mockResolvedValue({ relevant: true, reason: 'moves WTI' });
    process.env.KALSHI_DRY_RUN = 'true';
    const id = heldYes();
    const client = { messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: { assessment: { shift: -2, confidence: 1, reason: 'bearish' }, positions: [{ position_id: id, action: 'sell', reason: 'loses' }], entry: { action: 'none', reason: 'holding' } }, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }) } } as unknown as Anthropic;
    await runDecisionPipeline(makeItem(), { ...deps, anthropicClient: client });
    expect(aiStages()).toEqual(['decide_unified']);
    expect(reviews()[0].verdict).toBe('sell');
  });

  const heldOn = (event: string, market: string, itemId: string) =>
    recordPaperPosition(db, { trade: 'kxwti', itemId, structure: 'threshold', eventTicker: event, marketTicker: market, side: 'yes', contracts: 4, entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]' });
  const exitCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM paper_exits`).get() as { n: number }).n;

  it('a position-event ladder fetch failure: that position gets an error row and one alert; the others and the entry proceed', async () => {
    const a = heldYes('T-94', 'p1');
    const b = heldOn('EV2', 'T-92', 'p2');
    answer(decision({ positions: holdOn(a), entry: { action: 'buy', reason: 'mispriced' } }));
    const fetchLadderForEvent = vi.fn(async (event: string) => { if (event === 'EV2') throw new Error('kalshi 500'); return ladder; });
    await runDecisionPipeline(makeItem(), { ...deps, exit: { ...deps.exit!, fetchLadderForEvent } });
    const byId = new Map(reviews().map((r) => [r.p, r]));
    expect(byId.get(b)).toMatchObject({ verdict: 'error', m: 'unified', why: expect.stringMatching(/could not fetch the ladder for EV2/) });
    expect(byId.get(a)).toMatchObject({ verdict: 'hold', a: 'hold' });
    expect(alerts.filter((m) => /\[UNIFIED ERROR\]/.test(m))).toHaveLength(1);
    expect(decideCalls[0].positions.map((p) => p.id)).toEqual([a]);
    expect(decideCalls[0].entryAllowed).toBe(true);
    expect(positions().filter((p) => p.item_id === 'news-1')).toHaveLength(1);
  });

  it('a trajectory fetch failure: that position gets an error row and is never sold', async () => {
    const id = heldYes();
    answer(decision({ positions: sellOn(id) }));
    await runDecisionPipeline(makeItem(), { ...deps, exit: { ...deps.exit!, fetchTrajectory: async () => { throw new Error('candles down'); } } });
    expect(reviews()).toEqual([expect.objectContaining({ p: id, verdict: 'error', why: expect.stringMatching(/candles down/) })]);
    expect(decideCalls[0].positions).toEqual([]);
    expect(exitCount()).toBe(0);
  });

  it('position-event Kalshi calls never receive a db (a failure there must not feed the circuit breaker)', async () => {
    const id = heldOn('EV2', 'T-94', 'p2');
    answer(decision({ positions: holdOn(id) }));
    const fetchLadderForEvent = vi.fn(async () => ({ ...ladder, eventTicker: 'EV2' }));
    const fetchTrajectory = vi.fn(async () => [{ minutesAgo: 5, markCents: 50 }]);
    await runDecisionPipeline(makeItem(), { ...deps, exit: { ...deps.exit!, fetchLadderForEvent, fetchTrajectory, now: () => 1_700_000_000_500 } });
    expect(fetchLadderForEvent.mock.calls).toEqual([['EV2']]);
    expect(fetchTrajectory.mock.calls).toEqual([['KXWTI', 'T-94', 'yes', 1_700_000_000]]);
  });

  describe('entry blockers still review held positions, telling the model entry is unavailable', () => {
    const blocked = async (item: ReturnType<typeof makeItem>, reason: RegExp) => {
      const id = heldYes();
      answer(decision({ positions: sellOn(id), entry: { action: 'buy', reason: 'cheap' } }));
      await runDecisionPipeline(item, deps);
      expect(decideCalls).toHaveLength(1);
      expect(decideCalls[0].entryAllowed).toBe(false);
      expect(reviews()).toEqual([expect.objectContaining({ p: id, verdict: 'sell', m: 'unified' })]);
      expect(entryRow(item.item_id)!.reason).toMatch(reason);
      expect(positions()).toHaveLength(1);
    };
    it('rumor rung', async () => {
      await blocked(makeItem({ trust_tier: 5, corroborations: 0, story_key: null }), /rumor rung/);
    });
    it('rate limit', async () => {
      for (let i = 0; i < MAX_TRADES_PER_WINDOW; i++) {
        recordDecision(db, {
          itemId: `seed-rate-${i}`, storyKey: `seed-story-${i}`, eventTicker: 'OTHER', marketTicker: 'X-1', side: 'yes', rung: 'reported',
          direction: 'up', magnitudePts: 1, contracts: 1, entryPriceCents: 50, notionalCents: 50, edgeCents: 3, wouldTrade: true, reason: 'seed', orderStatus: 'resolved',
        });
      }
      await blocked(makeItem(), /rate limit/);
    });
    it('circuit breaker', async () => {
      tripBreaker(db, 'failed-orders', 'test trip');
      await blocked(makeItem(), /circuit breaker tripped/);
    });
  });

  it('never settles a position the model gave no recommendation for, even when the rule alone would sell', async () => {
    const id = heldYes(); // shift -2 on a held YES at T-94: the rule alone sells (see the "rule agrees" case)
    answer(decision({ positions: new Map() }));
    await runDecisionPipeline(makeItem(), deps);
    expect(reviews()).toEqual([expect.objectContaining({ p: id, verdict: 'error', a: null, m: 'unified', why: 'the model gave no recommendation for this position' })]);
    expect(exitCount()).toBe(0);
  });

  describe('multi trade', () => {
    const mk = (ticker: string, label: string, bid: number, ask: number): BandMarket => ({
      ticker, label, floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active', yesBidCents: bid, yesAskCents: ask, yesAskSizeContracts: 200, yesBidSizeContracts: 200,
    });
    const fedLadder: ActiveLadder = { eventTicker: 'FED-EV', strikeDate: null, bands: [mk('F-HOLD', 'Hold', 59, 61), mk('F-CUT', 'Cut 25bps', 29, 31)] };
    it('buys the model\'s moves on the active event (two legs on an exclusive set)', async () => {
      answer(decision({ assessment: null, moves: [{ market: 'F-CUT', shift: 20, confidence: 1 }, { market: 'F-HOLD', shift: -20, confidence: 1 }], entry: { action: 'buy', reason: 'cut likelier' } }));
      await runDecisionPipeline(makeItem(), { ...deps, profile: fed, fetchLadder: async () => fedLadder });
      expect(positions().map((p) => p.structure)).toEqual(['multi', 'multi']);
      expect(entryRow('news-1')!.reason).toMatch(/^\[PAPER multi\]/);
    });
    it('does nothing when the model says none', async () => {
      answer(decision({ assessment: null, moves: [{ market: 'F-CUT', shift: 20, confidence: 1 }, { market: 'F-HOLD', shift: -20, confidence: 1 }], entry: { action: 'none', reason: 'priced in' } }));
      await runDecisionPipeline(makeItem(), { ...deps, profile: fed, fetchLadder: async () => fedLadder });
      expect(positions()).toHaveLength(0);
    });
  });
});
