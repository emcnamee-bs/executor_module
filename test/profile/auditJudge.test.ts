import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile, GOOD_BANK } from './fixtures.js';
import { buildAuditSystem, makeAuditJudge, AUDIT_SCHEMA } from '../../src/profile/auditJudge.js';
import type { OllamaClient, OllamaChatResult } from '../../src/decide/ollamaClient.js';
import type { CorpusItem } from '../../src/profile/validate.js';

const item = (id: string, text: string): CorpusItem => ({ id, source: 'bluesky_geopolitics', trustTier: 4, text, ts: '2026-10-01T00:00:00Z' });

function fakeClient(reply: (user: string) => string, usage = { promptEvalCount: 1500, evalCount: 60 }) {
  const calls: Array<{ model: string; user: string; options: any }> = [];
  const client = {
    chat: async () => '',
    chatDetailed: async (model: string, user: string, options: any): Promise<OllamaChatResult> => {
      calls.push({ model, user, options });
      return { content: reply(user), loadMs: 0, totalMs: 1, doneReason: 'end_turn', ...usage };
    },
  } as unknown as OllamaClient;
  return { client, calls };
}

describe('buildAuditSystem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  writeProfile(dir, 'kxa');
  const loaded = loadProfile('kxa', dir);

  it('carries the trade, the whole bank, and the strictness rules that separate reports from passing mentions', () => {
    const s = buildAuditSystem(loaded);
    expect(s).toContain(loaded.profile.title);
    expect(s).toContain(GOOD_BANK.split('\n')[2]);
    expect(s).toMatch(/substantive/i);
    expect(s).toMatch(/opinion|commentary|rant/i);
    expect(s).toMatch(/passing mention/i);
    expect(s).toMatch(/untrusted/i);
  });
});

describe('makeAuditJudge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2-'));
  writeProfile(dir, 'kxb');
  const loaded = loadProfile('kxb', dir);

  it('asks the model with the audit system prompt, the verdict schema and the article wrapped as untrusted, and returns its verdict', async () => {
    const { client, calls } = fakeClient((u) => JSON.stringify({ reason: 'r', relevant: u.toLowerCase().includes('refinery') }));
    const usage = { promptTokens: 0, outputTokens: 0, calls: 0 };
    const judge = makeAuditJudge(loaded, client, 'claude-haiku-5-5', usage);
    expect(await judge(item('1', 'Refinery fire cuts output'))).toBe(true);
    expect(await judge(item('2', 'Local bakery wins award'))).toBe(false);
    expect(calls[0].model).toBe('claude-haiku-5-5');
    expect(calls[0].options.system).toBe(buildAuditSystem(loaded));
    expect(calls[0].options.format).toEqual(AUDIT_SCHEMA);
    expect(calls[0].user).toContain('<article>');
    expect(usage).toEqual({ promptTokens: 3000, outputTokens: 120, calls: 2 });
  });

  it('an unparseable or malformed reply is an error (the caller skips it), never a verdict', async () => {
    const usage = { promptTokens: 0, outputTokens: 0, calls: 0 };
    await expect(makeAuditJudge(loaded, fakeClient(() => 'not json').client, 'm', usage)(item('1', 't'))).rejects.toThrow(/not valid JSON/);
    await expect(makeAuditJudge(loaded, fakeClient(() => '{"reason":"x"}').client, 'm', usage)(item('1', 't'))).rejects.toThrow(/relevant/);
  });
});
