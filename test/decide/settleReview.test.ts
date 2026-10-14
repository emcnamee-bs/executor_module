// test/decide/settleReview.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordPaperPosition } from '../../src/paper/paper.js';
import { listOpenPaperPositions } from '../../src/paper/exits.js';
import { settleReview, verdictFor } from '../../src/decide/exitPipeline.js';
import { evaluateExit } from '../../src/paper/exitMath.js';
import { thresholdBands, makeItem } from '../paper/exitFixtures.js';

describe('verdictFor', () => {
  const sellMath = { sell: true, reason: 'loss beats cost', midCents: 50, bidCents: 49, fairAfterCents: 30, lossCents: 20, exitCostCents: 1 };
  const holdMath = { ...sellMath, sell: false, reason: 'loss below 2%' };
  it('classic: the rule alone decides', () => {
    expect(verdictFor(sellMath, undefined)).toEqual({ sell: true, reason: 'loss beats cost' });
    expect(verdictFor(holdMath, undefined)).toEqual({ sell: false, reason: 'loss below 2%' });
  });
  it('unified: sells only when both agree, and says why otherwise', () => {
    expect(verdictFor(sellMath, { action: 'sell', reason: 'bad news' })).toMatchObject({ sell: true });
    expect(verdictFor(sellMath, { action: 'hold', reason: 'priced in' })).toMatchObject({ sell: false, reason: expect.stringMatching(/rule says sell.*model recommended hold.*priced in/) });
    expect(verdictFor(holdMath, { action: 'sell', reason: 'scared' })).toMatchObject({ sell: false, reason: expect.stringMatching(/model recommended sell.*rule vetoed.*loss below 2%/) });
    expect(verdictFor(holdMath, { action: 'hold', reason: 'fine' })).toMatchObject({ sell: false });
  });
});

describe('settleReview', () => {
  let dir: string;
  let db: Database.Database;
  const bands = thresholdBands(1);
  const market = bands.find((b) => b.ticker === 'T-94')!;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'settle-'));
    db = openLedger(path.join(dir, 'l.db'));
    recordPaperPosition(db, { trade: 'kxwti', itemId: 'p1', structure: 'threshold', eventTicker: 'EV', marketTicker: 'T-94', side: 'yes', contracts: 4, entryPriceCents: 50, direction: 'up', magnitude: 1, edgeCents: 5, reasoning: 'r', ladderJson: '[]' });
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const run = (shift: number, model?: { action: 'hold' | 'sell'; reason: string }) => {
    const position = listOpenPaperPositions(db)[0];
    // sanity: the rule alone sells at shift -2 and holds at shift 0 on this ladder
    expect(evaluateExit({ structure: 'threshold', side: 'yes', contracts: 4, remaining: 4, entryPriceCents: 50, market, bands, shift: -2, confidence: 1 }).sell).toBe(true);
    settleReview({ db, trade: 'kxwti', item: makeItem(), position, market, bands, review: { shift, confidence: 1, reason: 'model reason' }, reviewStartedAt: 1000, modelReturnedAt: 2000, now: () => 3000, model });
  };
  const review = () => db.prepare(`SELECT verdict, verdict_reason AS why, model_action AS a, decision_mode AS m FROM paper_exit_reviews`).get() as any;
  const fills = () => (db.prepare(`SELECT COUNT(*) AS n FROM paper_exits WHERE status IN ('filled','partial')`).get() as { n: number }).n;

  it('classic: records a sell and fills it, with NULL model columns', () => {
    run(-2);
    expect(review()).toMatchObject({ verdict: 'sell', a: null, m: null });
    expect(fills()).toBe(1);
  });
  it('unified, both agree: sells and fills, recording the recommendation', () => {
    run(-2, { action: 'sell', reason: 'bad news' });
    expect(review()).toMatchObject({ verdict: 'sell', a: 'sell', m: 'unified' });
    expect(fills()).toBe(1);
  });
  it('unified, rule says sell but the model says hold: holds, no fill', () => {
    run(-2, { action: 'hold', reason: 'priced in' });
    expect(review()).toMatchObject({ verdict: 'hold', a: 'hold', m: 'unified', why: expect.stringMatching(/model recommended hold/) });
    expect(fills()).toBe(0);
  });
  it('unified, model says sell but the rule vetoes: holds, no fill', () => {
    run(0, { action: 'sell', reason: 'scared' });
    expect(review()).toMatchObject({ verdict: 'hold', a: 'sell', m: 'unified', why: expect.stringMatching(/rule vetoed/) });
    expect(fills()).toBe(0);
  });
  it('unified, both say hold: holds', () => {
    run(0, { action: 'hold', reason: 'fine' });
    expect(review()).toMatchObject({ verdict: 'hold', a: 'hold' });
  });
});
