import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from './fixtures.js';
import { validateTrade, trimKeyphrases, DEFAULT_VALIDATE_OPTIONS } from '../../src/profile/validateTrade.js';
import { parseValidateArgs } from '../../src/profile/validateArgs.js';
import type { CorpusItem } from '../../src/profile/validate.js';

const item = (id: string, text: string, source = 'bluesky_geopolitics'): CorpusItem => ({ id, source, trustTier: 4, text, ts: '2026-10-01T00:00:00Z' });

describe('validateTrade', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 40 filler phrases so the list is realistic, plus the two we exercise
  const phrases = [...Array.from({ length: 30 }, (_, i) => `filler topic ${i}`), 'noisy sanctions phrase', 'real gas phrase'];

  it('replays the list, judges the frequent phrases with the supplied judge, and recommends dropping the one the gate rejects', async () => {
    writeProfile(dir, 'kxtest', { keyphrases: phrases });
    const loaded = loadProfile('kxtest', dir);
    const noisy = Array.from({ length: 14 }, (_, i) => item(`n${i}`, `blah noisy sanctions phrase number ${i}`));
    const real = Array.from({ length: 14 }, (_, i) => item(`r${i}`, `refinery news real gas phrase ${i}`));
    const rare = [item('x1', 'a filler topic 3 mention'), item('x2', 'another filler topic 3 mention')];
    const judge = async (it: CorpusItem) => it.id.startsWith('r');
    const v = await validateTrade(loaded, { items: [...noisy, ...real, ...rare], days: 7 }, judge, DEFAULT_VALIDATE_OPTIONS);
    expect(v.trade).toBe('kxtest');
    expect(v.phrases).toBe(32);
    expect(v.matchedItems).toBe(30);
    expect(v.hitsPerDay).toBeCloseTo(30 / 7, 6);
    expect(v.candidates.map((c) => c.phrase).sort()).toEqual(['noisy sanctions phrase', 'real gas phrase']); // 'filler topic 3' has < minHits
    const by = Object.fromEntries(v.verdicts.map((x) => [x.phrase, x]));
    expect(by['noisy sanctions phrase'].action).toBe('remove');
    expect(by['real gas phrase'].action).toBe('keep');
    expect(v.callsMade).toBe(24);                                    // 12 sampled per candidate
    expect(v.budgetExhausted).toBe(false);
  });

  it("never recommends removing a core phrase (all its words come from the trade's own title/settlement), even if its sampled hits fail", async () => {
    // fixture title: "Will the national average price of regular gasoline be above $4.34?"
    writeProfile(dir, 'kxcore', { keyphrases: [...phrases.slice(0, 30), 'regular gasoline price'] });
    const loaded = loadProfile('kxcore', dir);
    const items = Array.from({ length: 14 }, (_, i) => item(`c${i}`, `rant about regular gasoline price number ${i}`));
    const v = await validateTrade(loaded, { items, days: 3 }, async () => false, DEFAULT_VALIDATE_OPTIONS);
    const x = v.verdicts.find((p) => p.phrase === 'regular gasoline price')!;
    expect(x.action).toBe('keep');
    expect(x.reason).toMatch(/protected phrase.*review by hand/);
  });

  it('a phrase named in keepPhrases is never recommended for removal, however its sample judged', async () => {
    writeProfile(dir, 'kxkeep', { keyphrases: phrases });
    const loaded = loadProfile('kxkeep', dir);
    const noisy = Array.from({ length: 14 }, (_, i) => item(`n${i}`, `blah noisy sanctions phrase number ${i}`));
    const v = await validateTrade(loaded, { items: noisy, days: 7 }, async () => false, { ...DEFAULT_VALIDATE_OPTIONS, keepPhrases: ['noisy sanctions phrase'] });
    expect(v.verdicts[0]).toMatchObject({ phrase: 'noisy sanctions phrase', action: 'keep', reason: expect.stringMatching(/protected phrase/) });
  });

  it('items from the trades direct sources are ignored, since they bypass keyphrases', async () => {
    writeProfile(dir, 'kxdirect', { keyphrases: phrases, profile: { directSources: ['eia_today_in_energy'] } });
    const loaded = loadProfile('kxdirect', dir);
    const items = Array.from({ length: 20 }, (_, i) => item(`d${i}`, `noisy sanctions phrase ${i}`, 'eia_today_in_energy'));
    const v = await validateTrade(loaded, { items, days: 1 }, async () => true, DEFAULT_VALIDATE_OPTIONS);
    expect(v.matchedItems).toBe(0);
    expect(v.candidates).toEqual([]);
  });
});

describe('trimKeyphrases', () => {
  let dir: string, backups: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-')); backups = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-bak-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(backups, { recursive: true, force: true }); });

  const phrases = Array.from({ length: 30 }, (_, i) => `topic phrase ${i}`);
  const rm = (phrase: string) => ({ phrase, hits: 50, judged: 12, passed: 0, passRate: 0, action: 'remove' as const, reason: 'x' });
  const now = () => new Date('2026-10-12T08:00:00Z');

  it('rewrites keyphrases.json without the removed phrases and backs the old file up outside the repo', () => {
    writeProfile(dir, 'kxtrim', { keyphrases: phrases });
    const loaded = loadProfile('kxtrim', dir);
    const r = trimKeyphrases(loaded, [rm('topic phrase 3'), rm('topic phrase 9')], { floor: 20, backupDir: backups, now });
    expect(r.removed).toEqual(['topic phrase 3', 'topic phrase 9']);
    const after = loadProfile('kxtrim', dir).keyphrases;                     // still a valid, loadable profile
    expect(after).toHaveLength(28);
    expect(after).not.toContain('topic phrase 3');
    expect(r.backupPath).toMatch(/kxtrim[\\/]keyphrases\.json\.bak-/);
    expect(JSON.parse(fs.readFileSync(r.backupPath!, 'utf8'))).toHaveLength(30);
    expect(fs.readdirSync(path.join(dir, 'kxtrim')).sort()).toEqual(['bank.md', 'bank.meta.json', 'keyphrases.json', 'profile.json']); // no stray files in the profile dir
  });

  it('honours the floor and reports what it blocked', () => {
    writeProfile(dir, 'kxfloor', { keyphrases: phrases });
    const r = trimKeyphrases(loadProfile('kxfloor', dir), [rm('topic phrase 1'), rm('topic phrase 2'), rm('topic phrase 3')], { floor: 29, backupDir: backups, now });
    expect(r.removed).toHaveLength(1);
    expect(r.blocked).toHaveLength(2);
    expect(loadProfile('kxfloor', dir).keyphrases).toHaveLength(29);
  });

  it('writes nothing, not even a backup, when there is nothing to remove', () => {
    writeProfile(dir, 'kxnone', { keyphrases: phrases });
    const before = fs.readFileSync(path.join(dir, 'kxnone', 'keyphrases.json'), 'utf8');
    const r = trimKeyphrases(loadProfile('kxnone', dir), [{ ...rm('topic phrase 1'), action: 'keep' }], { floor: 20, backupDir: backups, now });
    expect(r).toMatchObject({ removed: [], blocked: [], backupPath: null });
    expect(fs.readFileSync(path.join(dir, 'kxnone', 'keyphrases.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it.each([
    ['live ledger', { ledgerPath: 'data/decisions.db' }],
    ['live consumer group', { consumerGroup: 'execmod' }],
  ])('refuses to touch the hand-pinned live profile (%s)', (_label, over) => {
    writeProfile(dir, 'kxlive', { keyphrases: phrases, profile: over });
    expect(() => trimKeyphrases(loadProfile('kxlive', dir), [rm('topic phrase 1')], { floor: 20, backupDir: backups, now })).toThrow(/live profile/);
  });
});

describe('parseValidateArgs', () => {
  it('defaults: report only, nothing applied', () => {
    const a = parseValidateArgs(['--trade', 'kxa,kxb']);
    expect(a).toMatchObject({ trades: ['kxa', 'kxb'], all: false, apply: false, exclude: [] });
    expect(a.options).toMatchObject({ minHits: 10, maxPassRate: 0.2, sampleSize: 12 });
    expect(a.floor).toBe(150);
  });

  it('--keep-phrases takes a semicolon-separated list of exact phrases to protect', () => {
    expect(parseValidateArgs(['--trade', 'a', '--keep-phrases', 'Delcy Rodríguez;Nicolás Maduro']).options.keepPhrases).toEqual(['Delcy Rodríguez', 'Nicolás Maduro']);
    expect(parseValidateArgs(['--trade', 'a']).options.keepPhrases).toEqual([]);
  });

  it('--all with --exclude and --apply', () => {
    const a = parseValidateArgs(['--all', '--exclude', 'kxaprpotus,kxtrumpact', '--apply', '--max-calls', '500', '--since-days', '14']);
    expect(a).toMatchObject({ all: true, apply: true, exclude: ['kxaprpotus', 'kxtrumpact'], sinceDays: 14 });
    expect(a.options.maxCalls).toBe(500);
  });

  it.each([
    [[], /--trade|--all/],
    [['--trade', 'a', '--all'], /not both/],
    [['--trade', 'a', '--bogus'], /unknown argument/],
    [['--trade', 'a', '--apply', '--apply'], /duplicate/],
    [['--trade', 'a', '--max-pass-rate', '1.5'], /max-pass-rate/],
    [['--trade', 'a', '--max-calls', '0'], /max-calls/],
    [['--trade', 'a', '--floor', '5'], /floor/],
    [['--trade'], /requires a value/],
  ])('rejects %j', (argv, re) => {
    expect(() => parseValidateArgs(argv as string[])).toThrow(re as RegExp);
  });
});
