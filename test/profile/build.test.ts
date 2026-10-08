import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { deriveStructure, fetchSeriesSpec, buildTradeProfile } from '../../src/profile/build.js';
import { loadProfile } from '../../src/profile/profile.js';
import { validateBank } from '../../src/profile/bank.js';
import { parseBuildArgs } from '../../src/profile/cliArgs.js';
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

describe('deriveStructure edge cases', () => {
  it("'custom' deliberately wins over 'between': capture is the safe direction (never a real order)", () => {
    expect(deriveStructure(['between', 'custom'], 2)).toBe('capture');
  });
  it('unknown strike types become capture', () => {
    expect(deriveStructure(['less_or_equal', 'less_or_equal'], 2)).toBe('capture');
    expect(deriveStructure(['greater', 'something_new'], 2)).toBe('capture');
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
    const bankUsers: string[] = [];
    const client = { messages: { parse: async (p: any) => {
      const isBank = JSON.stringify(p.output_config.format.schema).includes('magnitudeUnit');
      if (isBank) bankUsers.push(p.messages[0].content);
      if (isBank && n++ === 0) {
        const bad = { title: 'Will the AAA national average gas price be above the strike?', settlement: 'Resolves YES if above the strike on the date.', decideContext: 'You are assessing a news item for its likely effect on gasoline prices nationally.', magnitudeUnit: 'USD/gal', maxMagnitude: 0.5, bank: 'not a bank' };
        return { stop_reason: 'end_turn', parsed_output: bad, content: [], usage: {} };
      }
      return (base.client as any).messages.parse(p);
    } } } as unknown as Anthropic;
    await buildTradeProfile(opts(), { client, fetchImpl: fakeFetch() });
    expect(n).toBe(2);
    let validatorMessage = '';
    try { validateBank('not a bank'); } catch (e) { validatorMessage = (e as Error).message; }
    expect(validatorMessage.length).toBeGreaterThan(5);
    expect(bankUsers[0]).not.toContain('previous bank was rejected');
    expect(bankUsers[1]).toContain('previous bank was rejected');
    expect(bankUsers[1]).toContain(validatorMessage);
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

const snapshot = (dir: string) => fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf-8')]);
const names = (d: string) => fs.readdirSync(d).sort();

function seqClient(profileOuts: Array<Record<string, unknown>>, phrases?: string[]) {
  const base = fakeClient({ keyphrases: phrases });
  const bankUsers: string[] = [];
  let n = 0;
  const client = { messages: { parse: async (p: any) => {
    const isBank = JSON.stringify(p.output_config.format.schema).includes('magnitudeUnit');
    if (!isBank) return (base.client as any).messages.parse(p);
    bankUsers.push(p.messages[0].content);
    const over = profileOuts[Math.min(n++, profileOuts.length - 1)];
    const parsed = { title: 'Will the AAA national average gas price be above the strike on the date?', settlement: 'Resolves YES if the AAA national average is strictly above the strike.', decideContext: 'You are assessing a news item for its likely effect on the AAA national average price of regular gasoline.', magnitudeUnit: 'USD/gal', maxMagnitude: 0.5, bank: GOOD_BANK, ...over };
    return { stop_reason: 'end_turn', parsed_output: parsed, content: [], usage: {} };
  } } } as unknown as Anthropic;
  return { client, bankUsers };
}

describe('profile schema validated inside the build', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = (over = {}) => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });

  it('retries with the schema error when decideContext is over-long, then succeeds', async () => {
    const { client, bankUsers } = seqClient([{ decideContext: 'x'.repeat(2000) }, {}]);
    const { dir } = await buildTradeProfile(opts(), { client, fetchImpl: fakeFetch() });
    expect(bankUsers).toHaveLength(2);
    expect(bankUsers[1]).toContain('decideContext');
    expect(bankUsers[1]).not.toContain('xxxxxxxxxx');
    expect(bankUsers[1].length).toBeLessThan(bankUsers[0].length + 700);
    expect(loadProfile('kxaaagasw', path.join(root, 'trades')).dir).toBe(dir);
  });

  it('throws and writes nothing when still invalid after the retry; an existing profile stays byte-identical', async () => {
    const first = await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    const before = snapshot(first.dir);
    const { client } = seqClient([{ decideContext: 'x'.repeat(2000) }]);
    await expect(buildTradeProfile(opts(), { client, fetchImpl: fakeFetch() })).rejects.toThrow(/decideContext/);
    expect(snapshot(first.dir)).toEqual(before);
    expect(names(path.join(root, 'trades'))).toEqual(['kxaaagasw']);
  });

  it('rejects an invalid --direct id before any fetch or file write', async () => {
    const fetchSpy = (async () => { throw new Error('fetch must not be reached'); }) as unknown as typeof fetch;
    let calls = 0;
    const spy = ((...a: any[]) => { calls++; return (fetchSpy as any)(...a); }) as unknown as typeof fetch;
    await expect(buildTradeProfile(opts({ directSources: ['AAA-National'] }), { client: fakeClient().client, fetchImpl: spy })).rejects.toThrow(/direct/i);
    expect(calls).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('whole-directory swap', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = (over = {}) => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });

  it('a failing rename of the staged dir into place restores the old profile byte-identical and leaves no temp dirs', async () => {
    const first = await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    const before = snapshot(first.dir);
    let renames = 0;
    const rename = ((a: string, b: string) => { renames++; if (renames === 2) throw new Error('disk on fire'); fs.renameSync(a, b); }) as typeof fs.renameSync;
    await expect(
      buildTradeProfile(opts(), { client: fakeClient({ keyphrases: Array.from({ length: 250 }, (_, i) => `other phrase ${i}`) }).client, fetchImpl: fakeFetch(), rename })
    ).rejects.toThrow(/disk on fire/);
    expect(snapshot(first.dir)).toEqual(before);
    expect(names(path.join(root, 'trades'))).toEqual(['kxaaagasw']);
  });

  it('a keyphrase-stage failure against an existing profile leaves it byte-identical', async () => {
    const first = await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    const before = snapshot(first.dir);
    await expect(buildTradeProfile(opts(), { client: fakeClient({ keyphrases: ['only phrase here'] }).client, fetchImpl: fakeFetch() })).rejects.toThrow(/at least 150/);
    expect(snapshot(first.dir)).toEqual(before);
    expect(names(path.join(root, 'trades'))).toEqual(['kxaaagasw']);
  });

  it('a successful rebuild replaces the whole directory: only the four profile files remain, no temp dirs', async () => {
    const first = await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    fs.writeFileSync(path.join(first.dir, 'stale-extra.txt'), 'old');
    await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    expect(names(first.dir)).toEqual(['bank.md', 'bank.meta.json', 'keyphrases.json', 'profile.json']);
    expect(names(path.join(root, 'trades'))).toEqual(['kxaaagasw']);
  });
});

describe('live ledger guard is case- and alias-proof', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = (over = {}) => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });
  const noFetch = (async () => { throw new Error('fetch must not be reached'); }) as unknown as typeof fetch;

  it.each(['data/Decisions.db', 'data/DECISIONS.DB'])('refuses %s without the flag', async (p) => {
    await expect(buildTradeProfile(opts({ ledgerPath: p }), { client: fakeClient().client, fetchImpl: noFetch })).rejects.toThrow(/allow-live-ledger|invalid ledger path/); // DECISIONS.DB is also refused by the .db-suffix rule
  });
  it('allows data/Decisions.db with allowLiveLedger', async () => {
    await buildTradeProfile(opts({ ledgerPath: 'data/Decisions.db', allowLiveLedger: true }), { client: fakeClient().client, fetchImpl: fakeFetch() });
  });
  it('refuses a hard link to the live ledger (same inode) without the flag', async () => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/decisions.db'), '');
    fs.linkSync(path.join(root, 'data/decisions.db'), path.join(root, 'data/alias.db'));
    await expect(buildTradeProfile(opts({ ledgerPath: 'data/alias.db' }), { client: fakeClient().client, fetchImpl: noFetch })).rejects.toThrow(/allow-live-ledger/);
  });
  it('does not refuse a different existing file', async () => {
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/decisions.db'), '');
    await buildTradeProfile(opts({ ledgerPath: 'data/other.db' }), { client: fakeClient().client, fetchImpl: fakeFetch() });
  });
});

describe('keyphrase counting uses the loader rule (>= 2 words)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = (over = {}) => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });

  it('rejects 150 phrases of which 60 are single words', async () => {
    const list = [...Array.from({ length: 90 }, (_, i) => `gas phrase ${i}`), ...Array.from({ length: 60 }, (_, i) => `single${i}`)];
    await expect(buildTradeProfile(opts(), { client: fakeClient({ keyphrases: list }).client, fetchImpl: fakeFetch() })).rejects.toThrow(/at least 150/);
    expect(fs.existsSync(path.join(root, 'trades'))).toBe(false);
  });
  it('rejects a reuse file with under 20 usable phrases', async () => {
    const reuse = path.join(root, 'old.json');
    fs.writeFileSync(reuse, JSON.stringify([...Array.from({ length: 10 }, (_, i) => `usable phrase ${i}`), ...Array.from({ length: 40 }, (_, i) => `one${i}`)]));
    await expect(buildTradeProfile(opts({ reuseKeyphrasesFile: reuse }), { client: fakeClient().client, fetchImpl: fakeFetch() })).rejects.toThrow(/at least 20/);
  });
});

describe('fetchSeriesSpec robustness', () => {
  it('requests markets with limit=1000, tolerates a missing strike_date and takes rules from the first market that has them', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/events?')) return new Response(JSON.stringify({ events: [{ event_ticker: 'E1', title: 'T' }, { event_ticker: 'E2', strike_date: '2026-10-12T00:00:00Z', title: 'T2' }] }), { status: 200 });
      return new Response(JSON.stringify({ markets: [{ ticker: 'A', strike_type: 'greater' }, { ticker: 'B', strike_type: 'greater', rules_primary: 'Second market rules.', rules_secondary: 'More.' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const spec = await fetchSeriesSpec('KXAAAGASW', f);
    expect(urls[1]).toContain('limit=1000');
    expect(spec.rulesText).toBe('Second market rules. More.');
  });
});

describe('parseBuildArgs', () => {
  it('parses all flags', () => {
    expect(parseBuildArgs(['--series', 'KXA', '--direct', 'a_b,c', '--reuse-keyphrases', 'f.json', '--ledger-path', 'data/x.db', '--consumer-group', 'g', '--gate-model', 'm', '--allow-live-ledger'])).toEqual({
      seriesTicker: 'KXA', directSources: ['a_b', 'c'], reuseKeyphrasesFile: 'f.json', ledgerPath: 'data/x.db', consumerGroup: 'g', gateModel: 'm', allowLiveLedger: true,
    });
  });
  it('defaults: no direct sources, live ledger flag false', () => {
    expect(parseBuildArgs(['--series', 'KXA'])).toMatchObject({ seriesTicker: 'KXA', directSources: [], allowLiveLedger: false });
  });
  it.each([
    [[]],
    [['--series']],
    [['--series', '--direct', 'a']],
    [['--series', 'KXA', '--reuse-keyphrases']],
    [['--series', 'KXA', '--reuse-keyphrases', '--ledger-path', 'x']],
    [['--series', 'KXA', '--bogus']],
    [['--series', 'KXA', 'stray']],
    [['--series', 'KXA', '--series', 'KXB']],
    [['--series', 'KXA', '--allow-live-ledger', 'yes']],
  ])('rejects %j', (argv) => {
    expect(() => parseBuildArgs(argv as string[])).toThrow();
  });
});

describe('cleanup never masks the build result, and stale dirs are swept', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-')); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  const opts = (over = {}) => ({ seriesTicker: 'KXAAAGASW', directSources: ['aaa_national_average'], tradesRoot: path.join(root, 'trades'), repoRoot: root, ...over });
  const trades = () => path.join(root, 'trades');

  it('an rm failure after a successful swap only warns: the build resolves and the new profile is live', async () => {
    await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rm = (() => { throw new Error('EACCES'); }) as unknown as typeof fs.rmSync;
    const { dir } = await buildTradeProfile(opts(), { client: fakeClient({ keyphrases: Array.from({ length: 250 }, (_, i) => `fresh phrase ${i}`) }).client, fetchImpl: fakeFetch(), rm });
    expect(loadProfile('kxaaagasw', trades()).keyphrases).toHaveLength(250);
    expect(dir).toBe(path.join(trades(), 'kxaaagasw'));
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/\.old-kxaaagasw-/);
  });

  it('a failure-path rm error does not replace the original error', async () => {
    const rm = (() => { throw new Error('EACCES from rm'); }) as unknown as typeof fs.rmSync;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(buildTradeProfile(opts(), { client: fakeClient({ keyphrases: ['one phrase'] }).client, fetchImpl: fakeFetch(), rm })).rejects.toThrow(/at least 150/);
  });

  it('sweeps stale staging/old dirs for this profile only, leaving other profiles alone', async () => {
    await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    for (const d of ['.old-kxaaagasw-deadbeef', '.build-kxaaagasw-cafef00d', '.old-kxaaagasw-2-deadbeef', '.build-other-cafef00d']) fs.mkdirSync(path.join(trades(), d));
    await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    expect(names(trades())).toEqual(['.build-other-cafef00d', '.old-kxaaagasw-2-deadbeef', 'kxaaagasw']);
  });

  it('restores an .old dir when the target is missing (a crashed swap), then rebuilds', async () => {
    const first = await buildTradeProfile(opts(), { client: fakeClient().client, fetchImpl: fakeFetch() });
    const before = snapshot(first.dir);
    fs.renameSync(first.dir, path.join(trades(), '.old-kxaaagasw-deadbeef'));
    await expect(buildTradeProfile(opts(), { client: fakeClient({ keyphrases: ['one phrase'] }).client, fetchImpl: fakeFetch() })).rejects.toThrow(/at least 150/);
    expect(snapshot(first.dir)).toEqual(before);
    expect(names(trades())).toEqual(['kxaaagasw']);
  });
});
