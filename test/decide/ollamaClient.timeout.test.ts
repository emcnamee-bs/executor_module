// Final review I5: a gate call queued behind other processes on a shared CPU-only
// Ollama must end at a known, explicit deadline (not undici's implicit 300 s headers
// timeout), be recorded as a failure, and count only against ITS OWN ledger.
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createOllamaClient,
  resolveOllamaTimeoutMs,
  DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS,
} from '../../src/decide/ollamaClient.js';
import { openLedger, isTradingHalted } from '../../src/decide/ledger.js';
import { runGate } from '../../src/decide/gate.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';
import * as alertModule from '../../src/alert.js';

const servers: http.Server[] = [];
const dirs: string[] = [];

/** An Ollama that accepts the request and never answers (a stalled queue). */
async function hangingServer(): Promise<string> {
  const server = http.createServer(() => { /* never respond */ });
  await new Promise<void>((r) => server.listen(0, r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-timeout-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    s.close();
  }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Ollama request timeout', () => {
  it('defaults to an explicit 240 s (under undici\'s 300 s headers timeout) and reads OLLAMA_REQUEST_TIMEOUT_MS', () => {
    expect(DEFAULT_OLLAMA_REQUEST_TIMEOUT_MS).toBe(240_000);
    expect(resolveOllamaTimeoutMs({})).toBe(240_000);
    expect(resolveOllamaTimeoutMs({ OLLAMA_REQUEST_TIMEOUT_MS: '90000' })).toBe(90_000);
    for (const bad of ['', 'abc', '0', '-5', '1.5', 'Infinity']) {
      expect(() => resolveOllamaTimeoutMs({ OLLAMA_REQUEST_TIMEOUT_MS: bad })).toThrow(/OLLAMA_REQUEST_TIMEOUT_MS/);
    }
  });

  it('aborts a stalled request at the deadline with a clear message and records an ollama_errors row', async () => {
    const baseUrl = await hangingServer();
    const db = openLedger(path.join(tmp(), 'decisions.db'));
    const client = createOllamaClient(baseUrl, db, { timeoutMs: 150 });
    const t0 = Date.now();
    await expect(client.chatDetailed('qwen2.5:7b-instruct-q4_K_M', 'x')).rejects.toThrow(
      /Ollama request .* model qwen2\.5:7b-instruct-q4_K_M timed out after 150 ms/
    );
    expect(Date.now() - t0).toBeLessThan(5_000);
    const row = db.prepare('SELECT model, error_message FROM ollama_errors').get() as { model: string; error_message: string };
    expect(row.error_message).toMatch(/timed out after 150 ms/);
    db.close();
  });

  it('a gate timeout is a recorded gate failure: one ai_calls row with the timeout error', async () => {
    const baseUrl = await hangingServer();
    const dir = tmp();
    writeProfile(path.join(dir, 'trades'), 'kxaaagasw');
    const loaded = loadProfile('kxaaagasw', path.join(dir, 'trades'));
    const db = openLedger(path.join(dir, 'decisions.db'));
    const ollama = createOllamaClient(baseUrl, db, { timeoutMs: 100 });
    await expect(
      runGate({ ollama, db, profile: loaded }, { itemId: 'item-1', excerptText: 'refinery fire', excerptSource: 'page' })
    ).rejects.toThrow(/timed out/);
    const rows = db.prepare(`SELECT stage, verdict, error FROM ai_calls`).all() as Array<{ stage: string; verdict: string | null; error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe('gate');
    expect(rows[0].verdict).toBeNull();
    expect(rows[0].error).toMatch(/timed out after 100 ms/);
    db.close();
  });

  it('timeouts on a PAPER ledger trip only that ledger: the live ledger stays un-halted (breakers are per ledger)', async () => {
    vi.spyOn(alertModule, 'sendAlert').mockResolvedValue();
    const baseUrl = await hangingServer();
    const dir = tmp();
    const paperDb = openLedger(path.join(dir, 'paper.db'));
    const liveDb = openLedger(path.join(dir, 'live.db'));
    const paperClient = createOllamaClient(baseUrl, paperDb, { timeoutMs: 50 });
    for (let i = 0; i < 6; i++) {
      await expect(paperClient.chatDetailed('qwen2.5:7b-instruct-q4_K_M', 'x')).rejects.toThrow(/timed out/);
    }
    expect(isTradingHalted(paperDb)).toBe(true);
    expect(isTradingHalted(liveDb)).toBe(false);
    expect((liveDb.prepare('SELECT COUNT(*) AS n FROM ollama_errors').get() as { n: number }).n).toBe(0);
    paperDb.close();
    liveDb.close();
  });
});
