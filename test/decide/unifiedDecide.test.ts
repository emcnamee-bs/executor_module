// test/decide/unifiedDecide.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import { positionAwareDecide, validateUnified, unifiedSchema, type UnifiedContext, type UnifiedPositionView } from '../../src/decide/unifiedDecide.js';
import { thresholdBands } from '../paper/exitFixtures.js';
import type { BandMarket } from '../../src/decide/kalshi.js';

const root = mkdtempSync(path.join(tmpdir(), 'unified-profile-'));
writeProfile(root, 'kxwti', { profile: { seriesTicker: 'KXWTI', marketStructure: 'threshold', maxMagnitude: 10, magnitudeUnit: 'USD/bbl' } });
writeProfile(root, 'kxfeddecision', { profile: { seriesTicker: 'KXFEDDECISION', marketStructure: 'multi', outcomeGroup: 'exclusive', maxMagnitude: 25, magnitudeUnit: 'bps' } });
const wti = loadProfile('kxwti', root);
const fed = loadProfile('kxfeddecision', root);

const view = (id: number, over: Partial<UnifiedPositionView> = {}): UnifiedPositionView => ({
  id, marketTicker: 'T-94', label: null, side: 'yes', contracts: 4, remaining: 4, entryPriceCents: 50,
  heldBidCents: 49, heldMidCents: 50, unrealisedCents: -4, trajectory: [{ minutesAgo: 5, markCents: 50 }, { minutesAgo: 15, markCents: 55 }], ...over,
});
const base = (over: Partial<UnifiedContext> = {}): UnifiedContext => ({
  loaded: wti, itemId: 'n1', articleText: 'OPEC cuts output.', excerptSource: 'snippet', tripwireHit: false, sourceTrustTier: 2, publishedAt: null, rung: 'reported',
  markets: thresholdBands(1), activeTickers: thresholdBands(1).map((b) => b.ticker), positions: [view(7)], entryAllowed: true, ...over,
});
const good = (over: Record<string, unknown> = {}) => ({
  assessment: { shift: -2, confidence: 0.8, reason: 'bearish' },
  positions: [{ position_id: 7, action: 'sell', reason: 'loses value' }],
  entry: { action: 'none', reason: 'already holding' }, ...over,
});

describe('validateUnified (threshold trade)', () => {
  it('accepts a complete answer', () => {
    const d = validateUnified(good(), base());
    expect(d.assessment).toEqual({ shift: -2, confidence: 0.8, reason: 'bearish' });
    expect(d.positions.get(7)).toEqual({ action: 'sell', reason: 'loses value' });
    expect(d.entry).toEqual({ action: 'none', reason: 'already holding' });
    expect(d.reasoning).toBe('bearish');
  });
  it('accepts no positions when none are held', () => {
    expect(validateUnified(good({ positions: [] }), base({ positions: [] })).positions.size).toBe(0);
  });
  it('rejects a missing, unknown, duplicated or malformed position recommendation', () => {
    expect(() => validateUnified(good({ positions: [] }), base())).toThrow(/no recommendation for position 7/);
    expect(() => validateUnified(good({ positions: [{ position_id: 99, action: 'hold', reason: 'x' }, { position_id: 7, action: 'hold', reason: 'x' }] }), base())).toThrow(/99/);
    expect(() => validateUnified(good({ positions: [{ position_id: 7, action: 'hold', reason: 'x' }, { position_id: 7, action: 'sell', reason: 'y' }] }), base())).toThrow(/twice/);
    expect(() => validateUnified(good({ positions: [{ position_id: 7, action: 'dump', reason: 'x' }] }), base())).toThrow(/action/);
    expect(() => validateUnified(good({ positions: [{ position_id: 7, action: 'hold', reason: ' ' }] }), base())).toThrow(/reason/);
  });
  it('rejects a bad assessment: non-finite or beyond the ceiling shift, confidence outside 0..1, empty reason', () => {
    expect(() => validateUnified(good({ assessment: { shift: Number.NaN, confidence: 1, reason: 'r' } }), base())).toThrow(/shift/);
    expect(() => validateUnified(good({ assessment: { shift: 11, confidence: 1, reason: 'r' } }), base())).toThrow(/ceiling/);
    expect(() => validateUnified(good({ assessment: { shift: -1, confidence: 1.2, reason: 'r' } }), base())).toThrow(/confidence/);
    expect(() => validateUnified(good({ assessment: { shift: -1, confidence: 0.5, reason: '' } }), base())).toThrow(/reason/);
  });
  it('rejects a bad entry', () => {
    expect(() => validateUnified(good({ entry: { action: 'maybe', reason: 'r' } }), base())).toThrow(/entry/);
    expect(() => validateUnified(good({ entry: { action: 'buy', reason: '' } }), base())).toThrow(/entry/);
    expect(() => validateUnified('nope', base())).toThrow(/shape/);
  });
  it('forces entry to none when entry is not available', () => {
    const d = validateUnified(good({ entry: { action: 'buy', reason: 'cheap' } }), base({ entryAllowed: false }));
    expect(d.entry).toEqual({ action: 'none', reason: 'entry is not available for this item' });
  });
});

describe('validateUnified (multi trade)', () => {
  const mk = (ticker: string, label: string, bid: number, ask: number): BandMarket => ({
    ticker, label, floorStrike: null, capStrike: null, strikeType: 'custom', status: 'active', yesBidCents: bid, yesAskCents: ask, yesAskSizeContracts: 50, yesBidSizeContracts: 50,
  });
  const active = [mk('F-HOLD', 'Hold', 59, 61), mk('F-CUT', 'Cut 25bps', 29, 31)];
  const old = mk('OLD-X', 'Old market', 39, 41);
  const ctx = (over: Partial<UnifiedContext> = {}) => base({ loaded: fed, markets: [...active, old], activeTickers: active.map((m) => m.ticker), positions: [view(3, { marketTicker: 'OLD-X', label: 'Old market' })], ...over });
  const answer = (moves: unknown[], over: Record<string, unknown> = {}) => ({
    moves, reasoning: 'cut likelier', positions: [{ position_id: 3, action: 'hold', reason: 'unaffected' }], entry: { action: 'buy', reason: 'cut cheap' }, ...over,
  });
  const mv = (market: string, shift: number, confidence = 0.8) => ({ market, shift, confidence });

  it('applies the exclusive rule to the active event only, and allows a move on a held market of another event', () => {
    const d = validateUnified(answer([mv('F-CUT', 8), mv('F-HOLD', -8), mv('OLD-X', -15)]), ctx());
    expect(d.assessment).toBeNull();
    expect(d.moves.map((m) => m.market).sort()).toEqual(['F-CUT', 'F-HOLD', 'OLD-X']);
    expect(d.reasoning).toBe('cut likelier');
  });
  it('rejects an unbalanced exclusive answer, an unknown market and a move missing its reasoning', () => {
    expect(() => validateUnified(answer([mv('F-CUT', 20)]), ctx())).toThrow(/net to 20/);
    expect(() => validateUnified(answer([mv('NOPE', 3)]), ctx())).toThrow(/NOPE/);
    expect(() => validateUnified(answer([mv('F-CUT', 3), mv('F-HOLD', -3)], { reasoning: '' }), ctx())).toThrow(/reasoning/);
  });
});

describe('unifiedSchema', () => {
  it('has assessment for single-quantity trades and moves for multi trades, always positions and entry', () => {
    const single = unifiedSchema(false) as any;
    const multi = unifiedSchema(true) as any;
    expect(Object.keys(single.properties).sort()).toEqual(['assessment', 'entry', 'positions']);
    expect(Object.keys(multi.properties).sort()).toEqual(['entry', 'moves', 'positions', 'reasoning']);
    expect(single.additionalProperties).toBe(false);
  });
});

describe('positionAwareDecide', () => {
  let dir: string;
  let db: Database.Database;
  let calls: any[];
  const clientReturning = (parsed: unknown): Anthropic =>
    ({ messages: { parse: async (p: unknown) => { calls.push(p); return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 20, output_tokens: 9 } }; } } }) as unknown as Anthropic;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'unified-')); db = openLedger(path.join(dir, 'l.db')); calls = []; });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const lastCall = () => db.prepare(`SELECT stage, verdict, reasoning FROM ai_calls ORDER BY id DESC LIMIT 1`).get() as any;

  it('makes ONE decide_unified call and returns the validated decision', async () => {
    const d = await positionAwareDecide(clientReturning(good()), db, base());
    expect(calls).toHaveLength(1);
    expect(d.positions.get(7)!.action).toBe('sell');
    expect(lastCall()).toMatchObject({ stage: 'decide_unified', verdict: 'none sells:1 holds:0', reasoning: 'bearish' });
  });

  it('shows the model the positions with their trajectory, the markets, and the rules', async () => {
    await positionAwareDecide(clientReturning(good()), db, base());
    const user: string = calls[0].messages[0].content;
    expect(user).toMatch(/position_id=7: YES on T-94/);
    expect(user).toMatch(/4 of 4 contracts, bought at 50c/);
    expect(user).toMatch(/5 min ago: 50c; 15 min ago: 55c/);
    expect(user).toMatch(/T-94 \|/);
    expect(user).toMatch(/Entry is available: yes/);
    const system: string = calls[0].system;
    expect(system).toMatch(/code, not you/i);
    expect(system).toMatch(/2%/);
  });

  it('says so when nothing is held and when entry is unavailable', async () => {
    await positionAwareDecide(clientReturning(good({ positions: [] })), db, base({ positions: [], entryAllowed: false }));
    const user: string = calls[0].messages[0].content;
    expect(user).toMatch(/Positions we hold on this trade: none/);
    expect(user).toMatch(/Entry is available: no/);
  });

  it('an invalid answer throws and is logged as invalid', async () => {
    await expect(positionAwareDecide(clientReturning(good({ positions: [] })), db, base())).rejects.toThrow(/no recommendation/);
    expect(lastCall().verdict).toMatch(/^invalid:/);
  });

  it('an API failure throws', async () => {
    const failing = { messages: { parse: async () => { throw new Error('overloaded'); } } } as unknown as Anthropic;
    await expect(positionAwareDecide(failing, db, base())).rejects.toThrow(/overloaded/);
  });
});
