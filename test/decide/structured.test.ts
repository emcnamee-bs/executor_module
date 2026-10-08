import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  const brokenDb = { prepare: () => { throw new Error('database is locked'); } } as unknown as Database.Database;

  describe('when the ai_calls write fails', () => {
    afterEach(() => vi.restoreAllMocks());

    it('API error: rejects with the ORIGINAL API error and logs to console.error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client } = fakeClient(() => { throw new Error('429 rate limited'); });
      await expect(callStructured(base(client, { db: brokenDb }))).rejects.toThrow('429 rate limited');
      expect(spy).toHaveBeenCalled();
    });

    it('truncation: rejects with the original max_tokens error and logs to console.error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client } = fakeClient({ ...ok, stop_reason: 'max_tokens', parsed_output: null });
      await expect(callStructured(base(client, { db: brokenDb }))).rejects.toThrow(/max_tokens/);
      expect(spy).toHaveBeenCalled();
    });

    it('null parsed_output: rejects with the original parseable error and logs to console.error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client } = fakeClient({ ...ok, parsed_output: null });
      await expect(callStructured(base(client, { db: brokenDb }))).rejects.toThrow(/parseable/);
      expect(spy).toHaveBeenCalled();
    });

    it('success path: a failing write propagates (deliberate fail-closed: no result without an audit row)', async () => {
      const { client } = fakeClient(ok);
      await expect(callStructured(base(client, { db: brokenDb }))).rejects.toThrow('database is locked');
    });
  });

  it('request_json contains the schema object and max_tokens', async () => {
    const { client } = fakeClient(ok);
    await callStructured(base(client, { schema: { type: 'object', title: 'S' }, maxTokens: 777 }));
    const req = JSON.parse((db.prepare('SELECT request_json FROM ai_calls').get() as any).request_json);
    expect(req.schema).toEqual({ type: 'object', title: 'S' });
    expect(req.max_tokens).toBe(777);
  });

  it('ignores non-text content blocks when building raw_output', async () => {
    const { client } = fakeClient({
      ...ok,
      content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }, { type: 'text', text: 'ONLY TEXT' }],
    });
    await callStructured(base(client));
    expect((db.prepare('SELECT raw_output FROM ai_calls').get() as any).raw_output).toBe('ONLY TEXT');
  });

  it('prompt_sha is stable for the same system prompt and differs for another', async () => {
    const { client } = fakeClient(ok);
    await callStructured(base(client));
    await callStructured(base(client));
    await callStructured(base(client, { system: 'OTHER SYSTEM' }));
    const shas = (db.prepare('SELECT prompt_sha FROM ai_calls ORDER BY id').all() as any[]).map((r) => r.prompt_sha);
    expect(shas[0]).toBe(shas[1]);
    expect(shas[2]).not.toBe(shas[0]);
  });

  it('on an API error the row has null tokens and stop reason but a non-null wall_ms', async () => {
    const { client } = fakeClient(() => { throw new Error('boom'); });
    await expect(callStructured(base(client))).rejects.toThrow('boom');
    const row = db.prepare('SELECT * FROM ai_calls').get() as any;
    expect(row.prompt_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.stop_reason).toBeNull();
    expect(row.wall_ms).not.toBeNull();
  });
});
