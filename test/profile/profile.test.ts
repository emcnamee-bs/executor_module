import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile, assertLiveAllowed } from '../../src/profile/profile.js';
import { loadIipSourceIds, assertDirectSourcesKnown } from '../../src/profile/iipSources.js';
import { writeProfile, GOOD_BANK } from './fixtures.js';

describe('loadProfile', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('loads a valid profile with its keyphrases, bank and a stable bank hash', () => {
    writeProfile(root, 'kxaaagasw');
    const a = loadProfile('kxaaagasw', root);
    const b = loadProfile('kxaaagasw', root);
    expect(a.profile.seriesTicker).toBe('KXAAAGASW');
    expect(a.keyphrases).toHaveLength(25);
    expect(a.bank).toBe(GOOD_BANK);
    expect(a.bankSha).toMatch(/^[0-9a-f]{64}$/);
    expect(a.bankSha).toBe(b.bankSha);
  });

  it('rejects a name that could escape the trades directory', () => {
    expect(() => loadProfile('../etc', root)).toThrow(/invalid trade name/);
    expect(() => loadProfile('Has Space', root)).toThrow(/invalid trade name/);
  });

  it.each(['../x', 'a/../../b', '%2e%2e', '/etc/passwd', 'abc\0def', 'abc\n', 'abc\ndef', '..', 'a/b', 'a\\b', '-abc'])(
    'never reads outside the trades root for name %j',
    (bad) => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      writeProfile(outside, 'x');
      expect(() => loadProfile(bad, root)).toThrow(/invalid trade name/);
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it('fails loudly naming the directory when the profile does not exist', () => {
    expect(() => loadProfile('nope-trade', root)).toThrow(/trade profile directory not found/);
  });

  it.each(['profile.json', 'keyphrases.json', 'bank.md'])('fails naming the missing file %s', (file) => {
    const dir = writeProfile(root, 'kxaaagasw');
    fs.rmSync(path.join(dir, file));
    expect(() => loadProfile('kxaaagasw', root)).toThrow(new RegExp(file.replace('.', '\\.')));
  });

  it('rejects a profile whose name field disagrees with its directory', () => {
    writeProfile(root, 'kxaaagasw', { profile: { name: 'other-name' } });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/does not match directory/);
  });

  it('rejects unknown fields (strict schema)', () => {
    writeProfile(root, 'kxaaagasw', { profile: { surprise: 1 } });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/profile\.json is invalid/);
  });

  it('rejects an invalid marketStructure', () => {
    writeProfile(root, 'kxaaagasw', { profile: { marketStructure: 'weird' } });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/marketStructure/);
  });

  it('rejects a non-positive maxMagnitude', () => {
    writeProfile(root, 'kxaaagasw', { profile: { maxMagnitude: 0 } });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/maxMagnitude/);
  });

  it('rejects too few keyphrases', () => {
    writeProfile(root, 'kxaaagasw', { keyphrases: ['only phrase'] });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/at least 20 keyphrases/);
  });

  it('fails naming bank.meta.json when it is missing', () => {
    const dir = writeProfile(root, 'kxaaagasw');
    fs.rmSync(path.join(dir, 'bank.meta.json'));
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/bank\.meta\.json/);
  });

  it('fails naming bank.meta.json when it is invalid JSON', () => {
    const dir = writeProfile(root, 'kxaaagasw');
    fs.writeFileSync(path.join(dir, 'bank.meta.json'), '{not json');
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/bank\.meta\.json is invalid JSON/);
  });

  it('fails when bank.meta.json has no sha256 string', () => {
    const dir = writeProfile(root, 'kxaaagasw');
    fs.writeFileSync(path.join(dir, 'bank.meta.json'), JSON.stringify({ sha256: 5 }));
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/bank\.meta\.json sha256 does not match/);
  });

  it('fails when bank.md was edited after the meta sha was recorded', () => {
    const dir = writeProfile(root, 'kxaaagasw');
    fs.writeFileSync(path.join(dir, 'bank.md'), GOOD_BANK.replace('Crude oil', 'Crude Oil'));
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/bank\.meta\.json sha256 does not match bank\.md/);
  });

  it('fails on an explicitly mismatched meta sha', () => {
    writeProfile(root, 'kxaaagasw', { metaSha: 'a'.repeat(64) });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/does not match bank\.md/);
  });

  it.each([
    ['data/decisions.db', true],
    ['data/kxaaagasw/decisions.db', true],
    ['/etc/x.db', false],
    ['../x.db', false],
    ['data/../x.db', false],
    ['data/a/../../x.db', false],
    ['data/x.txt', false],
    ['data/Up Per/x.db', false],
    ['C:\\x.db', false],
    ['data/a/b/c.db', false],
  ])('ledgerPath %j accepted=%s', (ledgerPath, ok) => {
    writeProfile(root, 'kxaaagasw', { profile: { ledgerPath } });
    if (ok) expect(() => loadProfile('kxaaagasw', root)).not.toThrow();
    else expect(() => loadProfile('kxaaagasw', root)).toThrow(/ledgerPath/);
  });

  it('counts phrases after single-word ones are dropped', () => {
    const phrases = [
      ...Array.from({ length: 15 }, (_, i) => `word${i}`),
      ...Array.from({ length: 15 }, (_, i) => `two words ${i}`),
    ];
    writeProfile(root, 'kxaaagasw', { keyphrases: phrases });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/at least 20 keyphrases/);
  });

  it('rejects an invalid bank, naming the validator reason', () => {
    writeProfile(root, 'kxaaagasw', { bank: 'just some text' });
    expect(() => loadProfile('kxaaagasw', root)).toThrow(/bank\.md is invalid.*exactly these headers/s);
  });
});

describe('assertLiveAllowed', () => {
  const base = JSON.parse(JSON.stringify({ marketStructure: 'band' }));
  it('allows a band profile to run with real money', () => {
    expect(() => assertLiveAllowed(base, {})).not.toThrow();
  });
  it.each(['threshold', 'binary', 'capture'])('refuses a %s profile unless KALSHI_DRY_RUN is exactly "true"', (s) => {
    const p = { ...base, name: 'x', marketStructure: s };
    expect(() => assertLiveAllowed(p, {})).toThrow(/KALSHI_DRY_RUN/);
    expect(() => assertLiveAllowed(p, { KALSHI_DRY_RUN: 'TRUE' })).toThrow(/KALSHI_DRY_RUN/);
    expect(() => assertLiveAllowed(p, { KALSHI_DRY_RUN: 'true' })).not.toThrow();
  });
});

describe('iip source ids', () => {
  it('reads ids from a sources yaml and rejects an unknown direct source', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iip-')), 'sources.yaml');
    fs.writeFileSync(f, 'sources:\n  - id: bls_releases\n    adapter: feed\n  - id: aaa_national_average\n    adapter: series\n');
    expect(loadIipSourceIds(f)).toEqual(['bls_releases', 'aaa_national_average']);
    const p = { name: 'x', directSources: ['aaa_national_average', 'typo_source'] } as any;
    expect(() => assertDirectSourcesKnown(p, loadIipSourceIds(f))).toThrow(/typo_source/);
    expect(() => assertDirectSourcesKnown({ ...p, directSources: ['bls_releases'] }, loadIipSourceIds(f))).not.toThrow();
  });
  it('fails when a non-empty sources file yields no ids', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iip-')), 'sources.yaml');
    fs.writeFileSync(f, 'sources:\n  - name: x\n');
    expect(() => loadIipSourceIds(f)).toThrow(/no source ids/);
  });
  it('fails loudly when the sources file is unreadable', () => {
    expect(() => loadIipSourceIds('/nonexistent/sources.yaml')).toThrow(/IIP sources file/);
  });
});
