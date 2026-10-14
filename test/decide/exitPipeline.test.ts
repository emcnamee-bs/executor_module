// test/decide/exitPipeline.test.ts
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
import { runExitReview, type ExitReviewDeps } from '../../src/decide/exitPipeline.js';
import type { PreparedItem } from '../../src/decide/prepare.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import { thresholdBands, makeItem, thr } from '../paper/exitFixtures.js';

const pass: PreparedItem = { articleText: 'Title: x', excerptSource: 'snippet', tripwireHit: false, gate: { kind: 'pass', reason: 'relevant' } };

describe('runExitReview', () => {
  let dir: string;
  let db: Database.Database;
  let parseCalls: any[];
  let modelAnswer: () => unknown;
  let alerts: string[];
  let ladderCalls: string[];
  let deps: ExitReviewDeps;

  const adverse = { shift: -2, confidence: 1, reason: 'sanctions waiver is bearish' };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exitpipe-'));
    db = openLedger(path.join(dir, 'l.db'));
    writeProfile(dir, 'kxwti', { profile: { seriesTicker: 'KXWTI', marketStructure: 'threshold', maxMagnitude: 10, magnitudeUnit: 'USD/bbl' } });
    parseCalls = [];
    alerts = [];
    ladderCalls = [];
    modelAnswer = () => adverse;
    const client = {
      messages: {
        parse: async (p: unknown) => {
          parseCalls.push(p);
          const out = modelAnswer();
          if (out instanceof Error) throw out;
          return { stop_reason: 'end_turn', parsed_output: out, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 500, output_tokens: 50 } };
        },
      },
    } as unknown as Anthropic;
    deps = {
      anthropicClient: client, db, profile: loadProfile('kxwti', dir),
      fetchLadderForEvent: async (event: string): Promise<ActiveLadder> => { ladderCalls.push(event); return { eventTicker: event, strikeDate: null, bands: thresholdBands(1) }; },
      fetchTrajectory: async () => [{ minutesAgo: 5, markCents: 50 }, { minutesAgo: 15, markCents: 50 }, { minutesAgo: 60, markCents: 50 }],
      alert: (m) => alerts.push(m),
    };
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const position = (itemId: string, over: Record<string, unknown> = {}) =>
    recordPaperPosition(db, {
      trade: 'kxwti', itemId, structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-94', side: 'yes', contracts: 4,
      entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]', ...over,
    });
  const reviews = () => db.prepare(`SELECT item_id, position_id, verdict, verdict_reason, shift, confidence, lag_json FROM paper_exit_reviews ORDER BY id`).all() as any[];
  const exits = () => db.prepare(`SELECT status, contracts, price_cents FROM paper_exits ORDER BY id`).all();
  const prepared = (p: PreparedItem = pass) => async () => p;

  it('does nothing and makes no model call when no position is open', async () => {
    await runExitReview(makeItem(), deps, prepared());
    expect(parseCalls).toHaveLength(0);
    expect(reviews()).toHaveLength(0);
  });

  it('an adverse item on a held position records a sell review, fills at the bid and closes the position', async () => {
    const p = position('p1');
    const fills: any[] = [];
    await runExitReview(makeItem(), { ...deps, onFill: (i) => fills.push(i) }, prepared());
    expect(parseCalls).toHaveLength(1);
    const [r] = reviews();
    expect(r).toMatchObject({ item_id: 'news-1', position_id: p, verdict: 'sell', shift: -2, confidence: 1 });
    expect(exits()).toEqual([{ status: 'filled', contracts: 4, price_cents: 49 }]);
    expect(db.prepare(`SELECT settled_at IS NOT NULL AS closed, result, pnl_cents FROM paper_positions WHERE id = ?`).get(p)).toEqual({ closed: 1, result: null, pnl_cents: -4 });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ positionId: p, contracts: 4, priceCents: 49, remaining: 0 });
    const lag = JSON.parse(r.lag_json);
    expect(lag).toMatchObject({
      sourcePublishTs: '2026-10-12T01:00:05Z', eventTime: '2026-10-12T01:00:00Z', firstSeenTs: '2026-10-12T01:00:20Z',
      emittedTs: '2026-10-12T01:00:21Z', outcome: 'filled',
    });
    for (const k of ['reviewStartedAt', 'modelReturnedAt', 'firstSellAttemptAt', 'fillAt']) expect(typeof lag[k]).toBe('string');
  });

  it('a mild item records a hold review and sells nothing', async () => {
    position('p1');
    modelAnswer = () => ({ shift: -0.01, confidence: 0.3, reason: 'barely relevant' });
    await runExitReview(makeItem(), deps, prepared());
    expect(reviews().map((r) => r.verdict)).toEqual(['hold']);
    expect(exits()).toEqual([]);
  });

  it('a favorable item holds', async () => {
    position('p1');
    modelAnswer = () => ({ shift: 2, confidence: 1, reason: 'bullish' });
    await runExitReview(makeItem(), deps, prepared());
    expect(reviews().map((r) => r.verdict)).toEqual(['hold']);
  });

  it('does not review when the gate did not pass', async () => {
    position('p1');
    await runExitReview(makeItem(), deps, prepared({ ...pass, gate: { kind: 'irrelevant', reason: 'no' } }));
    await runExitReview(makeItem({ item_id: 'news-2' }), deps, prepared({ ...pass, gate: { kind: 'error', reason: 'timeout' } }));
    expect(parseCalls).toHaveLength(0);
    expect(reviews()).toHaveLength(0);
  });

  it('a redelivered item is not reviewed or sold twice', async () => {
    position('p1');
    modelAnswer = () => ({ shift: -0.01, confidence: 0.3, reason: 'meh' });
    await runExitReview(makeItem(), deps, prepared());
    await runExitReview(makeItem(), deps, prepared());
    expect(parseCalls).toHaveLength(1);
    expect(reviews()).toHaveLength(1);
  });

  it('a position that already has a sell trigger is not reviewed again (the timer finishes it)', async () => {
    const p = position('p1');
    recordExitReview(db, { trade: 'kxwti', itemId: 'older', positionId: p, shift: -2, confidence: 1, reason: 'r', midCents: 50, fairAfterCents: 30, lossCents: 20, exitCostCents: 1, verdict: 'sell', verdictReason: 'v', lagJson: null });
    await runExitReview(makeItem(), deps, prepared());
    expect(parseCalls).toHaveLength(0);
  });

  it('fetches the ladder of each position\'s OWN event, once per event', async () => {
    position('p1', { eventTicker: 'KXWTI-OLD', marketTicker: 'T-94' });
    position('p2', { eventTicker: 'KXWTI-NEW', marketTicker: 'T-94' });
    position('p3', { eventTicker: 'KXWTI-NEW', marketTicker: 'T-92' });
    modelAnswer = () => ({ shift: 0, confidence: 0.1, reason: 'noise' });
    await runExitReview(makeItem(), deps, prepared());
    expect(ladderCalls.sort()).toEqual(['KXWTI-NEW', 'KXWTI-OLD']);
    expect(reviews()).toHaveLength(3);
  });

  it('a model error writes an error review, alerts once, and still reviews the other positions', async () => {
    position('p1');
    position('p2', { marketTicker: 'T-92' });
    let n = 0;
    modelAnswer = () => (n++ === 0 ? new Error('API 529 overloaded') : { shift: 0, confidence: 0.1, reason: 'noise' });
    await runExitReview(makeItem(), deps, prepared());
    expect(reviews().map((r) => r.verdict)).toEqual(['error', 'hold']);
    expect(reviews()[0].verdict_reason).toMatch(/529/);
    expect(alerts).toHaveLength(1);
    expect(exits()).toEqual([]);
  });

  it('an invalid model answer is an error review, never a sell', async () => {
    position('p1');
    modelAnswer = () => ({ shift: 500, confidence: 1, reason: 'absurd' });
    await runExitReview(makeItem(), deps, prepared());
    expect(reviews().map((r) => r.verdict)).toEqual(['error']);
    expect(exits()).toEqual([]);
  });

  it('a ladder fetch failure is an error review with an alert and no model call', async () => {
    position('p1');
    await runExitReview(makeItem(), { ...deps, fetchLadderForEvent: async () => { throw new Error('Kalshi 500'); } }, prepared());
    expect(reviews().map((r) => r.verdict)).toEqual(['error']);
    expect(alerts).toHaveLength(1);
    expect(parseCalls).toHaveLength(0);
  });

  it('a failing ladder fetch alerts once per event, not once per position', async () => {
    position('p1');
    position('p2', { marketTicker: 'T-95' });
    const failing = async (): Promise<ActiveLadder> => { throw new Error('Kalshi 500'); };
    await runExitReview(makeItem(), { ...deps, fetchLadderForEvent: failing }, prepared());
    expect(reviews().map((r) => [r.verdict, r.verdict_reason])).toEqual([
      ['error', 'could not fetch the ladder for EV'], ['error', 'could not fetch the ladder for EV'],
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('[EXIT-REVIEW ERROR]');
    expect(alerts[0]).toContain('EV');
    expect(parseCalls).toHaveLength(0);
  });

  it('two positions on two different failing events alert once each', async () => {
    position('p1');
    position('p2', { eventTicker: 'EV2', marketTicker: 'T2-94' });
    await runExitReview(makeItem(), { ...deps, fetchLadderForEvent: async () => { throw new Error('Kalshi 500'); } }, prepared());
    expect(reviews().map((r) => r.verdict)).toEqual(['error', 'error']);
    expect(alerts).toHaveLength(2);
    expect(parseCalls).toHaveLength(0);
  });

  it('a position whose market is no longer open holds without a model call', async () => {
    position('p1', { marketTicker: 'T-GONE' });
    await runExitReview(makeItem(), deps, prepared());
    expect(reviews().map((r) => [r.verdict, r.verdict_reason])).toEqual([['hold', 'market not open (closed or settled)']]);
    expect(parseCalls).toHaveLength(0);
  });

  it('a sell trigger with no bid is recorded as sell and left pending as unsellable', async () => {
    const p = position('p1');
    // a curve market with no bid cannot be priced on the curve, so use a binary position (mid = the quoted ask)
    db.prepare(`UPDATE paper_positions SET structure = 'binary' WHERE id = ?`).run(p);
    const lone = thr(94, 50, 1, { yesBidCents: null, yesAskCents: 30, strikeType: null, floorStrike: null });
    await runExitReview(makeItem(), { ...deps, fetchLadderForEvent: async (e) => ({ eventTicker: e, strikeDate: null, bands: [lone] }) }, prepared());
    expect(reviews().map((r) => r.verdict)).toEqual(['sell']);
    expect(exits()).toEqual([{ status: 'unsellable', contracts: 0, price_cents: null }]);
  });

  it('a multi position is reviewed as a YES-probability shift: mid 50 and shift -30 give fair 20 and a sell', async () => {
    writeProfile(dir, 'kxfeddecision', { profile: { seriesTicker: 'KXFEDDECISION', marketStructure: 'multi', outcomeGroup: 'exclusive', maxMagnitude: 25, magnitudeUnit: 'bps' } });
    const cut = thr(0, 50, 1, { ticker: 'F-CUT', label: 'Cut 25bps', floorStrike: null, strikeType: 'custom' });
    const hold = thr(0, 40, 1, { ticker: 'F-HOLD', label: 'No change', floorStrike: null, strikeType: 'custom' });
    const p = position('p1', { structure: 'multi', marketTicker: 'F-CUT' });
    modelAnswer = () => ({ shift: -30, confidence: 1, reason: 'r' });
    await runExitReview(makeItem(), {
      ...deps, profile: loadProfile('kxfeddecision', dir),
      fetchLadderForEvent: async (e) => ({ eventTicker: e, strikeDate: null, bands: [cut, hold] }),
    }, prepared());
    expect(parseCalls).toHaveLength(1);
    expect(parseCalls[0].messages[0].content).toMatch(/exactly one resolves YES/i);
    expect(db.prepare(`SELECT position_id, verdict, fair_after_cents, mid_cents FROM paper_exit_reviews`).all()).toEqual([
      { position_id: p, verdict: 'sell', fair_after_cents: 20, mid_cents: 50 },
    ]);
  });

  it('uses the configured model and fee', async () => {
    position('p1');
    await runExitReview(makeItem(), { ...deps, model: 'claude-haiku-5-5', exitFeeCents: 50 }, prepared());
    expect(parseCalls[0].model).toBe('claude-haiku-5-5');
    expect(reviews().map((r) => r.verdict)).toEqual(['hold']); // fee 50c beats the 20c loss
  });
});
