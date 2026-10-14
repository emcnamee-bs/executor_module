// The operator scripts run as real child processes (tsx), so argument parsing, exit codes and the refusals are tested
// at the real call site (W1 perp-paper-fund, W12 perp-clear-halt / perp-report).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLedgerLock } from '../../src/decide/ledgerLock.js';
import type { PaperState } from '../../src/perp/broker/paper.js';
import { haltRisk, initialRiskState } from '../../src/perp/risk/state.js';
import { getState, listJournal, loadRiskState, openPerpDb, saveRiskState, setState } from '../../src/perp/store/db.js';

const ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function run(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [TSX, path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perp-scripts-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const dbAt = (name: string, init: (db: ReturnType<typeof openPerpDb>) => void = () => undefined) => {
  const file = path.join(dir, name);
  const db = openPerpDb(file);
  init(db);
  db.close();
  return file;
};

describe('perp-clear-halt (W12)', () => {
  it('clears a halt', () => {
    const file = dbAt('h.db', (db) => saveRiskState(db, haltRisk(initialRiskState(), 'two stop-outs')));
    const r = run('perp-clear-halt.ts', ['--db', file]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/cleared halt \(was: two stop-outs\)/);
    const db = openPerpDb(file);
    expect(loadRiskState(db).halted).toBe(false);
    db.close();
  });
  it('refuses (exit 1) when the bot is not halted, and changes nothing', () => {
    const file = dbAt('n.db');
    const r = run('perp-clear-halt.ts', ['--db', file]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not halted/);
    expect(r.err).toMatch(/--force/);
    const db = openPerpDb(file);
    expect(getState(db, 'killEpoch')).toBeNull();
    expect(listJournal(db, 'halt_cleared', 5)).toHaveLength(0);
    db.close();
  });
  it('--force on a non-halted bot records a fresh kill-switch epoch', () => {
    const file = dbAt('f.db');
    const r = run('perp-clear-halt.ts', ['--db', file, '--force']);
    expect(r.code).toBe(0);
    const db = openPerpDb(file);
    expect(getState(db, 'killEpoch')).not.toBeNull();
    db.close();
  });
  it('a missing db file is an error and is not created; a flag as the --db value is a usage error', () => {
    const missing = path.join(dir, 'missing.db');
    const r = run('perp-clear-halt.ts', ['--db', missing]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/does not exist/);
    expect(fs.existsSync(missing)).toBe(false);
    const r2 = run('perp-clear-halt.ts', ['--db', '--force']);
    expect(r2.code).toBe(2);
    expect(r2.err).toMatch(/--db needs a value/);
    expect(fs.existsSync(path.join(ROOT, '--force'))).toBe(false);
  });
});

describe('perp-report (W12)', () => {
  it('--days without a value, or a flag as the --db value, is a usage error (exit 2)', () => {
    const file = dbAt('r.db');
    const r = run('perp-report.ts', ['--db', file, '--days']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--days needs a value/);
    const r2 = run('perp-report.ts', ['--db', '--days', '7']);
    expect(r2.code).toBe(2);
    expect(r2.err).toMatch(/--db needs a value/);
  });
  it('a missing db file prints a usage-style error, not a stack trace', () => {
    const r = run('perp-report.ts', ['--db', path.join(dir, 'nope.db')]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/does not exist/);
    expect(r.err).toMatch(/usage: perp-report/);
    expect(r.err).not.toMatch(/\n\s+at /);
  });
  it('prints the paper top-ups', () => {
    const file = dbAt('t.db', (db) => {
      setState(db, 'paper', { cash: 2, pos: null });
    });
    expect(run('perp-paper-fund.ts', ['--db', file, '--usd', '1.5']).code).toBe(0);
    const r = run('perp-report.ts', ['--db', file, '--days', '7']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/paper top-ups: 1\.500 USD \(1\); P&L = equity change minus top-ups/);
  });
});

describe('perp-paper-fund (W1)', () => {
  it('adds collateral to the saved paper state', () => {
    const file = dbAt('p.db', (db) => setState(db, 'paper', { cash: 2.9, pos: null }));
    const r = run('perp-paper-fund.ts', ['--db', file, '--usd', '1']);
    expect(r.code).toBe(0);
    const db = openPerpDb(file);
    expect(getState<PaperState>(db, 'paper')?.cash).toBeCloseTo(3.9, 9);
    db.close();
    expect(fs.existsSync(`${file}.lock`)).toBe(false); // released
  });
  it('refuses a missing db (not created), bad arguments, and a db with no paper state', () => {
    const missing = path.join(dir, 'missing.db');
    expect(run('perp-paper-fund.ts', ['--db', missing, '--usd', '1']).code).toBe(2);
    expect(fs.existsSync(missing)).toBe(false);
    const file = dbAt('e.db');
    expect(run('perp-paper-fund.ts', ['--db', file, '--usd']).code).toBe(2);
    expect(run('perp-paper-fund.ts', ['--db', '--usd', '1']).code).toBe(2);
    const r = run('perp-paper-fund.ts', ['--db', file, '--usd', '1']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no paper state yet/);
    const r2 = run('perp-paper-fund.ts', ['--db', dbAt('x.db', (db) => setState(db, 'paper', { cash: 1, pos: null })), '--usd', '5000']);
    expect(r2.code).toBe(1);
    expect(r2.err).toMatch(/usd must be/);
  });
  // On Linux the lock also requires the holder's /proc cmdline to contain main.ts, which this test process does not
  // have, so a held lock can only be simulated where /proc is absent (macOS, Windows).
  it.skipIf(fs.existsSync('/proc/self/cmdline'))('refuses while the bot holds the database lock', () => {
    const file = dbAt('l.db', (db) => setState(db, 'paper', { cash: 2.9, pos: null }));
    const lock = acquireLedgerLock(file);
    try {
      const r = run('perp-paper-fund.ts', ['--db', file, '--usd', '1']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/stop the perp-bot unit first/);
    } finally {
      lock.release();
    }
    const db = openPerpDb(file);
    expect(getState<PaperState>(db, 'paper')?.cash).toBe(2.9);
    db.close();
  });
});
