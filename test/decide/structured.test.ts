import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { callStructured, type StructuredCall } from '../../src/decide/structured.js';

function fakeClient(response: unknown | (() => never)): { client: Anthropic; calls: any[] } {
  const calls: any[] = [];
  const client = {
    messages: {
      parse: async (params: unknown) => {
        calls.push(params);
        if (typeof response === 'function') return (response as () => never)();
        return response;
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('callStructured', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = (client: Anthropic, over: Partial<StructuredCall> = {}): StructuredCall => ({
    client,
    db,
    trade: 'kxaaagasw',
    itemId: 'item-1',
    stage: 'triage',
    maxTokens: 1024,
    system: 'SYSTEM TEXT',
    user: 'USER TEXT',
    schema: { type: 'object' },
    excerptSource: 'page',
    tripwireHit: false,
    summarize: (p) => ({ verdict: String((p as any).verdict), reasoning: String((p as any).reason) }),
    ...over,
  });

  const ok = {
    stop_reason: 'end_turn',
    parsed_output: { verdict: 'escalate', reason: 'supply chain link' },
    content: [{ type: 'text', text: '{"verdict":"escalate","reason":"supply chain link"}' }],
    usage: { input_tokens: 321, output_tokens: 17 },
  };

  it('sends system, user, schema and max_tokens, and returns parsed_output', async () => {
    const { client, calls } = fakeClient(ok);
    const out = await callStructured(base(client));
    expect(out).toEqual(ok.parsed_output);
    expect(calls[0].model).toBe('claude-sonnet-5');
    expect(calls[0].system).toBe('SYSTEM TEXT');
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'USER TEXT' }]);
    expect(calls[0].max_tokens).toBe(1024);
    expect(calls[0].output_config.format.schema).toEqual({ type: 'object' });
  });

  it('logs one row with prompts, raw output, verdict, reasoning, tokens and stop reason', async () => {
    const { client } = fakeClient(ok);
    await callStructured(base(client, { tripwireHit: true }));
    const rows = db.prepare('SELECT * FROM ai_calls').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trade: 'kxaaagasw', item_id: 'item-1', stage: 'triage', provider: 'anthropic', model: 'claude-sonnet-5',
      verdict: 'escalate', reasoning: 'supply chain link', excerpt_source: 'page', tripwire_hit: 1,
      prompt_tokens: 321, output_tokens: 17, stop_reason: 'end_turn', error: null,
    });
    expect(rows[0].raw_output).toContain('supply chain link');
    expect(JSON.parse(rows[0].request_json).system).toBe('SYSTEM TEXT');
    expect(rows[0].prompt_sha).toMatch(/^[0-9a-f]{12}$/);
    expect(rows[0].wall_ms).toBeGreaterThanOrEqual(0);
  });

  it('throws naming max_tokens on truncation, and still logs the row with an error', async () => {
    const { client } = fakeClient({ ...ok, stop_reason: 'max_tokens', parsed_output: null });
    await expect(callStructured(base(client))).rejects.toThrow(/triage response was truncated at max_tokens/);
    const row = db.prepare('SELECT stop_reason, error FROM ai_calls').get() as any;
    expect(row.stop_reason).toBe('max_tokens');
    expect(row.error).toMatch(/max_tokens/);
  });

  it('throws when parsed_output is missing and logs the error', async () => {
    const { client } = fakeClient({ ...ok, parsed_output: null });
    await expect(callStructured(base(client))).rejects.toThrow(/did not return parseable structured output for the triage step/);
    expect((db.prepare('SELECT error FROM ai_calls').get() as any).error).toMatch(/parseable/);
  });

  it('logs and rethrows an API failure', async () => {
    const { client } = fakeClient(() => {
      throw new Error('429 rate limited');
    });
    await expect(callStructured(base(client))).rejects.toThrow('429 rate limited');
    expect((db.prepare('SELECT error FROM ai_calls').get() as any).error).toBe('429 rate limited');
  });

  it('omits the system parameter when it is empty', async () => {
    const { client, calls } = fakeClient(ok);
    await callStructured(base(client, { system: '' }));
    expect('system' in calls[0]).toBe(false);
  });

  it('does not let a throwing summarize hide the call: the row is written with verdict "unsummarizable"', async () => {
    const { client } = fakeClient(ok);
    await callStructured(base(client, { summarize: () => { throw new Error('boom'); } }));
    expect((db.prepare('SELECT verdict FROM ai_calls').get() as any).verdict).toBe('unsummarizable');
  });
});
