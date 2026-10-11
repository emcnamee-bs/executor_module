import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { buildGateClient } from '../../src/decide/gateProvider.js';
import { resolveGateConfig } from '../../src/decide/anthropicGateClient.js';

describe('buildGateClient (what main() wires into the pipeline)', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const calls: any[] = [];
  const anthropic = {
    messages: {
      create: async (p: any) => {
        calls.push(p);
        return { content: [{ type: 'text', text: '{"reason":"r","relevant":false}' }], usage: { input_tokens: 5, output_tokens: 5 }, stop_reason: 'end_turn' };
      },
    },
  } as unknown as Anthropic;

  it('ollama (the default): the profile local gate, no model override, and Anthropic is never called', async () => {
    const g = buildGateClient(resolveGateConfig({}), anthropic, db);
    expect(g.provider).toBe('ollama');
    expect(g.model).toBeUndefined();
    await expect(g.client.chatDetailed('m', 'p', {})).rejects.toThrow(); // no Ollama on this port; the point is it did not use Anthropic
    expect(calls).toHaveLength(0);
  });

  it('anthropic: Claude client, the configured model, and the gate call really goes through Anthropic', async () => {
    const g = buildGateClient(resolveGateConfig({ GATE_PROVIDER: 'anthropic' }), anthropic, db);
    expect(g.provider).toBe('anthropic');
    expect(g.model).toBe('claude-haiku-5-5');
    const r = await g.client.chatDetailed(g.model!, 'p', {});
    expect(r.content).toContain('relevant');
    expect(calls).toHaveLength(1);
  });
});
