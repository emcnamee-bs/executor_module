// test/decide/decideMulti.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import type { BandMarket } from '../../src/decide/kalshi.js';
import { checkMultiMoves, decideMulti, isotonicIncreasing, MULTI_MAX_MOVES } from '../../src/decide/decideMulti.js';

const mk = (ticker: string, label: string, bid: number | null, ask: number | null, over: Partial<BandMarket> = {}): BandMarket => ({
  ticker, label, floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active',
  yesBidCents: bid, yesAskCents: ask, yesAskSizeContracts: 50, yesBidSizeContracts: 50, ...over,
});
// mids 60 / 30 / 10
const fed = [mk('F-HOLD', 'Hold', 59, 61), mk('F-CUT', 'Cut 25bps', 29, 31), mk('F-HIKE', 'Hike 25bps', 9, 11)];
const ladder = [mk('L-1', 'Before Mar', 19, 21), mk('L-2', 'Before Jun', 39, 41), mk('L-3', 'Before Dec', 59, 61)];
const mv = (market: string, shift: number, confidence = 0.8) => ({ market, shift, confidence });

describe('isotonicIncreasing', () => {
  it('pools violating neighbours into their average', () => {
    expect(isotonicIncreasing([10, 30, 20, 40])).toEqual([10, 25, 25, 40]);
    expect(isotonicIncreasing([5, 6, 7])).toEqual([5, 6, 7]);
    expect(isotonicIncreasing([9, 3])).toEqual([6, 6]);
    expect(isotonicIncreasing([])).toEqual([]);
  });
});

describe('checkMultiMoves: shape rules (any group)', () => {
  it('accepts an empty list', () => {
    expect(checkMultiMoves([], fed, 'independent')).toEqual({ ok: true, moves: [] });
  });
  it('rejects a non-array', () => {
    expect(checkMultiMoves({}, fed, 'independent')).toMatchObject({ ok: false });
  });
  it('rejects more than the maximum number of moves', () => {
    const many = Array.from({ length: MULTI_MAX_MOVES + 1 }, (_, i) => mv(`M${i}`, 1));
    const markets = many.map((m) => mk(m.market, m.market, 40, 42));
    expect(checkMultiMoves(many, markets, 'independent')).toMatchObject({ ok: false, reason: expect.stringMatching(/at most 4/) });
  });
  it('rejects an unknown market', () => {
    expect(checkMultiMoves([mv('NOPE', 3)], fed, 'independent')).toMatchObject({ ok: false, reason: expect.stringMatching(/NOPE.*not an open, quoted market/) });
  });
  it('rejects a market with no two-sided quote or that is not active', () => {
    const markets = [mk('A', 'A', null, 50), mk('B', 'B', 40, 42, { status: 'closed' }), mk('C', 'C', 40, 42)];
    expect(checkMultiMoves([mv('A', 3)], markets, 'independent')).toMatchObject({ ok: false });
    expect(checkMultiMoves([mv('B', 3)], markets, 'independent')).toMatchObject({ ok: false });
  });
  it('rejects non-object entries', () => {
    for (const bad of [[null], [3], [[1, 2]], ['x']]) {
      expect(checkMultiMoves(bad, fed, 'independent')).toMatchObject({ ok: false });
    }
  });
  it('rejects a duplicate market', () => {
    expect(checkMultiMoves([mv('F-HOLD', 3), mv('F-HOLD', -3)], fed, 'independent')).toMatchObject({ ok: false, reason: expect.stringMatching(/twice/) });
  });
  it('rejects a non-finite or out-of-range shift and a bad confidence', () => {
    expect(checkMultiMoves([mv('F-HOLD', Number.NaN)], fed, 'independent')).toMatchObject({ ok: false });
    expect(checkMultiMoves([mv('F-HOLD', 101)], fed, 'independent')).toMatchObject({ ok: false });
    expect(checkMultiMoves([mv('F-HOLD', 3, 1.5)], fed, 'independent')).toMatchObject({ ok: false });
    expect(checkMultiMoves([mv('F-HOLD', 3, -0.1)], fed, 'independent')).toMatchObject({ ok: false });
    expect(checkMultiMoves([{ market: 'F-HOLD', shift: '3', confidence: 0.5 }], fed, 'independent')).toMatchObject({ ok: false });
  });
  it('drops zero-shift moves', () => {
    expect(checkMultiMoves([mv('F-HOLD', 0), mv('F-CUT', 4)], fed, 'independent')).toEqual({ ok: true, moves: [mv('F-CUT', 4)] });
  });
});

describe('checkMultiMoves: group rules', () => {
  it('independent: any shifts are fine', () => {
    expect(checkMultiMoves([mv('F-HOLD', 9), mv('F-CUT', 9)], fed, 'independent')).toMatchObject({ ok: true });
  });
  it('exclusive: accepts shifts that net to within 5 points of zero', () => {
    expect(checkMultiMoves([mv('F-HOLD', -8), mv('F-CUT', 6), mv('F-HIKE', 3)], fed, 'exclusive')).toMatchObject({ ok: true });
    expect(checkMultiMoves([mv('F-HOLD', -5)], fed, 'exclusive')).toMatchObject({ ok: true });
  });
  it('exclusive: decimal shifts that sum to exactly the tolerance are not rejected by float error', () => {
    const four = [mk('X1', 'A', 24, 26), mk('X2', 'B', 24, 26), mk('X3', 'C', 24, 26), mk('X4', 'D', 24, 26)];
    // (the brief's 1.1+1.1+1.1+1.7 happens to sum to exactly 5 in floats; this order does not)
    expect(1.1 + 1.3 + 1.9 + 0.7).toBeGreaterThan(5);
    expect(checkMultiMoves([mv('X1', 1.1), mv('X2', 1.3), mv('X3', 1.9), mv('X4', 0.7)], four, 'exclusive')).toMatchObject({ ok: true });
  });
  it('exclusive: rejects shifts that do not net out, naming the sum', () => {
    const r = checkMultiMoves([mv('F-CUT', 10)], fed, 'exclusive');
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/net to 10/) });
    expect(checkMultiMoves([mv('F-HOLD', -5.1)], fed, 'exclusive')).toMatchObject({ ok: false });
  });
  it('ladder: leaves a consistent answer unchanged', () => {
    expect(checkMultiMoves([mv('L-1', -5), mv('L-3', 3)], ladder, 'ladder')).toEqual({ ok: true, moves: [mv('L-1', -5), mv('L-3', 3)] });
  });
  it('ladder: repairs an answer that would make an earlier date likelier than a later one', () => {
    // L-1 20 -> 50 would exceed L-2 (40) and L-3 (60 stays): pooled with L-2 -> both 45; shift on L-1 becomes +25
    const r = checkMultiMoves([mv('L-1', 30)], ladder, 'ladder');
    expect(r).toEqual({ ok: true, moves: [mv('L-1', 25)] });
  });
  it('ladder: drops a move whose repair would reverse the model direction, keeping the same-sign repaired one', () => {
    // targets 80/30/60 -> L-1 and L-2 pool to 55/55: L-2 would become +15 though the model said -10, so it is dropped; L-1 becomes +35
    const r = checkMultiMoves([mv('L-1', 60), mv('L-2', -10)], ladder, 'ladder');
    expect(r).toEqual({ ok: true, moves: [mv('L-1', 35)] });
  });
  it('ladder: a repair that only shrinks a same-sign move keeps it', () => {
    expect(checkMultiMoves([mv('L-1', 30)], ladder, 'ladder')).toEqual({ ok: true, moves: [mv('L-1', 25)] });
  });
  it('ladder: a repair that clamps at the 1..99 bounds still gives a same-sign shift', () => {
    // 60 + 60 -> clamped to 99 (shift +39); 20 - 60 -> clamped to 1 (shift -19)
    expect(checkMultiMoves([mv('L-3', 60)], ladder, 'ladder')).toEqual({ ok: true, moves: [mv('L-3', 39)] });
    expect(checkMultiMoves([mv('L-1', -60)], ladder, 'ladder')).toEqual({ ok: true, moves: [mv('L-1', -19)] });
  });
  it('ladder: orders markets by current YES mid, not by the order given', () => {
    const shuffled = [ladder[2], ladder[0], ladder[1]];
    expect(checkMultiMoves([mv('L-1', 30)], shuffled, 'ladder')).toEqual({ ok: true, moves: [mv('L-1', 25)] });
  });
});

describe('decideMulti', () => {
  let dir: string;
  let db: Database.Database;
  let calls: any[];
  const profileRoot = mkdtempSync(path.join(tmpdir(), 'decidemulti-profile-'));
  writeProfile(profileRoot, 'kxfeddecision', { profile: { seriesTicker: 'KXFEDDECISION', marketStructure: 'multi', outcomeGroup: 'exclusive', maxMagnitude: 25, magnitudeUnit: 'bps' } });
  const loaded = loadProfile('kxfeddecision', profileRoot);
  const clientReturning = (parsed: unknown): Anthropic =>
    ({
      messages: {
        parse: async (p: unknown) => {
          calls.push(p);
          return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 5 } };
        },
      },
    }) as unknown as Anthropic;
  const ctx = () => ({
    loaded, itemId: 'news-1', articleText: 'The Fed signals a cut.', excerptSource: 'snippet' as const, rung: 'confirmed' as const,
    tripwireHit: false, triageReason: 'meaningful', markets: fed, group: 'exclusive' as const,
  });

  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'decidemulti-')); db = openLedger(path.join(dir, 'l.db')); calls = []; });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const lastCall = () => db.prepare(`SELECT stage, verdict, reasoning FROM ai_calls ORDER BY id DESC LIMIT 1`).get() as any;

  it('returns the validated moves and logs a decide_multi call', async () => {
    const out = await decideMulti(clientReturning({ moves: [mv('F-HOLD', -8), mv('F-CUT', 8)], reasoning: 'cut is likelier' }), db, ctx());
    expect(out).toEqual({ shouldTrade: true, moves: [mv('F-HOLD', -8), mv('F-CUT', 8)], reasoning: 'cut is likelier' });
    expect(lastCall()).toMatchObject({ stage: 'decide_multi', verdict: 'moves:2' });
  });

  it('shows the model each market by label with its YES quote, and states the group rule', async () => {
    await decideMulti(clientReturning({ moves: [], reasoning: 'nothing' }), db, ctx());
    const sent = calls[0];
    expect(sent.messages[0].content).toMatch(/F-CUT \| Cut 25bps \| YES bid 29c \/ ask 31c/);
    expect(sent.system).toMatch(/exactly one/i);
  });

  it('no moves means no trade, with the model reasoning', async () => {
    const out = await decideMulti(clientReturning({ moves: [], reasoning: 'already priced in' }), db, ctx());
    expect(out).toEqual({ shouldTrade: false, moves: [], reasoning: 'already priced in' });
  });

  it('an invalid answer is a no-trade that says why, and the call is logged as invalid', async () => {
    const out = await decideMulti(clientReturning({ moves: [mv('F-CUT', 20)], reasoning: 'big cut' }), db, ctx());
    expect(out.shouldTrade).toBe(false);
    expect(out.moves).toEqual([]);
    expect(out.reasoning).toMatch(/^invalid multi answer: .*net to 20/);
    expect(lastCall().verdict).toMatch(/^invalid:/);
  });

  it('a malformed answer (no reasoning) is a no-trade, not an exception', async () => {
    const out = await decideMulti(clientReturning({ moves: [] }), db, ctx());
    expect(out.shouldTrade).toBe(false);
    expect(out.reasoning).toMatch(/^invalid multi answer:/);
  });

  it('an API failure still throws, like decideTrade', async () => {
    const failing = { messages: { parse: async () => { throw new Error('overloaded'); } } } as unknown as Anthropic;
    await expect(decideMulti(failing, db, ctx())).rejects.toThrow(/overloaded/);
  });
});
