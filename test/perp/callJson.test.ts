import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { callJson, modelCostUsd, modelSpendTodayUsd, SpendCapError } from '../../src/perp/model/callJson.js';
import { openPerpDb } from '../../src/perp/store/db.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const schema = z.object({ relevant: z.boolean() });
const jsonSchema = { type: 'object', properties: { relevant: { type: 'boolean' } }, required: ['relevant'], additionalProperties: false };

function client(reply: unknown, calls: unknown[] = []) {
  return {
    messages: {
      create: async (params: unknown, options: unknown) => {
        calls.push({ params, options });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}
const ok = (text: string, inTok = 1000, outTok = 100) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: inTok, output_tokens: outTok } });
const base = (db: ReturnType<typeof openPerpDb>, c: ReturnType<typeof client>, over = {}) => ({
  client: c, db, model: 'claude-haiku-5-5', stage: 'gate', itemId: 'i1', system: 's', user: 'u', jsonSchema, schema,
  maxTokens: 256, dailyUsdCap: 1, now: () => NOW, ...over,
});
const rows = (db: ReturnType<typeof openPerpDb>) => db.prepare('SELECT stage, model, ok, error, prompt_tokens, output_tokens FROM model_calls').all() as Array<Record<string, unknown>>;

describe('modelCostUsd', () => {
  it('prices Haiku 5.5 and Sonnet 5.5, and an unknown model at a high default', () => {
    expect(modelCostUsd('claude-haiku-5-5', 1000, 100)).toBeCloseTo(0.00015, 8);
    expect(modelCostUsd('claude-sonnet-5-5', 1000, 100)).toBeCloseTo(0.003, 8);
    expect(modelCostUsd('mystery', 1_000_000, 0)).toBe(3);
  });
});

describe('callJson', () => {
  it('returns the schema-validated object, sends a json_schema output config, and records one ok row with cost', async () => {
    const db = openPerpDb(':memory:');
    const calls: Array<{ params: Record<string, unknown>; options: unknown }> = [];
    const out = await callJson(base(db, client(ok('{"relevant":true}'), calls as unknown[])));
    expect(out).toEqual({ relevant: true });
    expect((calls[0].params as { output_config: { format: { type: string } } }).output_config.format.type).toBe('json_schema');
    expect(rows(db)).toEqual([{ stage: 'gate', model: 'claude-haiku-5-5', ok: 1, error: null, prompt_tokens: 1000, output_tokens: 100 }]);
    expect(modelSpendTodayUsd(db, NOW)).toBeCloseTo(0.00015, 8);
  });

  it('throws on invalid JSON, schema mismatch, refusal and truncation, recording each once as ok=0 (review focus 4)', async () => {
    for (const reply of [
      ok('not json'),
      ok('{"relevant":"yes"}'),
      { ...ok('{"relevant":true}'), stop_reason: 'refusal' },
      { ...ok('{"relevant":tr'), stop_reason: 'max_tokens' },
      { content: [], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 0 } },
    ]) {
      const db = openPerpDb(':memory:');
      await expect(callJson(base(db, client(reply)))).rejects.toThrow();
      const r = rows(db);
      expect(r).toHaveLength(1);
      expect(r[0].ok).toBe(0);
      expect(typeof r[0].error).toBe('string');
    }
  });

  it('records an API error once and rethrows', async () => {
    const db = openPerpDb(':memory:');
    await expect(callJson(base(db, client(new Error('503 overloaded'))))).rejects.toThrow(/503/);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0].ok).toBe(0);
  });

  it('makes no API call and records nothing when the daily cap is reached', async () => {
    const db = openPerpDb(':memory:');
    await callJson(base(db, client(ok('{"relevant":true}', 1_000_000, 0)), { dailyUsdCap: 0.05 })); // costs $0.10
    const calls: unknown[] = [];
    await expect(callJson(base(db, client(ok('{"relevant":true}'), calls), { dailyUsdCap: 0.05 }))).rejects.toBeInstanceOf(SpendCapError);
    expect(calls).toHaveLength(0);
    expect(rows(db)).toHaveLength(1);
  });

  it('counts only today (UTC) toward the cap', async () => {
    const db = openPerpDb(':memory:');
    await callJson(base(db, client(ok('{"relevant":true}', 1_000_000, 0)), { dailyUsdCap: 0.05, now: () => NOW - 86_400_000 }));
    expect(modelSpendTodayUsd(db, NOW)).toBe(0);
    await expect(callJson(base(db, client(ok('{"relevant":true}')), { dailyUsdCap: 0.05 }))).resolves.toEqual({ relevant: true });
  });
});
