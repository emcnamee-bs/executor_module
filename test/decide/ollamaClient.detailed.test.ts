// test/decide/ollamaClient.detailed.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOllamaClient } from '../../src/decide/ollamaClient.js';
import { openLedger } from '../../src/decide/ledger.js';

interface Captured {
  body: Record<string, any>;
}

const servers: http.Server[] = [];

async function startServer(
  respond: (cap: Captured, res: http.ServerResponse) => void
): Promise<{ baseUrl: string; captured: Captured }> {
  const captured: Captured = { body: {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured.body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      respond(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, captured };
}

function json(res: http.ServerResponse, payload: object, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

describe('OllamaClient.chatDetailed', () => {
  it('sends the system message first, then the user prompt, and maps every option', async () => {
    const { baseUrl, captured } = await startServer((_c, res) => json(res, { message: { content: '{"ok":true}' } }));
    const client = createOllamaClient(baseUrl);
    await client.chatDetailed('qwen2.5:7b-instruct-q4_K_M', 'USER PROMPT', {
      system: 'SYSTEM PROMPT',
      format: { type: 'object' },
      temperature: 0,
      numCtx: 3072,
      numPredict: 200,
      keepAlive: '10m',
      think: false,
    });
    expect(captured.body.model).toBe('qwen2.5:7b-instruct-q4_K_M');
    expect(captured.body.stream).toBe(false);
    expect(captured.body.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'USER PROMPT' },
    ]);
    expect(captured.body.format).toEqual({ type: 'object' });
    expect(captured.body.options).toEqual({ temperature: 0, num_ctx: 3072, num_predict: 200 });
    expect(captured.body.keep_alive).toBe('10m');
    expect(captured.body.think).toBe(false);
  });

  it('accepts a numeric keepAlive (0 = unload immediately) and temperature 0', async () => {
    const { baseUrl, captured } = await startServer((_c, res) => json(res, { message: { content: 'x' } }));
    await createOllamaClient(baseUrl).chatDetailed('m', 'p', { keepAlive: 0, temperature: 0 });
    expect(captured.body.keep_alive).toBe(0);
    expect(captured.body.options).toEqual({ temperature: 0 });
  });

  it('omits system, options, keep_alive, think and format when none are given', async () => {
    const { baseUrl, captured } = await startServer((_c, res) => json(res, { message: { content: 'x' } }));
    await createOllamaClient(baseUrl).chatDetailed('m', 'only user');
    expect(captured.body.messages).toEqual([{ role: 'user', content: 'only user' }]);
    for (const key of ['options', 'keep_alive', 'think', 'format']) {
      expect(key in captured.body).toBe(false);
    }
  });

  it('returns content plus timings converted from nanoseconds to milliseconds', async () => {
    const { baseUrl } = await startServer((_c, res) =>
      json(res, {
        message: { content: '{"reason":"r","relevant":true}' },
        load_duration: 2_500_000_000,
        total_duration: 7_000_000_000,
        prompt_eval_count: 540,
        eval_count: 24,
        done_reason: 'stop',
      })
    );
    const result = await createOllamaClient(baseUrl).chatDetailed('m', 'p');
    expect(result).toEqual({
      content: '{"reason":"r","relevant":true}',
      loadMs: 2500,
      totalMs: 7000,
      promptEvalCount: 540,
      evalCount: 24,
      doneReason: 'stop',
    });
  });

  it('defaults missing timing fields to 0 and doneReason to null', async () => {
    const { baseUrl } = await startServer((_c, res) => json(res, { message: { content: 'x' } }));
    const result = await createOllamaClient(baseUrl).chatDetailed('m', 'p');
    expect(result).toEqual({ content: 'x', loadMs: 0, totalMs: 0, promptEvalCount: 0, evalCount: 0, doneReason: null });
  });

  it('chat() still returns just the text and sends a single user message', async () => {
    const { baseUrl, captured } = await startServer((_c, res) => json(res, { message: { content: 'PONG' } }));
    const text = await createOllamaClient(baseUrl).chat('m', 'ping', { format: { type: 'object' } });
    expect(text).toBe('PONG');
    expect(captured.body.messages).toEqual([{ role: 'user', content: 'ping' }]);
    expect(captured.body.format).toEqual({ type: 'object' });
  });

  it('throws naming the model on a non-200 and records an ollama_errors row when given a db', async () => {
    const { baseUrl } = await startServer((_c, res) => json(res, { error: 'model not found' }, 404));
    const dir = mkdtempSync(path.join(tmpdir(), 'ollama-detailed-'));
    const db = openLedger(path.join(dir, 'test.db'));
    try {
      const client = createOllamaClient(baseUrl, db);
      await expect(client.chatDetailed('ghost:1b', 'p')).rejects.toThrow(/ghost:1b failed: 404/);
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ollama_errors WHERE model = 'ghost:1b'`).get() as { n: number };
      expect(n.n).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the response has no message content', async () => {
    const { baseUrl } = await startServer((_c, res) => json(res, { message: {} }));
    await expect(createOllamaClient(baseUrl).chatDetailed('m', 'p')).rejects.toThrow(/no message content for model m/);
  });
});
