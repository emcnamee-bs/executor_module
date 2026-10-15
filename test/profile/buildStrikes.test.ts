// test/profile/buildStrikes.test.ts
//
// Ladder profiles must not carry strikes (2026-10-14: the gas profile said "strikes around $4.46-$4.56" while the market
// traded $4.16-$4.56; Hormuz said "22 to 75" while live rungs were 15-25). The builder keeps strikes out of the prompt,
// rejects a decideContext that quotes them (the existing retry feeds the error back), and records the range it saw.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { buildTradeProfile, fetchSeriesSpec, quotedStrikeProblem, QUOTED_STRIKES_RE } from '../../src/profile/build.js';
import { loadProfile } from '../../src/profile/profile.js';
import { GOOD_BANK } from './fixtures.js';

const STRIKES = [4.26, 4.28, 4.3, 4.32, 4.34];
const EVENTS = { events: [{ event_ticker: 'KXAAAGASW-26OCT19', strike_date: null, title: 'Gas prices this week' }] };
const MARKETS = {
  markets: STRIKES.map((s) => ({
    ticker: `KXAAAGASW-26OCT19-${s.toFixed(2)}`, strike_type: 'greater', floor_strike: s, cap_strike: null, yes_sub_title: `Above ${s}`,
    rules_primary: `If the AAA average is strictly greater than $${s.toFixed(4)} on Oct 19, 2026, the market resolves to Yes.`,
  })),
};
const fakeFetch = (): typeof fetch =>
  (async (url: string) => new Response(JSON.stringify(String(url).includes('/events?') ? EVENTS : MARKETS), { status: 200 })) as unknown as typeof fetch;

const CLEAN = 'You are assessing a news item for its likely effect on the AAA national average price of regular gasoline; the market resolves Yes if it is above the strike.';
const QUOTING = 'Estimate the effect on the AAA national average, with strikes spaced $0.02 apart around $4.46-$4.56.';

function client(contexts: string[]) {
  const bankUsers: string[] = [];
  let n = 0;
  const c = {
    messages: {
      parse: async (p: any) => {
        const isBank = JSON.stringify(p.output_config.format.schema).includes('magnitudeUnit');
        if (!isBank) {
          const parsed = { keyphrases: Array.from({ length: 200 }, (_, i) => `gas price phrase ${i}`) };
          return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: {} };
        }
        bankUsers.push(p.messages[0].content);
        const parsed = {
          title: 'Will the AAA national average gas price be above the strike on the settlement date?',
          settlement: 'Resolves YES if the AAA national average for regular gasoline is strictly above the strike.',
          decideContext: contexts[Math.min(n++, contexts.length - 1)], magnitudeUnit: 'USD/gal', maxMagnitude: 0.5, bank: GOOD_BANK,
        };
        return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: '{}' }], usage: {} };
      },
    },
  } as unknown as Anthropic;
  return { c, bankUsers, system: () => '' };
}

describe('quotedStrikeProblem', () => {
  it('flags a sentence about strikes that contains a number, in either shape', () => {
    expect(quotedStrikeProblem('Strikes range from 22 to 75 transit calls.', [])).toMatch(/quotes strike values/);
    expect(quotedStrikeProblem(QUOTING, STRIKES)).toMatch(/quotes strike values/);
    expect(quotedStrikeProblem('Resolves Yes above the strike. It was 4.30 yesterday.', STRIKES)).toMatch(/4.3/); // a ladder strike by value
  });
  it('accepts text that talks about the strike without numbers, or has unrelated numbers', () => {
    expect(quotedStrikeProblem(CLEAN, STRIKES)).toBeNull();
    expect(quotedStrikeProblem('Counts calls over Oct 12-18, 2026. The market resolves Yes if the sum is above the strike.', [15, 20, 22])).toBeNull();
  });
  it('exposes the same sentence pattern the refresh script mirrors', () => {
    expect(QUOTED_STRIKES_RE.test('strikes 1 to 5')).toBe(true);
    expect(QUOTED_STRIKES_RE.test('above the strike')).toBe(false);
  });
});

describe('fetchSeriesSpec strikes', () => {
  it('collects every floor/cap strike, ascending and de-duplicated', async () => {
    const spec = await fetchSeriesSpec('KXAAAGASW', fakeFetch());
    expect(spec.strikes).toEqual(STRIKES);
  });
});

describe('buildTradeProfile on a ladder', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-strikes-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = () => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root });

  it('keeps strikes and sample subtitles out of the prompt, and tells the model not to quote strikes', async () => {
    const k = client([CLEAN]);
    await buildTradeProfile(opts(), { client: k.c, fetchImpl: fakeFetch() });
    const user = k.bankUsers[0];
    expect(user).not.toMatch(/"strikes"/);
    expect(user).not.toMatch(/Above 4\.3/); // sample subtitles are dropped for ladder trades
    expect(user).toContain('"sampleSubtitles": []');
  });

  it('rejects a decideContext that quotes strikes, feeds the error back, and accepts the clean retry', async () => {
    const k = client([QUOTING, CLEAN]);
    const { profile } = await buildTradeProfile(opts(), { client: k.c, fetchImpl: fakeFetch() });
    expect(k.bankUsers).toHaveLength(2);
    expect(k.bankUsers[1]).toContain('previous bank was rejected');
    expect(k.bankUsers[1]).toContain('quotes strike values');
    expect(profile.decideContext).toBe(CLEAN);
  });

  it('fails the build, leaving no profile, when the model keeps quoting strikes', async () => {
    const k = client([QUOTING]);
    await expect(buildTradeProfile(opts(), { client: k.c, fetchImpl: fakeFetch() })).rejects.toThrow(/quotes strike values/);
    expect(fs.existsSync(path.join(root, 'trades', 'kxaaagasw'))).toBe(false);
  });

  it('records the strike range it saw in bank.meta.json, and the loader still accepts the profile', async () => {
    const k = client([CLEAN]);
    const { dir } = await buildTradeProfile(opts(), { client: k.c, fetchImpl: fakeFetch(), now: () => new Date('2026-10-14T12:00:00Z') });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'bank.meta.json'), 'utf-8'));
    expect(meta.strikeRange).toEqual({ min: 4.26, max: 4.34, count: 5, eventTicker: 'KXAAAGASW-26OCT19' });
    expect(meta.eventTicker).toBe('KXAAAGASW-26OCT19'); // recorded for every profile, ladder or not
    expect(() => loadProfile('kxaaagasw', path.join(root, 'trades'))).not.toThrow();
  });
});
