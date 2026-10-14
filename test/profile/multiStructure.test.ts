import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { buildTradeProfile, deriveStructure, fallbackOutcomeGroup, resolveOutcomeGroup } from '../../src/profile/build.js';
import { loadProfile } from '../../src/profile/profile.js';
import { GOOD_BANK } from './fixtures.js';

describe('deriveStructure with multi', () => {
  it('custom strikes with several markets are multi', () => {
    expect(deriveStructure(['custom', 'custom', 'custom'], 3)).toBe('multi');
    expect(deriveStructure(['custom', 'custom'], 2)).toBe('multi');
  });
  it('strike-less markets (2 or more) are multi', () => {
    expect(deriveStructure([null, null, null], 3)).toBe('multi');
  });
  it('a lone custom market stays capture, a lone strike-less market stays binary', () => {
    expect(deriveStructure(['custom'], 1)).toBe('capture');
    expect(deriveStructure([null], 1)).toBe('binary');
  });
  it('the existing shapes are unchanged', () => {
    expect(deriveStructure(['between', 'between', 'less'], 3)).toBe('band');
    expect(deriveStructure(['greater', 'greater', 'less'], 3)).toBe('threshold');
    expect(deriveStructure(['greater', null], 2)).toBe('capture');
    expect(deriveStructure([], 0)).toBe('capture');
  });
});

describe('outcome group classification', () => {
  it('falls back to ladder when every subtitle starts with "Before"', () => {
    expect(fallbackOutcomeGroup(['Before Jan 1, 2027', 'before March 2027', 'Before 2028'])).toBe('ladder');
  });
  it('falls back to independent otherwise, and for fewer than two subtitles', () => {
    expect(fallbackOutcomeGroup(['Hike 25bps', 'Hold'])).toBe('independent');
    expect(fallbackOutcomeGroup(['Before Jan 1', 'Hold'])).toBe('independent');
    expect(fallbackOutcomeGroup(['Before Jan 1'])).toBe('independent');
    expect(fallbackOutcomeGroup([])).toBe('independent');
  });
  it('uses the model answer when it is one of the three groups', () => {
    expect(resolveOutcomeGroup('exclusive', ['Before X', 'Before Y'])).toEqual({ group: 'exclusive', source: 'model' });
  });
  it('uses the fallback when the model answer is missing or not a group', () => {
    expect(resolveOutcomeGroup(undefined, ['Before X', 'Before Y'])).toEqual({ group: 'ladder', source: 'fallback' });
    expect(resolveOutcomeGroup('sequence', ['A', 'B'])).toEqual({ group: 'independent', source: 'fallback' });
  });
});

// End-to-end: helpers mirror test/profile/build.test.ts (fake fetch, fake Anthropic client, temp dir).
function fakeFetchFor(markets: any[]): typeof fetch {
  const events = { events: [{ event_ticker: 'KXWHO-26', strike_date: '2026-12-31T00:00:00Z', title: 'Who will win?' }] };
  return (async (url: string) => {
    const body = String(url).includes('/events?') ? events : { markets };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function fakeClientFor(profileExtra: Record<string, unknown>) {
  const profileOut = {
    title: 'Who will win the election?',
    settlement: 'Resolves YES for the candidate who wins the election.',
    decideContext: 'You are assessing a news item for its likely effect on who wins the election, which a Kalshi market resolves on.',
    magnitudeUnit: 'pts', maxMagnitude: 10, bank: GOOD_BANK, ...profileExtra,
  };
  const phrases = Array.from({ length: 200 }, (_, i) => `election phrase ${i}`);
  return {
    messages: {
      parse: async (p: any) => {
        const isBank = JSON.stringify(p.output_config.format.schema).includes('magnitudeUnit');
        const parsed = isBank ? profileOut : { keyphrases: phrases };
        return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: JSON.stringify(parsed) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as unknown as Anthropic;
}

describe('buildTradeProfile writes multi profiles', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = (over = {}) => ({ seriesTicker: 'KXWHO', directSources: [], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });
  const market = (t: string, sub: string) => ({ ticker: t, strike_type: 'custom', yes_sub_title: sub, rules_primary: 'Resolves YES if the named outcome happens.' });

  it('writes marketStructure multi and the model outcomeGroup', async () => {
    const markets = [market('KXWHO-26-A', 'Alice'), market('KXWHO-26-B', 'Bob'), market('KXWHO-26-C', 'Carol')];
    const { profile } = await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'exclusive' }), fetchImpl: fakeFetchFor(markets) });
    expect(profile).toMatchObject({ marketStructure: 'multi', outcomeGroup: 'exclusive' });
    const written = JSON.parse(fs.readFileSync(path.join(root, 'trades', 'kxwho', 'profile.json'), 'utf-8'));
    expect(written).toMatchObject({ marketStructure: 'multi', outcomeGroup: 'exclusive' });
    expect(loadProfile('kxwho', path.join(root, 'trades')).profile).toMatchObject({ marketStructure: 'multi', outcomeGroup: 'exclusive' });
  });

  it('falls back to ladder from the "Before" subtitles when the model omits outcomeGroup', async () => {
    const markets = [market('KXWHO-26-A', 'Before A'), market('KXWHO-26-B', 'Before B')];
    await buildTradeProfile(opts(), { client: fakeClientFor({}), fetchImpl: fakeFetchFor(markets) });
    const written = JSON.parse(fs.readFileSync(path.join(root, 'trades', 'kxwho', 'profile.json'), 'utf-8'));
    expect(written).toMatchObject({ marketStructure: 'multi', outcomeGroup: 'ladder' });
  });

  describe('a rebuild keeps an existing multi profile outcomeGroup', () => {
    const three = () => [market('KXWHO-26-A', 'Alice'), market('KXWHO-26-B', 'Bob'), market('KXWHO-26-C', 'Carol')];
    const profilePath = () => path.join(root, 'trades', 'kxwho', 'profile.json');
    const written = () => JSON.parse(fs.readFileSync(profilePath(), 'utf-8'));
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => warn.mockRestore());
    const warned = (): string[] => warn.mock.calls.map((c: unknown[]) => String(c[0]));

    it('existing multi/exclusive + the model now answers independent => keeps exclusive and warns', async () => {
      await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'exclusive' }), fetchImpl: fakeFetchFor(three()) });
      warn.mockClear();
      const { profile } = await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'independent' }), fetchImpl: fakeFetchFor(three()) });
      expect(profile).toMatchObject({ marketStructure: 'multi', outcomeGroup: 'exclusive' });
      expect(written()).toMatchObject({ outcomeGroup: 'exclusive' });
      expect(warned()).toContain('[build-trade] kept outcomeGroup "exclusive" (the model now says "independent")');
    });

    it('an agreeing model answer keeps the group without a warning', async () => {
      await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'exclusive' }), fetchImpl: fakeFetchFor(three()) });
      warn.mockClear();
      await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'exclusive' }), fetchImpl: fakeFetchFor(three()) });
      expect(written()).toMatchObject({ outcomeGroup: 'exclusive' });
      expect(warned().filter((m) => m.includes('kept outcomeGroup'))).toEqual([]);
    });

    it('no existing profile => the model answer is used', async () => {
      const { profile } = await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'independent' }), fetchImpl: fakeFetchFor(three()) });
      expect(profile).toMatchObject({ outcomeGroup: 'independent' });
      expect(warned().filter((m) => m.includes('kept outcomeGroup'))).toEqual([]);
    });

    it('existing capture profile => the model answer is used', async () => {
      await buildTradeProfile(opts(), { client: fakeClientFor({}), fetchImpl: fakeFetchFor([market('KXWHO-26-A', 'Alice')]) });
      expect(written().marketStructure).toBe('capture');
      const { profile } = await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'independent' }), fetchImpl: fakeFetchFor(three()) });
      expect(profile).toMatchObject({ marketStructure: 'multi', outcomeGroup: 'independent' });
    });

    it('existing multi profile.json that cannot be parsed => the model answer is used', async () => {
      await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'exclusive' }), fetchImpl: fakeFetchFor(three()) });
      fs.writeFileSync(profilePath(), '{ not json');
      const { profile } = await buildTradeProfile(opts(), { client: fakeClientFor({ outcomeGroup: 'independent' }), fetchImpl: fakeFetchFor(three()) });
      expect(profile).toMatchObject({ outcomeGroup: 'independent' });
    });
  });
});
