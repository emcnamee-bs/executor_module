import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import * as alertModule from '../../src/alert.js';
import { openLedger, isTradingHalted } from '../../src/decide/ledger.js';
import { recordAiCall } from '../../src/ailog/aiLog.js';
import { GATE_SCHEMA, runGate } from '../../src/decide/gate.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import {
  createAnthropicGateClient,
  gateCostUsd,
  gateSpendTodayUsd,
  resolveGateConfig,
  DEFAULT_GATE_ANTHROPIC_MODEL,
  DEFAULT_GATE_DAILY_USD_CAP,
} from '../../src/decide/anthropicGateClient.js';

const HAIKU = 'claude-haiku-5-5';
const OK_TEXT = '{"reason":"barges carry petroleum products","relevant":true}';

function stubAnthropic(reply: () => any) {
  const calls: Array<{ params: any; opts: any }> = [];
  const anthropic = {
    messages: {
      create: async (params: any, opts: any) => {
        calls.push({ params, opts });
        return reply();
      },
    },
  } as unknown as Anthropic;
  return { anthropic, calls };
}
const okReply = (text = OK_TEXT, usage = { input_tokens: 1400, output_tokens: 80 }, stop = 'end_turn') => () => ({
  content: [{ type: 'text', text }],
  usage,
  stop_reason: stop,
});

describe('resolveGateConfig', () => {
  it('defaults to the local Ollama gate so nothing changes unless a trade opts in', () => {
    expect(resolveGateConfig({}).provider).toBe('ollama');
  });
  it('anthropic defaults to Haiku 5.5 and a daily cap', () => {
    const c = resolveGateConfig({ GATE_PROVIDER: 'anthropic' });
    expect(c).toMatchObject({ provider: 'anthropic', anthropicModel: HAIKU, dailyUsdCap: DEFAULT_GATE_DAILY_USD_CAP });
    expect(DEFAULT_GATE_ANTHROPIC_MODEL).toBe(HAIKU);
  });
  it('reads an explicit daily cap', () => {
    expect(resolveGateConfig({ GATE_PROVIDER: 'anthropic', GATE_DAILY_USD_CAP: '0.25' }).dailyUsdCap).toBe(0.25);
  });
  it('refuses an unknown provider, a bad cap, and a model with no known price', () => {
    expect(() => resolveGateConfig({ GATE_PROVIDER: 'openai' })).toThrow(/GATE_PROVIDER/);
    expect(() => resolveGateConfig({ GATE_PROVIDER: 'anthropic', GATE_DAILY_USD_CAP: '-1' })).toThrow(/GATE_DAILY_USD_CAP/);
    expect(() => resolveGateConfig({ GATE_PROVIDER: 'anthropic', GATE_DAILY_USD_CAP: 'abc' })).toThrow(/GATE_DAILY_USD_CAP/);
    expect(() => resolveGateConfig({ GATE_PROVIDER: 'anthropic', GATE_ANTHROPIC_MODEL: 'claude-mystery' })).toThrow(/no known price/);
  });
});

describe('gateCostUsd', () => {
  it('prices Haiku 5.5 at $0.10 in / $0.50 out per million tokens', () => {
    expect(gateCostUsd(HAIKU, 1_000_000, 0)).toBeCloseTo(0.1, 10);
    expect(gateCostUsd(HAIKU, 0, 1_000_000)).toBeCloseTo(0.5, 10);
  });
  it('prices an unknown model at the conservative Haiku-4.5 rate rather than at zero', () => {
    expect(gateCostUsd('whatever', 1_000_000, 1_000_000)).toBeCloseTo(6, 10);
  });
});

describe('createAnthropicGateClient', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-'));
    db = openLedger(path.join(dir, 'l.db'));
    vi.spyOn(alertModule, 'sendAlert').mockResolvedValue(undefined);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends system + user + verdict schema at medium effort, never a temperature, and maps usage', async () => {
    const { anthropic, calls } = stubAnthropic(okReply());
    const client = createAnthropicGateClient(anthropic, db, { dailyUsdCap: 1 });
    const r = await client.chatDetailed(HAIKU, 'the article', { system: 'SYS', format: GATE_SCHEMA, temperature: 0, numCtx: 3072, keepAlive: '10m' });
    const { params } = calls[0];
    expect(params.model).toBe(HAIKU);
    expect(params.system).toBe('SYS');
    expect(params.messages).toEqual([{ role: 'user', content: 'the article' }]);
    expect(params.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: GATE_SCHEMA } });
    expect(params).not.toHaveProperty('temperature');
    expect(params.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(calls[0].opts.timeout).toBeGreaterThan(0);
    expect(r).toMatchObject({ content: OK_TEXT, promptEvalCount: 1400, evalCount: 80, doneReason: 'end_turn', loadMs: 0 });
  });

  it('records an API failure in ollama_errors (same breaker as the local gate) and rethrows', async () => {
    const { anthropic } = stubAnthropic(() => { throw new Error('529 overloaded'); });
    const client = createAnthropicGateClient(anthropic, db, { dailyUsdCap: 1 });
    await expect(client.chatDetailed(HAIKU, 'p', {})).rejects.toThrow(/Anthropic gate request for model claude-haiku-5-5 failed: 529 overloaded/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ollama_errors').get() as { n: number }).n).toBe(1);
  });

  it('five failures inside the window trip the ollama-errors breaker and halt trading', async () => {
    const { anthropic } = stubAnthropic(() => { throw new Error('boom'); });
    const client = createAnthropicGateClient(anthropic, db, { dailyUsdCap: 1 });
    for (let i = 0; i < 5; i++) await expect(client.chatDetailed(HAIKU, 'p', {})).rejects.toThrow();
    expect(isTradingHalted(db)).toBe(true);
  });

  it.each(['refusal', 'max_tokens'])('treats stop_reason %s as an error, never as a verdict', async (stop) => {
    const { anthropic } = stubAnthropic(okReply('{"reason":"x","relevant":true}', { input_tokens: 10, output_tokens: 10 }, stop));
    const client = createAnthropicGateClient(anthropic, db, { dailyUsdCap: 1 });
    await expect(client.chatDetailed(HAIKU, 'p', {})).rejects.toThrow(new RegExp(stop));
    expect((db.prepare('SELECT COUNT(*) AS n FROM ollama_errors').get() as { n: number }).n).toBe(1);
  });

  it('an empty text reply is an error', async () => {
    const { anthropic } = stubAnthropic(() => ({ content: [], usage: { input_tokens: 1, output_tokens: 0 }, stop_reason: 'end_turn' }));
    const client = createAnthropicGateClient(anthropic, db, { dailyUsdCap: 1 });
    await expect(client.chatDetailed(HAIKU, 'p', {})).rejects.toThrow(/no text/);
  });

  describe('daily spend cap (fails closed on cost)', () => {
    const spendRow = (inTok: number, outTok: number, model = HAIKU) =>
      recordAiCall(db, {
        trade: 't', itemId: 'i', stage: 'gate', provider: 'anthropic', model, promptSha: 'x', requestJson: '{}',
        rawOutput: null, parsedJson: null, reasoning: null, verdict: null, excerptSource: 'page', tripwireHit: false,
        wallMs: 1, loadMs: 0, promptTokens: inTok, outputTokens: outTok, stopReason: 'end_turn', error: null,
      });

    it("counts only today's anthropic gate spend", () => {
      spendRow(1_000_000, 0); // $0.10 today
      const old = spendRow(1_000_000, 0);
      db.prepare("UPDATE ai_calls SET called_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(old);
      db.prepare("INSERT INTO ai_calls (trade,stage,provider,model,prompt_sha,request_json,prompt_tokens,output_tokens) VALUES ('t','gate','ollama','q','x','{}',9000000,9000000)").run();
      expect(gateSpendTodayUsd(db)).toBeCloseTo(0.1, 8);
    });

    it('at or over the cap: no API call, the breaker trips (alerting a human), and the call throws', async () => {
      spendRow(5_000_000, 0); // $0.50
      const { anthropic, calls } = stubAnthropic(okReply());
      const client = createAnthropicGateClient(anthropic, db, { dailyUsdCap: 0.5 });
      await expect(client.chatDetailed(HAIKU, 'p', {})).rejects.toThrow(/daily spend cap/);
      expect(calls).toHaveLength(0);
      expect(isTradingHalted(db)).toBe(true);
      expect(alertModule.sendAlert).toHaveBeenCalledWith(expect.stringMatching(/gate.*spend cap/i));
    });

    it('steady state: the same trigger for days stays bounded by the cap', async () => {
      const profDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-ss-'));
      try {
        writeProfile(profDir, 'kxaaagasw');
        const loaded = loadProfile('kxaaagasw', profDir);
        const { anthropic, calls } = stubAnthropic(okReply());
        const cap = 0.01;
        const ollama = createAnthropicGateClient(anthropic, db, { dailyUsdCap: cap });
        for (let i = 0; i < 1000; i++) {
          await runGate(
            { ollama, db, profile: loaded, provider: 'anthropic', model: HAIKU },
            { itemId: `item-${i}`, excerptText: 'same article again', excerptSource: 'page' }
          ).catch(() => undefined);
        }
        const perCall = gateCostUsd(HAIKU, 1400, 80);
        expect(calls.length).toBeLessThanOrEqual(Math.ceil(cap / perCall));
        expect(calls.length).toBeGreaterThan(0);
        expect(isTradingHalted(db)).toBe(true);
      } finally {
        fs.rmSync(profDir, { recursive: true, force: true });
      }
    });
  });
});

describe('createAnthropicGateClient through the real Anthropic SDK', () => {
  it('serialises output_config and no temperature over HTTP, and parses the reply', async () => {
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        bodies.push({ url: req.url, body: JSON.parse(b) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: HAIKU,
          content: [{ type: 'text', text: OK_TEXT }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1500, output_tokens: 60 },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agc-http-'));
    const db = openLedger(path.join(dir, 'l.db'));
    try {
      const anthropic = new Anthropic({ apiKey: 'k', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
      const client = createAnthropicGateClient(anthropic, db, { dailyUsdCap: 1 });
      const r = await client.chatDetailed(HAIKU, 'article', { system: 'SYS', format: GATE_SCHEMA, temperature: 0 });
      expect(r.content).toBe(OK_TEXT);
      expect(bodies[0].url).toBe('/v1/messages');
      expect(bodies[0].body.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: GATE_SCHEMA } });
      expect(bodies[0].body).not.toHaveProperty('temperature');
      expect(bodies[0].body.system).toBe('SYS');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      await new Promise((r) => server.close(r));
    }
  });
});
