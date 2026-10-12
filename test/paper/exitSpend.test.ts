// test/paper/exitSpend.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { estimateExitSpendUsd, checkExitBudget, resetExitBudgetAlertForTests } from '../../src/paper/exitSpend.js';

describe('exit review budget', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exitspend-'));
    db = openLedger(path.join(dir, 'l.db'));
    resetExitBudgetAlertForTests();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const NOW = Date.parse('2026-10-12T12:00:00Z');
  const call = (stage: string, model: string, inTok: number, outTok: number, at: string) =>
    db.prepare(
      `INSERT INTO ai_calls (called_at, trade, item_id, stage, provider, model, prompt_sha, request_json, prompt_tokens, output_tokens, tripwire_hit)
       VALUES (?, 't', 'i', ?, 'anthropic', ?, 'sha', '{}', ?, ?, 0)`
    ).run(at, stage, model, inTok, outTok);

  it('sums only exit_review calls from the current UTC day, per model price', () => {
    call('exit_review', 'claude-haiku-5-5', 1_000_000, 1_000_000, '2026-10-12T01:00:00.000Z'); // 0.1 + 0.5
    call('exit_review', 'claude-haiku-5-5', 1_000_000, 0, '2026-10-11T23:59:59.000Z'); // yesterday: ignored
    call('decide', 'claude-sonnet-5', 5_000_000, 5_000_000, '2026-10-12T01:00:00.000Z'); // other stage: ignored
    expect(estimateExitSpendUsd(db, NOW)).toBeCloseTo(0.6);
  });

  it('an unlisted model is costed at a conservative non-zero rate', () => {
    call('exit_review', 'claude-something-new', 1_000_000, 0, '2026-10-12T01:00:00.000Z');
    expect(estimateExitSpendUsd(db, NOW)).toBeGreaterThan(0);
  });

  it('alerts once per UTC day when over the cap, and never when under', () => {
    const alerts: string[] = [];
    call('exit_review', 'claude-haiku-5-5', 1_000_000, 1_000_000, '2026-10-12T01:00:00.000Z'); // 0.6
    checkExitBudget(db, 5, (m) => alerts.push(m), NOW);
    expect(alerts).toEqual([]);
    checkExitBudget(db, 0.5, (m) => alerts.push(m), NOW);
    checkExitBudget(db, 0.5, (m) => alerts.push(m), NOW + 1000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/EXIT-REVIEW BUDGET/);
    checkExitBudget(db, 0.5, (m) => alerts.push(m), NOW + 24 * 3600 * 1000); // next day, no spend today yet
    expect(alerts).toHaveLength(1);
  });

  it('never throws (a broken db must not stop reviews)', () => {
    db.close();
    expect(() => checkExitBudget(db, 1, () => {}, NOW)).not.toThrow();
    db = openLedger(path.join(dir, 'l.db'));
  });
});
