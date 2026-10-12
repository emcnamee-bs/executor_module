import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from './fixtures.js';
import { runValidation } from '../../src/profile/validateRun.js';
import { DEFAULT_VALIDATE_OPTIONS } from '../../src/profile/validateTrade.js';
import { parseBuildArgs } from '../../src/profile/cliArgs.js';
import type { CorpusItem } from '../../src/profile/validate.js';

const item = (id: string, text: string, source = 'bluesky_geopolitics'): CorpusItem => ({ id, source, trustTier: 4, text, ts: '2026-10-01T00:00:00Z' });

/** A stand-in for Claude: calls the item irrelevant when its text mentions "noisy", relevant otherwise. */
function fakeAnthropic() {
  const calls: any[] = [];
  const anthropic = {
    messages: {
      create: async (p: any) => {
        calls.push(p);
        const text = String(p.messages[0].content);
        const relevant = !text.includes('noisy');
        return { content: [{ type: 'text', text: JSON.stringify({ reason: 'r', relevant }) }], usage: { input_tokens: 1500, output_tokens: 70 }, stop_reason: 'end_turn' };
      },
    },
  } as unknown as Anthropic;
  return { anthropic, calls };
}

describe('runValidation', () => {
  let root: string, backups: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-')); backups = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-bak-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(backups, { recursive: true, force: true }); });

  const keyphrases = [...Array.from({ length: 160 }, (_, i) => `filler topic ${i}`), 'noisy sanctions phrase', 'real gas phrase'];
  const corpus = {
    days: 5,
    items: [
      ...Array.from({ length: 14 }, (_, i) => item(`n${i}`, `blah noisy sanctions phrase ${i}`)),
      ...Array.from({ length: 14 }, (_, i) => item(`r${i}`, `refinery news real gas phrase ${i}`)),
    ],
  };
  const common = (apply: boolean, names: string[]) => ({ names, apply, floor: 150, backupDir: backups, options: DEFAULT_VALIDATE_OPTIONS });

  it('report only: judges through the real gate path (prompt, schema, logging) and changes nothing on disk', async () => {
    writeProfile(root, 'kxa', { keyphrases });
    const { anthropic, calls } = fakeAnthropic();
    const before = fs.readFileSync(path.join(root, 'kxa', 'keyphrases.json'), 'utf8');
    const r = await runValidation(common(false, ['kxa']), { anthropic, corpus, tradesRoot: root, log: () => {} });
    expect(r.validations[0].verdicts.find((v) => v.phrase === 'noisy sanctions phrase')?.action).toBe('remove');
    expect(r.validations[0].verdicts.find((v) => v.phrase === 'real gas phrase')?.action).toBe('keep');
    expect(r.trims).toEqual({});
    expect(fs.readFileSync(path.join(root, 'kxa', 'keyphrases.json'), 'utf8')).toBe(before);
    // the strict audit prompt went out: system built from the bank, article wrapped as untrusted, verdict schema, no temperature
    expect(calls[0].system).toContain('audit the keyword list');
    expect(String(calls[0].messages[0].content)).toContain('<article>');
    expect(calls[0].output_config.format.schema.required).toEqual(['reason', 'relevant']);
    expect(calls[0]).not.toHaveProperty('temperature');
    expect(r.totalCalls).toBe(24);
    expect(r.spendUsd).toBeGreaterThan(0);
  });

  it('apply: trims the rejected phrase, keeps the good one, backs the old list up', async () => {
    writeProfile(root, 'kxb', { keyphrases });
    const { anthropic } = fakeAnthropic();
    const r = await runValidation(common(true, ['kxb']), { anthropic, corpus, tradesRoot: root, log: () => {} });
    expect(r.trims['kxb'].removed).toEqual(['noisy sanctions phrase']);
    const after = loadProfile('kxb', root).keyphrases;
    expect(after).not.toContain('noisy sanctions phrase');
    expect(after).toContain('real gas phrase');
    expect(fs.existsSync(r.trims['kxb'].backupPath!)).toBe(true);
  });

  it('never edits the hand-pinned live profile, even with apply: it is reported and skipped', async () => {
    writeProfile(root, 'kxlive', { keyphrases, profile: { ledgerPath: 'data/decisions.db', consumerGroup: 'execmod' } });
    const { anthropic } = fakeAnthropic();
    const before = fs.readFileSync(path.join(root, 'kxlive', 'keyphrases.json'), 'utf8');
    const logs: string[] = [];
    const r = await runValidation(common(true, ['kxlive']), { anthropic, corpus, tradesRoot: root, log: (l) => logs.push(l) });
    expect(r.trims).toEqual({});
    expect(fs.readFileSync(path.join(root, 'kxlive', 'keyphrases.json'), 'utf8')).toBe(before);
    expect(logs.join('\n')).toMatch(/live profile.*not edited/i);
  });

  it('leaves no temporary ledger behind', async () => {
    writeProfile(root, 'kxc', { keyphrases });
    const { anthropic } = fakeAnthropic();
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('validate-bank-')).length;
    await runValidation(common(false, ['kxc']), { anthropic, corpus, tradesRoot: root, log: () => {} });
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('validate-bank-')).length).toBe(tmpBefore);
  });
});

describe('build-trade --validate flag', () => {
  it('is accepted, and absent from the parsed args unless given (existing callers see no new key)', () => {
    expect(parseBuildArgs(['--series', 'KXA', '--validate'])).toMatchObject({ seriesTicker: 'KXA', validate: true });
    expect('validate' in parseBuildArgs(['--series', 'KXA'])).toBe(false);
  });
  it('rejects a duplicate --validate', () => {
    expect(() => parseBuildArgs(['--series', 'KXA', '--validate', '--validate'])).toThrow(/duplicate/);
  });
});
