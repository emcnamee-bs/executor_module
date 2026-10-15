// test/decide/periodCheck.test.ts
//
// The entry period check: a buy needs period_matches === true (the 2026-10-14 CPI trades bought October-CPI YES on
// the September print). Paper-only for classic decide; always on for multi and unified, which are paper-only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import { periodRule, readPeriod, periodMismatchReason, marketEventLine } from '../../src/decide/periodCheck.js';
import { fetchActiveLadder } from '../../src/decide/kalshi.js';
import { decideTrade, validateDecideOutput, buildDecideSystem } from '../../src/decide/decide.js';
import { decideMulti, buildMultiSystem } from '../../src/decide/decideMulti.js';
import { validateUnified, unifiedSchema, buildUnifiedSystem, positionAwareDecide, type UnifiedContext } from '../../src/decide/unifiedDecide.js';
import { thresholdBands } from '../paper/exitFixtures.js';
import type { BandMarket } from '../../src/decide/kalshi.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'period-profile-'));
writeProfile(root, 'kxcpi', { profile: { seriesTicker: 'KXCPI', marketStructure: 'threshold', maxMagnitude: 1, magnitudeUnit: 'pct' } });
writeProfile(root, 'kxfeddecision', { profile: { seriesTicker: 'KXFEDDECISION', marketStructure: 'multi', outcomeGroup: 'exclusive', maxMagnitude: 25, magnitudeUnit: 'bps' } });
const cpi = loadProfile('kxcpi', root);
const fed = loadProfile('kxfeddecision', root);

const base = (over: Record<string, unknown> = {}) => ({ direction: 'up', magnitude_pts: 0.4, should_trade: true, reasoning: 'hot print', ...over });

describe('readPeriod / periodRule', () => {
  it('only a literal true counts', () => {
    expect(readPeriod({ period_matches: true, period_note: ' same month ' })).toEqual({ ok: true, note: 'same month' });
    for (const bad of [false, 'true', 1, undefined, null]) expect(readPeriod({ period_matches: bad }).ok).toBe(false);
    expect(readPeriod({ period_matches: true }).note).toBe('');
  });
  it('the mismatch reason carries the model note, or a default', () => {
    expect(periodMismatchReason({ ok: false, note: 'September print, market is October' })).toBe('period mismatch, not entering: September print, market is October');
    expect(periodMismatchReason({ ok: false, note: '' })).toMatch(/did not confirm/);
  });
  it('the prompt names the market and gives the September/October example', () => {
    const rule = periodRule(cpi.profile);
    expect(rule).toContain(cpi.profile.title);
    expect(rule).toContain(cpi.profile.settlement);
    expect(rule).toMatch(/September CPI report for an October CPI market/);
  });
});

describe('the live event is named to the model (a generic profile cannot say which month it trades)', () => {
  it('marketEventLine formats ticker and Kalshi title, and tolerates no title', () => {
    expect(marketEventLine({ eventTicker: 'KXCPI-26OCT', eventTitle: 'CPI in October' })).toBe('Market event: KXCPI-26OCT (CPI in October)');
    expect(marketEventLine({ eventTicker: 'KXCPI-26OCT' })).toBe('Market event: KXCPI-26OCT');
  });
  it('the rule tells the model that the live event governs when the description is generic', () => {
    expect(periodRule(cpi.profile)).toMatch(/KXCPI-26OCT: CPI in October.*THAT event's period is the one that counts/s);
  });
  it('fetchActiveLadder carries Kalshi\'s event title, and omits the field when Kalshi sends none', async () => {
    const respond = (events: unknown[]) => async (url: string) =>
      new Response(JSON.stringify(String(url).includes('/events?') ? { events } : { markets: [] }), { status: 200 });
    vi.stubGlobal('fetch', respond([{ event_ticker: 'KXCPI-26OCT', strike_date: null, title: ' CPI in October ' }]));
    expect(await fetchActiveLadder('KXCPI')).toMatchObject({ eventTicker: 'KXCPI-26OCT', eventTitle: 'CPI in October' });
    vi.stubGlobal('fetch', respond([{ event_ticker: 'KXCPI-26OCT', strike_date: null }]));
    expect(await fetchActiveLadder('KXCPI')).not.toHaveProperty('eventTitle');
    vi.unstubAllGlobals();
  });
  it('all three entry prompts carry the line in the user message', async () => {
    const line = 'Market event: KXCPI-26OCT (CPI in October)';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'period-line-'));
    const db = openLedger(path.join(dir, 'l.db'));
    const capture = (parsed: unknown) => {
      const calls: any[] = [];
      const client = { messages: { parse: async (p: unknown) => { calls.push(p); return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }; } } } as unknown as Anthropic;
      return { client, calls };
    };
    try {
      const c1 = capture({ direction: 'up', magnitude_pts: 0.1, should_trade: false, reasoning: 'r', period_matches: true, period_note: 'n' });
      await decideTrade(c1.client, db, { loaded: cpi, itemId: 'a', articleText: 'x', excerptSource: 'snippet', rung: 'reported', tripwireHit: false, triageReason: null, periodCheck: true, marketEvent: line });
      expect(c1.calls[0].messages[0].content).toContain(line);
      const c1b = capture({ direction: 'up', magnitude_pts: 0.1, should_trade: false, reasoning: 'r' });
      await decideTrade(c1b.client, db, { loaded: cpi, itemId: 'b', articleText: 'x', excerptSource: 'snippet', rung: 'reported', tripwireHit: false, triageReason: null, marketEvent: line });
      expect(c1b.calls[0].messages[0].content).not.toContain(line); // live unit: no period check, no line

      const c2 = capture({ moves: [], reasoning: 'r', period_matches: true, period_note: 'n' });
      await decideMulti(c2.client, db, { loaded: fed, itemId: 'c', articleText: 'x', excerptSource: 'snippet', rung: 'confirmed', tripwireHit: false, triageReason: null, markets: [], group: 'exclusive', marketEvent: line });
      expect(c2.calls[0].messages[0].content).toContain(line);

      const c3 = capture({ assessment: { shift: 0, confidence: 0.1, reason: 'r' }, positions: [], entry: { action: 'none', reason: 'r', period_matches: true, period_note: 'n' } });
      await positionAwareDecide(c3.client, db, {
        loaded: cpi, itemId: 'd', articleText: 'x', excerptSource: 'snippet', tripwireHit: false, sourceTrustTier: 2, publishedAt: null, rung: 'reported',
        markets: thresholdBands(1), activeTickers: thresholdBands(1).map((b) => b.ticker), positions: [], entryAllowed: true, marketEvent: line,
      });
      expect(c3.calls[0].messages[0].content).toContain(line);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('classic decide', () => {
  it('without periodCheck (the live unit) nothing changes: no fields needed, no prompt text', () => {
    expect(validateDecideOutput(base()).shouldTrade).toBe(true);
    expect(buildDecideSystem(cpi)).not.toMatch(/PERIOD CHECK/);
  });
  it('with periodCheck a buy needs period_matches true; a missing or false answer is a no-trade that says why', () => {
    expect(validateDecideOutput(base({ period_matches: true, period_note: 'same' }), 1, true).shouldTrade).toBe(true);
    const missing = validateDecideOutput(base(), 1, true);
    expect(missing.shouldTrade).toBe(false);
    expect(missing.reasoning).toMatch(/^period mismatch, not entering: .*\| hot print$/);
    const wrong = validateDecideOutput(base({ period_matches: false, period_note: 'article is September CPI; market is October' }), 1, true);
    expect(wrong.shouldTrade).toBe(false);
    expect(wrong.reasoning).toContain('article is September CPI; market is October');
    expect(wrong.direction).toBe('up');
    expect(wrong.magnitudePts).toBe(0.4);
  });
  it('a no-trade stays a no-trade and keeps its own reasoning', () => {
    const r = validateDecideOutput(base({ should_trade: false, period_matches: false }), 1, true);
    expect(r).toMatchObject({ shouldTrade: false, reasoning: 'hot print' });
  });
  it('the prompt carries the period rule only when asked', () => {
    expect(buildDecideSystem(cpi, true)).toMatch(/PERIOD CHECK/);
  });

  describe('decideTrade', () => {
    let dir: string;
    let db: Database.Database;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'period-decide-')); db = openLedger(path.join(dir, 'l.db')); });
    afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const fake = (parsed: unknown) => {
      const calls: any[] = [];
      const client = { messages: { parse: async (p: unknown) => { calls.push(p); return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }; } } } as unknown as Anthropic;
      return { client, calls };
    };
    const ctx = (over = {}) => ({ loaded: cpi, itemId: 'i1', articleText: 'x', excerptSource: 'snippet' as const, rung: 'reported' as const, tripwireHit: false, triageReason: null, ...over });

    it('asks for the period fields only when periodCheck is set, and logs a blocked buy as no-trade', async () => {
      const off = fake(base());
      await decideTrade(off.client, db, ctx());
      expect(off.calls[0].output_config.format.schema.required).not.toContain('period_matches');

      const on = fake(base({ period_matches: false, period_note: 'wrong month' }));
      const r = await decideTrade(on.client, db, ctx({ itemId: 'i2', periodCheck: true }));
      expect(on.calls[0].output_config.format.schema.required).toEqual(expect.arrayContaining(['period_matches', 'period_note']));
      expect(r.shouldTrade).toBe(false);
      const row = db.prepare(`SELECT verdict FROM ai_calls WHERE item_id = 'i2'`).get() as { verdict: string };
      expect(row.verdict).toBe('no-trade');
    });
  });
});

describe('decideMulti', () => {
  let dir: string;
  let db: Database.Database;
  const markets: BandMarket[] = [
    { ticker: 'F-HOLD', floorStrike: null, capStrike: null, strikeType: null, status: 'active', yesAskCents: 62, yesBidCents: 60, yesAskSizeContracts: 300, yesBidSizeContracts: 300 },
    { ticker: 'F-CUT', floorStrike: null, capStrike: null, strikeType: null, status: 'active', yesAskCents: 38, yesBidCents: 36, yesAskSizeContracts: 300, yesBidSizeContracts: 300 },
  ];
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'period-multi-')); db = openLedger(path.join(dir, 'l.db')); });
  afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = (parsed: unknown): Anthropic =>
    ({ messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1, output_tokens: 1 } }) } }) as unknown as Anthropic;
  const ctx = () => ({ loaded: fed, itemId: 'm1', articleText: 'x', excerptSource: 'snippet' as const, rung: 'confirmed' as const, tripwireHit: false, triageReason: null, markets, group: 'exclusive' as const });
  const moves = [{ market: 'F-HOLD', shift: -8, confidence: 0.8 }, { market: 'F-CUT', shift: 8, confidence: 0.8 }];

  it('trades when the period matches', async () => {
    const out = await decideMulti(client({ moves, reasoning: 'r', period_matches: true, period_note: 'same meeting' }), db, ctx());
    expect(out.shouldTrade).toBe(true);
  });
  it('does not trade when the answer is false or absent, and logs period-mismatch', async () => {
    const out = await decideMulti(client({ moves, reasoning: 'cut likelier', period_matches: false, period_note: 'December meeting, not this one' }), db, ctx());
    expect(out.shouldTrade).toBe(false);
    expect(out.moves).toEqual([]);
    expect(out.reasoning).toMatch(/period mismatch.*December meeting.*\| cut likelier/);
    const missing = await decideMulti(client({ moves, reasoning: 'r' }), db, { ...ctx(), itemId: 'm2' });
    expect(missing.shouldTrade).toBe(false);
    const rows = db.prepare(`SELECT verdict FROM ai_calls WHERE stage = 'decide_multi' ORDER BY id`).all() as Array<{ verdict: string }>;
    expect(rows.map((r) => r.verdict)).toEqual(['period-mismatch', 'period-mismatch']);
  });
  it('an empty moves list is unaffected (nothing to block)', async () => {
    const out = await decideMulti(client({ moves: [], reasoning: 'priced in', period_matches: false, period_note: 'x' }), db, ctx());
    expect(out).toEqual({ shouldTrade: false, moves: [], reasoning: 'priced in' });
  });
  it('the system prompt carries the period rule', () => {
    expect(buildMultiSystem(fed, 'exclusive')).toMatch(/PERIOD CHECK/);
  });
});

describe('unified decision', () => {
  const ctx = (over: Partial<UnifiedContext> = {}): UnifiedContext => ({
    loaded: cpi, itemId: 'n1', articleText: 'x', excerptSource: 'snippet', tripwireHit: false, sourceTrustTier: 2, publishedAt: null, rung: 'reported',
    markets: thresholdBands(1), activeTickers: thresholdBands(1).map((b) => b.ticker), positions: [], entryAllowed: true, ...over,
  });
  const answer = (entry: Record<string, unknown>) => ({ assessment: { shift: 0.3, confidence: 0.8, reason: 'hot print' }, positions: [], entry });

  it('a buy with period_matches true stays a buy', () => {
    const d = validateUnified(answer({ action: 'buy', reason: 'cheap', period_matches: true, period_note: 'same month' }), ctx());
    expect(d.entry).toEqual({ action: 'buy', reason: 'cheap' });
  });
  it('a buy with period_matches false or missing becomes none, flagged, with the reason', () => {
    const wrong = validateUnified(answer({ action: 'buy', reason: 'cheap', period_matches: false, period_note: 'September print' }), ctx());
    expect(wrong.entry).toEqual({ action: 'none', reason: 'period mismatch, not entering: September print | cheap', periodBlocked: true });
    const missing = validateUnified(answer({ action: 'buy', reason: 'cheap' }), ctx());
    expect(missing.entry).toMatchObject({ action: 'none', periodBlocked: true });
  });
  it('none is unaffected, and so is an answer when entry is not available', () => {
    const none = validateUnified(answer({ action: 'none', reason: 'nothing', period_matches: false }), ctx());
    expect(none.entry).toEqual({ action: 'none', reason: 'nothing' });
    const off = validateUnified(answer({ action: 'buy', reason: '' }), ctx({ entryAllowed: false }));
    expect(off.entry.action).toBe('none');
  });
  it('the schema requires the fields inside entry and the prompt carries the rule', () => {
    for (const multi of [false, true]) {
      const entry = (unifiedSchema(multi) as any).properties.entry;
      expect(entry.required).toEqual(expect.arrayContaining(['period_matches', 'period_note']));
      expect(entry.properties.period_matches).toEqual({ type: 'boolean' });
    }
    expect(buildUnifiedSystem(cpi)).toMatch(/PERIOD CHECK/);
  });
});
