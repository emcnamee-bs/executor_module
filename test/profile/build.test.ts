import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { deriveStructure, fetchSeriesSpec, buildTradeProfile } from '../../src/profile/build.js';
import { loadProfile } from '../../src/profile/profile.js';
import { GOOD_BANK } from './fixtures.js';

const EVENTS = { events: [{ event_ticker: 'KXAAAGASW-26OCT12', strike_date: '2026-10-12T03:59:00Z', title: 'Gas prices this week' }] };
const MARKETS = { markets: [
  { ticker: 'KXAAAGASW-26OCT12-4.30', strike_type: 'greater', yes_sub_title: 'Above 4.3000', rules_primary: 'If average regular gas prices for United States are strictly greater than $4.3000 on Oct 12, 2026 according to AAA, then the market resolves to Yes.' },
  { ticker: 'KXAAAGASW-26OCT12-4.34', strike_type: 'greater', yes_sub_title: 'Above 4.3400', rules_primary: 'x' },
] };

function fakeFetch(): typeof fetch {
  return (async (url: string) => {
    const body = String(url).includes('/events?') ? EVENTS : MARKETS;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function fakeClient(over: { bank?: string; keyphrases?: string[]; fail?: boolean } = {}) {
  const profileOut = {
    title: 'Will the AAA national average gas price be above the strike on the settlement date?',
    settlement: 'Resolves YES if the AAA national average for regular gasoline is strictly above the strike.',
    decideContext: 'You are assessing a news item for its likely effect on the AAA national average price of regular gasoline.',
    magnitudeUnit: 'USD/gal', maxMagnitude: 0.5, bank: over.bank ?? GOOD_BANK,
  };
  const phrases = over.keyphrases ?? Array.from({ length: 200 }, (_, i) => `gas price phrase ${i}`);
  const calls: any[] = [];
  const client = {
    messages: {
      parse: async (p: any) => {
        calls.push(p);
        if (over.fail) throw new Error('boom');
        const isBank = JSON.stringify(p.output_config.format.schema).includes('magnitudeUnit');
        const parsed = isBank ? profileOut : { keyphrases: phrases };
        return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: JSON.stringify(parsed) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('deriveStructure', () => {
  it.each([
    [['less', 'between', 'between', 'greater'], 9, 'band'],
    [['greater', 'greater', 'greater'], 3, 'threshold'],
    [['greater_or_equal', 'greater_or_equal'], 2, 'threshold'],
    [['less', 'greater'], 2, 'threshold'],
    [[null], 1, 'binary'],
    [['custom', 'custom'], 5, 'capture'],
    [['between', 'custom'], 2, 'capture'],
  ])('%j with %i markets is %s', (types, n, expected) => {
    expect(deriveStructure(types as any, n as number)).toBe(expected);
  });
});

describe('fetchSeriesSpec', () => {
  it('reads the nearest open event, its rules text and its strike types from the public API', async () => {
    const spec = await fetchSeriesSpec('KXAAAGASW', fakeFetch());
    expect(spec.title).toBe('Gas prices this week');
    expect(spec.rulesText).toContain('according to AAA');
    expect(spec.strikeTypes).toEqual(['greater', 'greater']);
    expect(spec.marketCount).toBe(2);
    expect(spec.sampleSubtitles).toContain('Above 4.3000');
  });
  it('throws a clear error when the series has no open event', async () => {
    const empty = (async () => new Response(JSON.stringify({ events: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchSeriesSpec('NOPE', empty)).rejects.toThrow(/no open event for series NOPE/);
  });
});

describe('buildTradeProfile', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = (over = {}) => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });

  it('writes a profile that the loader accepts, with structure derived from Kalshi and defaults applied', async () => {
    const { client } = fakeClient();
    const { dir, profile } = await buildTradeProfile(opts(), { client, fetchImpl: fakeFetch(), now: () => new Date('2026-10-08T12:00:00Z') });
    const loaded = loadProfile('kxaaagasw', path.join(root, 'trades'));
    expect(dir).toBe(path.join(root, 'trades', 'kxaaagasw'));
    expect(loaded.profile).toMatchObject({
      name: 'kxaaagasw', seriesTicker: 'KXAAAGASW', marketStructure: 'threshold', magnitudeUnit: 'USD/gal', maxMagnitude: 0.5,
      directSources: ['aaa_national_average'], gateModel: 'qwen2.5:7b-instruct-q4_K_M', gateKeepAlive: '10m',
      ledgerPath: 'data/kxaaagasw/decisions.db', consumerGroup: 'execmod-kxaaagasw', generatedAt: '2026-10-08T12:00:00.000Z', generatorModel: 'claude-sonnet-5',
    });
    expect(loaded.keyphrases).toHaveLength(200);
    expect(profile.name).toBe('kxaaagasw');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'bank.meta.json'), 'utf-8'));
    expect(meta.sha256).toBe(loaded.bankSha);
  });

  it('logs both generation calls (bank and keyphrases) to the trade ledger', async () => {
    const { client } = fakeClient();
    await buildTradeProfile(opts(), { client, fetchImpl: fakeFetch() });
    const db = new Database(path.join(root, 'data/kxaaagasw/decisions.db'), { readonly: true });
    const stages = (db.prepare('SELECT stage FROM ai_calls ORDER BY id').all() as any[]).map((r) => r.stage);
    db.close();
    expect(stages).toEqual(['build_bank', 'build_keyphrases']);
  });

  it('retries once with the validator error when the bank is invalid, then succeeds', async () => {
    let n = 0;
    const base = fakeClient();
    const client = { messages: { parse: async (p: any) => {
      const isBank = JSON.stringify(p.output_config.format.schema).includes('magnitudeUnit');
      if (isBank && n++ === 0) {
        const bad = { title: 'Will the AAA national average gas price be above the strike?', settlement: 'Resolves YES if above the strike on the date.', decideContext: 'You are assessing a news item for its likely effect on gasoline prices nationally.', magnitudeUnit: 'USD/gal', maxMagnitude: 0.5, bank: 'not a bank' };
        return { stop_reason: 'end_turn', parsed_output: bad, content: [], usage: {} };
      }
      return (base.client as any).messages.parse(p);
    } } } as unknown as Anthropic;
    await buildTradeProfile(opts(), { client, fetchImpl: fakeFetch() });
    expect(n).toBe(2);
  });

  it('fails and leaves an existing profile BYTE-IDENTICAL when the bank stays invalid', async () => {
    const first = fakeClient();
    const { dir } = await buildTradeProfile(opts(), { client: first.client, fetchImpl: fakeFetch() });
    const before = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf-8')]);
    const bad = fakeClient({ bank: 'still not a bank' });
    await expect(buildTradeProfile(opts(), { client: bad.client, fetchImpl: fakeFetch() })).rejects.toThrow(/bank/);
    const after = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf-8')]);
    expect(after).toEqual(before);
  });

  it('rejects a generated keyphrase list that is too small (under 150 phrases)', async () => {
    const { client } = fakeClient({ keyphrases: ['only phrase'] });
    await expect(buildTradeProfile(opts(), { client, fetchImpl: fakeFetch() })).rejects.toThrow(/at least 150/);
    expect(fs.existsSync(path.join(root, 'trades', 'kxaaagasw', 'profile.json'))).toBe(false);
  });

  it('reuses an existing keyphrase file (the live approval trade) instead of generating one', async () => {
    const reuse = path.join(root, 'old.json');
    fs.writeFileSync(reuse, JSON.stringify(Array.from({ length: 330 }, (_, i) => `approval phrase ${i}`)));
    const { client, calls } = fakeClient();
    await buildTradeProfile(opts({ reuseKeyphrasesFile: reuse, ledgerPath: 'data/decisions.db', consumerGroup: 'execmod', allowLiveLedger: true }), { client, fetchImpl: fakeFetch() });
    expect(calls).toHaveLength(1); // the bank call only
    const loaded = loadProfile('kxaaagasw', path.join(root, 'trades'));
    expect(loaded.keyphrases).toHaveLength(330);
    expect(loaded.profile).toMatchObject({ ledgerPath: 'data/decisions.db', consumerGroup: 'execmod' });
  });

  it('passes the market context (series, title, settlement) into the keyphrase prompt, not the approval context', async () => {
    const { client, calls } = fakeClient();
    await buildTradeProfile(opts(), { client, fetchImpl: fakeFetch() });
    const kp = calls.find((c) => !JSON.stringify(c.output_config.format.schema).includes('magnitudeUnit'));
    expect(kp.messages[0].content).toContain('KXAAAGASW');
    expect(kp.messages[0].content).not.toContain('RealClearPolitics');
    expect(kp.messages[0].content).not.toMatch(/Rasmussen|approval/i);
    expect(kp.messages[0].content).toMatch(/at least 200/i);
  });
});

describe('buildTradeProfile input validation and the live ledger', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = (over = {}) => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });
  const noFetch = (async () => { throw new Error('fetch must not be reached'); }) as unknown as typeof fetch;

  it.each(['/etc/x.db', 'data/../x.db', 'data/Bad Dir/x.db', 'x.db', 'data/a/b/x.db', 'data/x.sqlite'])(
    'rejects ledger path %s before any fetch, model call or file write', async (bad) => {
      const { client, calls } = fakeClient();
      await expect(buildTradeProfile(opts({ ledgerPath: bad }), { client, fetchImpl: noFetch })).rejects.toThrow(/ledger path/i);
      expect(calls).toHaveLength(0);
      expect(fs.readdirSync(root)).toEqual([]);
    });

  it('rejects an invalid consumer group before any fetch or file write', async () => {
    const { client, calls } = fakeClient();
    await expect(buildTradeProfile(opts({ consumerGroup: 'bad group!' }), { client, fetchImpl: noFetch })).rejects.toThrow(/consumer group/i);
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses the live ledger data/decisions.db by default and does not create or touch it', async () => {
    const { client, calls } = fakeClient();
    await expect(buildTradeProfile(opts({ ledgerPath: 'data/decisions.db' }), { client, fetchImpl: noFetch })).rejects.toThrow(/allow-live-ledger/);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'data'))).toBe(false);
  });

  it('with allowLiveLedger writes the build ai_calls rows into the live ledger', async () => {
    const { client } = fakeClient();
    await buildTradeProfile(opts({ ledgerPath: 'data/decisions.db', allowLiveLedger: true }), { client, fetchImpl: fakeFetch() });
    const db = new Database(path.join(root, 'data/decisions.db'), { readonly: true });
    const n = (db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get() as any).n;
    db.close();
    expect(n).toBe(2);
  });
});
