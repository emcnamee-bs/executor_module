// test/decide/exitReview.test.ts
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger } from '../../src/decide/ledger.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import {
  reviewForExit, validateExitReview, buildExitSystem, maxAbsShift, BINARY_MAX_SHIFT, type ExitReviewContext,
} from '../../src/decide/exitReview.js';
import { thr } from '../paper/exitFixtures.js';

function withProfile<T>(fn: (loaded: ReturnType<typeof loadProfile>, db: ReturnType<typeof openLedger>) => Promise<T> | T) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exitreview-'));
  const db = openLedger(path.join(dir, 'l.db'));
  writeProfile(dir, 'kxwti', { profile: { seriesTicker: 'KXWTI', marketStructure: 'threshold', maxMagnitude: 10, magnitudeUnit: 'USD/bbl' } });
  return Promise.resolve(fn(loadProfile('kxwti', dir), db)).finally(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const okResponse = (parsed: unknown) => ({
  stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 700, output_tokens: 60 },
});
const fake = (resp: unknown) => {
  const calls: any[] = [];
  const client = { messages: { parse: async (p: unknown) => { calls.push(p); return resp; } } } as unknown as Anthropic;
  return { client, calls };
};
const ctx = (loaded: any, over: Partial<ExitReviewContext> = {}): ExitReviewContext => ({
  loaded, itemId: 'news-1', articleText: 'Title: Sanctions lifted\nExcerpt: ...', excerptSource: 'page', tripwireHit: false,
  sourceTrustTier: 2, publishedAt: '2026-10-12T01:00:05Z',
  position: { marketTicker: 'T-94', side: 'yes', contracts: 4, remaining: 3, entryPriceCents: 50 },
  market: thr(94, 50, 1),
  trajectory: [{ minutesAgo: 5, markCents: 52 }, { minutesAgo: 15, markCents: 55 }, { minutesAgo: 60, markCents: null }],
  ...over,
});

describe('validateExitReview', () => {
  const ok = { shift: -1.5, confidence: 0.7, reason: 'sanctions waiver is bearish' };
  it('accepts a well-formed signed shift', () => {
    expect(validateExitReview(ok, 10)).toEqual({ shift: -1.5, confidence: 0.7, reason: 'sanctions waiver is bearish' });
    expect(validateExitReview({ ...ok, shift: 0, confidence: 0 }, 10).shift).toBe(0);
  });
  it.each([
    ['null', null],
    ['shift above the ceiling', { ...ok, shift: 10.5 }],
    ['shift below minus the ceiling', { ...ok, shift: -10.5 }],
    ['shift as a string', { ...ok, shift: '-1' }],
    ['shift infinite', { ...ok, shift: Infinity }],
    ['confidence above 1', { ...ok, confidence: 1.2 }],
    ['confidence negative', { ...ok, confidence: -0.1 }],
    ['confidence missing', { shift: -1, reason: 'x' }],
    ['empty reason', { ...ok, reason: '  ' }],
  ])('rejects %s', (_name, bad) => {
    expect(() => validateExitReview(bad, 10)).toThrow();
  });
});

describe('maxAbsShift', () => {
  it('is the profile ceiling for curve markets and 100 for binary markets', () => {
    expect(maxAbsShift({ profile: { marketStructure: 'threshold', maxMagnitude: 3 } } as any)).toBe(3);
    expect(maxAbsShift({ profile: { marketStructure: 'binary', maxMagnitude: 3 } } as any)).toBe(BINARY_MAX_SHIFT);
  });
});

describe('reviewForExit (fake client, offline)', () => {
  it('returns the validated shift and logs an exit_review ai_calls row', () =>
    withProfile(async (loaded, db) => {
      const { client, calls } = fake(okResponse({ shift: -2, confidence: 0.6, reason: 'waiver is bearish for WTI' }));
      const r = await reviewForExit(client, db, ctx(loaded));
      expect(r).toEqual({ shift: -2, confidence: 0.6, reason: 'waiver is bearish for WTI' });
      const row = db.prepare('SELECT stage, model, verdict, reasoning FROM ai_calls').get() as any;
      expect(row.stage).toBe('exit_review');
      expect(row.model).toBe('claude-sonnet-5-5');
      expect(row.verdict).toBe('shift:-2 conf:0.6');
      expect(calls[0].model).toBe('claude-sonnet-5-5');
    }));

  it('a model override reaches the API call and the ai_calls row', () =>
    withProfile(async (loaded, db) => {
      const { client, calls } = fake(okResponse({ shift: 0, confidence: 0.1, reason: 'priced in' }));
      await reviewForExit(client, db, ctx(loaded, { model: 'claude-haiku-5-5' }));
      expect(calls[0].model).toBe('claude-haiku-5-5');
      expect((db.prepare('SELECT model FROM ai_calls').get() as any).model).toBe('claude-haiku-5-5');
    }));

  it('puts the position, quotes, trajectory and the untrusted article in the prompt', () =>
    withProfile(async (loaded, db) => {
      const { client, calls } = fake(okResponse({ shift: -1, confidence: 0.5, reason: 'r' }));
      await reviewForExit(client, db, ctx(loaded));
      const user = calls[0].messages[0].content as string;
      expect(user).toContain('Held position: YES on T-94');
      expect(user).toContain('above 94');
      expect(user).toContain('3 of 4 contracts');
      expect(user).toContain('bought at 50c');
      expect(user).toContain('bid 49c / ask 51c');
      expect(user).toContain('5 min ago: 52c');
      expect(user).toContain('15 min ago: 55c');
      expect(user).toContain('60 min ago: unknown');
      expect(user).toContain('Source trust tier: 2');
      expect(user).toContain('<article>');
      const system = calls[0].system as string;
      expect(system).toContain(loaded.profile.decideContext);
      expect(system).toContain('USD/bbl');
      expect(system).toMatch(/untrusted/i);
      expect(system).toMatch(/not already/i);
    }));

  it('warns the model when the injection tripwire fired', () =>
    withProfile(async (loaded, db) => {
      const { client, calls } = fake(okResponse({ shift: 0, confidence: 0, reason: 'r' }));
      await reviewForExit(client, db, ctx(loaded, { tripwireHit: true }));
      expect(calls[0].messages[0].content).toMatch(/instructions addressed to an AI reviewer/);
    }));

  it('an out-of-range answer throws and the audit row says invalid', () =>
    withProfile(async (loaded, db) => {
      const { client } = fake(okResponse({ shift: 99, confidence: 0.5, reason: 'r' }));
      await expect(reviewForExit(client, db, ctx(loaded))).rejects.toThrow(/shift/);
      expect((db.prepare('SELECT verdict FROM ai_calls').get() as any).verdict).toMatch(/^invalid:/);
    }));

  it('binary positions are described by the market ticker and use the probability-point ceiling', () =>
    withProfile(async (loaded, db) => {
      const { client, calls } = fake(okResponse({ shift: -40, confidence: 0.5, reason: 'r' }));
      const binary = { ...loaded, profile: { ...loaded.profile, marketStructure: 'binary' as const } };
      const m = thr(0, 60, 1, { ticker: 'KXRET-27', strikeType: null, floorStrike: null });
      const r = await reviewForExit(client, db, ctx(binary, { market: m, position: { marketTicker: 'KXRET-27', side: 'no', contracts: 1, remaining: 1, entryPriceCents: 40 } }));
      expect(r.shift).toBe(-40);
      expect(calls[0].messages[0].content).toContain('Held position: NO on KXRET-27');
      expect(calls[0].system).toMatch(/percentage points of the YES probability/);
    }));
});

describe('exit review for multi positions', () => {
  const multiProfile = { seriesTicker: 'KXFEDDECISION', marketStructure: 'multi', outcomeGroup: 'exclusive', maxMagnitude: 25, magnitudeUnit: 'bps' };

  it('accepts a shift up to 100 and states it in YES-probability points', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exitmulti-'));
    try {
      writeProfile(dir, 'kxfeddecision', { profile: multiProfile });
      const loaded = loadProfile('kxfeddecision', dir);
      expect(maxAbsShift(loaded)).toBe(100);
      expect(buildExitSystem(loaded)).toMatch(/percentage points of the YES probability/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the market by its label and tells the model the group type', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exitmulti-'));
    const db = openLedger(path.join(dir, 'l.db'));
    try {
      writeProfile(dir, 'kxfeddecision', { profile: multiProfile });
      const loaded = loadProfile('kxfeddecision', dir);
      const { client, calls } = fake(okResponse({ shift: -5, confidence: 0.8, reason: 'r' }));
      const market = thr(0, 30, 1, { ticker: 'F-CUT', label: 'Cut 25bps', floorStrike: null, strikeType: 'custom' });
      await reviewForExit(client, db, ctx(loaded, {
        position: { marketTicker: 'F-CUT', side: 'yes', contracts: 4, remaining: 4, entryPriceCents: 30 }, market, trajectory: [], outcomeGroup: 'exclusive',
      }));
      const text = calls[0].messages[0].content as string;
      expect(text).toMatch(/Cut 25bps/);
      expect(text).toMatch(/exactly one resolves YES/i);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildExitSystem', () => {
  it('states the model never decides to sell', () =>
    withProfile((loaded) => {
      expect(buildExitSystem(loaded)).toMatch(/do not decide whether to sell/i);
    }));
});
