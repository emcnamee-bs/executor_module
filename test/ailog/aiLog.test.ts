// test/ailog/aiLog.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { recordAiCall, sha12, type AiCallRecord } from '../../src/ailog/aiLog.js';

function fullRecord(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    trade: 'kxaaagasw',
    itemId: '1790000000000-abc123',
    stage: 'gate',
    provider: 'ollama',
    model: 'qwen2.5:7b-instruct-q4_K_M',
    promptSha: 'aabbccddeeff',
    requestJson: JSON.stringify([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }]),
    rawOutput: '{"reason":"barge delay","relevant":true}',
    parsedJson: '{"reason":"barge delay","relevant":true}',
    reasoning: 'barge delay',
    verdict: 'relevant=true',
    excerptSource: 'page',
    tripwireHit: true,
    wallMs: 24500,
    loadMs: 1200,
    promptTokens: 540,
    outputTokens: 27,
    stopReason: 'stop',
    error: null,
    ...overrides,
  };
}

describe('ai_calls', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ailog-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exists on a freshly opened ledger, with its item index and the paper_positions table', () => {
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE name IN ('ai_calls','paper_positions','idx_ai_calls_item')`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names.sort()).toEqual(['ai_calls', 'idx_ai_calls_item', 'paper_positions']);
  });

  it('round-trips every field of a fully populated record', () => {
    const id = recordAiCall(db, fullRecord());
    const row = db.prepare(`SELECT * FROM ai_calls WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row).toMatchObject({
      trade: 'kxaaagasw',
      item_id: '1790000000000-abc123',
      stage: 'gate',
      provider: 'ollama',
      model: 'qwen2.5:7b-instruct-q4_K_M',
      prompt_sha: 'aabbccddeeff',
      raw_output: '{"reason":"barge delay","relevant":true}',
      parsed_json: '{"reason":"barge delay","relevant":true}',
      reasoning: 'barge delay',
      verdict: 'relevant=true',
      excerpt_source: 'page',
      tripwire_hit: 1,
      wall_ms: 24500,
      load_ms: 1200,
      prompt_tokens: 540,
      output_tokens: 27,
      stop_reason: 'stop',
      error: null,
    });
    expect(JSON.parse(row.request_json as string)).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
    expect(typeof row.called_at).toBe('string');
    expect((row.called_at as string).length).toBeGreaterThan(10);
  });

  it('writes a failure row: error set, outputs null, tripwire false stored as 0', () => {
    const id = recordAiCall(
      db,
      fullRecord({
        stage: 'triage',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        rawOutput: null,
        parsedJson: null,
        reasoning: null,
        verdict: null,
        excerptSource: null,
        tripwireHit: false,
        wallMs: null,
        loadMs: null,
        promptTokens: null,
        outputTokens: null,
        stopReason: 'max_tokens',
        error: 'Sonnet triage response was truncated at max_tokens',
      })
    );
    const row = db.prepare(`SELECT * FROM ai_calls WHERE id = ?`).get(id) as Record<string, unknown>;
    expect(row.error).toBe('Sonnet triage response was truncated at max_tokens');
    expect(row.raw_output).toBeNull();
    expect(row.parsed_json).toBeNull();
    expect(row.tripwire_hit).toBe(0);
    expect(row.stop_reason).toBe('max_tokens');
  });

  it('accepts a NULL item_id (profile-build calls) and returns increasing ids', () => {
    const a = recordAiCall(db, fullRecord({ itemId: null, stage: 'build_bank' }));
    const b = recordAiCall(db, fullRecord({ itemId: null, stage: 'build_keyphrases' }));
    expect(b).toBeGreaterThan(a);
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ai_calls WHERE item_id IS NULL`).get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('a pre-existing ledger without the new tables gains them on the next openLedger', () => {
    db.exec(`DROP TABLE ai_calls; DROP TABLE paper_positions;`);
    db.close();
    db = openLedger(path.join(dir, 'test.db'));
    const id = recordAiCall(db, fullRecord());
    expect(id).toBeGreaterThan(0);
    const t = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'paper_positions'`).get();
    expect(t).toBeDefined();
  });
});

describe('sha12', () => {
  it('is 12 lowercase hex characters, stable, and input-sensitive', () => {
    expect(sha12('hello')).toMatch(/^[0-9a-f]{12}$/);
    expect(sha12('hello')).toBe(sha12('hello'));
    expect(sha12('hello')).not.toBe(sha12('hello '));
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(sha12('hello')).toBe('2cf24dba5fb0');
  });
});
