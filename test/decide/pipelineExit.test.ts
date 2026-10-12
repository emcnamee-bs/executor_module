// test/decide/pipelineExit.test.ts
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
import * as decideModule from '../../src/decide/decide.js';
import * as exitPipelineModule from '../../src/decide/exitPipeline.js';
import * as sizingModule from '../../src/decide/sizing.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import { thresholdBands, makeItem } from '../paper/exitFixtures.js';

describe('runDecisionPipeline with exit review', () => {
  let dir: string;
  let db: Database.Database;
  let parseCalls: any[];
  let deps: PipelineDeps;

  const ladder: ActiveLadder = { eventTicker: 'EV', strikeDate: null, bands: thresholdBands(1) };
  const profileRoot = mkdtempSync(path.join(tmpdir(), 'pipeexit-profile-'));
  writeProfile(profileRoot, 'kxwti', { profile: { seriesTicker: 'KXWTI', marketStructure: 'threshold', maxMagnitude: 10, magnitudeUnit: 'USD/bbl' } });
  const profile = loadProfile('kxwti', profileRoot);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pipeexit-'));
    db = openLedger(path.join(dir, 'l.db'));
    parseCalls = [];
    process.env.KALSHI_DRY_RUN = 'true';
    delete process.env.EXECUTOR_LIVE_TRADE;
    delete process.env.EXECUTOR_TRADING_HALTED;
    vi.spyOn(gateModule, 'runGate').mockResolvedValue({ relevant: true, reason: 'moves WTI' });
    vi.spyOn(triageModule, 'triageItem').mockResolvedValue({ verdict: 'escalate', reason: 'meaningful' });
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({ direction: 'down', magnitudePts: 2, shouldTrade: true, reasoning: 'bearish' });
    const client = {
      messages: {
        parse: async (p: unknown) => {
          parseCalls.push(p);
          return { stop_reason: 'end_turn', parsed_output: { shift: -2, confidence: 1, reason: 'bearish' }, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as unknown as Anthropic;
    deps = {
      anthropicClient: client, ollamaClient: {} as any, db, fetchLadder: async () => ladder, kalshiClient: { getPositions: async () => ({ market_positions: [] }) } as any,
      profile, fetchArticle: async () => null,
      exit: { fetchLadderForEvent: async () => ladder, fetchTrajectory: async () => [{ minutesAgo: 5, markCents: 50 }], alert: () => {} },
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

  const heldYes = () =>
    recordPaperPosition(db, {
      trade: 'kxwti', itemId: 'p1', structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-94', side: 'yes', contracts: 4,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]',
    });
  const sellReviews = () => (db.prepare(`SELECT COUNT(*) AS n FROM paper_exit_reviews WHERE verdict = 'sell'`).get() as { n: number }).n;
  const decisionFor = (id: string) => db.prepare(`SELECT reason FROM decisions WHERE item_id = ?`).get(id) as { reason: string } | undefined;

  it('exit disabled (deps.exit undefined): no exit review, entry unchanged', async () => {
    heldYes();
    const spy = vi.spyOn(exitPipelineModule, 'runExitReview');
    await runDecisionPipeline(makeItem(), { ...deps, exit: undefined });
    expect(spy).not.toHaveBeenCalled();
    expect(parseCalls).toHaveLength(0);
    expect(decisionFor('news-1')).toBeDefined();
  });

  it('exit enabled: reviews the held position AND runs the entry path, sharing one gate call', async () => {
    heldYes();
    await runDecisionPipeline(makeItem(), deps);
    expect(sellReviews()).toBe(1);
    expect(decideModule.decideTrade).toHaveBeenCalled();
    expect(gateModule.runGate).toHaveBeenCalledTimes(1);
  });

  it('is not blocked by the entry kill switch', async () => {
    heldYes();
    process.env.EXECUTOR_TRADING_HALTED = 'true';
    await runDecisionPipeline(makeItem(), deps);
    expect(decisionFor('news-1')!.reason).toMatch(/kill switch/);
    expect(decideModule.decideTrade).not.toHaveBeenCalled();
    expect(sellReviews()).toBe(1);
  });

  it('is not blocked by a rumor-rung item that entry skips', async () => {
    heldYes();
    await runDecisionPipeline(makeItem({ trust_tier: 5, corroborations: 0, story_key: null }), deps);
    expect(decisionFor('news-1')!.reason).toMatch(/rumor/);
    expect(sellReviews()).toBe(1);
  });

  it('does not run when the process is live-capable or not dry-run (re-read per item)', async () => {
    heldYes();
    const spy = vi.spyOn(exitPipelineModule, 'runExitReview');
    process.env.EXECUTOR_LIVE_TRADE = 'KXWTI';
    await runDecisionPipeline(makeItem({ item_id: 'a' }), deps);
    delete process.env.EXECUTOR_LIVE_TRADE;
    delete process.env.KALSHI_DRY_RUN;
    await runDecisionPipeline(makeItem({ item_id: 'b' }), deps);
    expect(spy).not.toHaveBeenCalled();
    expect(parseCalls).toHaveLength(0);
  });

  it('an exit-review failure is logged and never breaks the entry path', async () => {
    heldYes();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(exitPipelineModule, 'runExitReview').mockRejectedValue(new Error('exit boom'));
    await runDecisionPipeline(makeItem(), deps);
    expect(decisionFor('news-1')).toBeDefined();
    expect(err).toHaveBeenCalled();
  });

  it('a redelivered item (already has a decision row) is not reviewed again', async () => {
    heldYes();
    await runDecisionPipeline(makeItem(), deps);
    const before = parseCalls.length;
    await runDecisionPipeline(makeItem(), deps);
    expect(parseCalls.length).toBe(before);
  });

  it('after a sell trigger the entry path does not re-buy the same market on paper', async () => {
    const p = heldYes();
    recordExitReview(db, { trade: 'kxwti', itemId: 'older', positionId: p, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null });
    // Pin what sizing proposes so the test does not depend on the ladder maths: a NO buy on T-94.
    vi.spyOn(sizingModule, 'evaluateSizing').mockReturnValue({
      wouldTrade: true, marketTicker: 'T-94', side: 'no', contracts: 2, entryPriceCents: 51, notionalCents: 102, edgeCents: 19, reason: 'mock',
    });
    await runDecisionPipeline(makeItem({ item_id: 'news-9' }), { ...deps, exit: undefined });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_positions`).get() as { n: number }).n).toBe(1); // no second position
    expect(decisionFor('news-9')!.reason).toMatch(/exit trigger already fired on T-94/);
  });

  it('a market with no sell trigger is still bought on paper (the block is specific)', async () => {
    heldYes(); // position on T-94 but no sell review
    vi.spyOn(sizingModule, 'evaluateSizing').mockReturnValue({
      wouldTrade: true, marketTicker: 'T-94', side: 'no', contracts: 2, entryPriceCents: 51, notionalCents: 102, edgeCents: 19, reason: 'mock',
    });
    await runDecisionPipeline(makeItem({ item_id: 'news-10' }), { ...deps, exit: undefined });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM paper_positions`).get() as { n: number }).n).toBe(2);
  });
});
