import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireLedgerLock, lockPathFor } from '../../src/decide/ledgerLock.js';

function deadPid(): number {
  // A child that has already exited: its pid is (for the moment) not a live process.
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid!;
}

describe('acquireLedgerLock (one executor process per ledger)', () => {
  let dir: string;
  let ledger: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
    ledger = path.join(dir, 'decisions.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates <ledger>.lock holding this pid and removes it on release', () => {
    const lock = acquireLedgerLock(ledger);
    expect(lock.path).toBe(`${ledger}.lock`);
    expect(lockPathFor(ledger)).toBe(`${ledger}.lock`);
    expect(JSON.parse(fs.readFileSync(lock.path, 'utf-8')).pid).toBe(process.pid);
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(false);
  });

  it('a second acquire while the first holder is alive is refused with a clear message', () => {
    const lock = acquireLedgerLock(ledger);
    expect(() => acquireLedgerLock(ledger)).toThrow(/another executor instance .* already running on ledger .*decisions\.db.*pid \d+/);
    // The refusal must not have disturbed the holder's lock.
    expect(JSON.parse(fs.readFileSync(lock.path, 'utf-8')).pid).toBe(process.pid);
    lock.release();
  });

  it('after release the ledger can be locked again', () => {
    acquireLedgerLock(ledger).release();
    const again = acquireLedgerLock(ledger);
    again.release();
  });

  it('takes over a stale lock left by a dead process (same boot)', () => {
    const bootId = 'boot-a';
    fs.writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: deadPid(), bootId, startedAt: 'x' }));
    const lock = acquireLedgerLock(ledger, { bootId: () => bootId });
    expect(JSON.parse(fs.readFileSync(lock.path, 'utf-8')).pid).toBe(process.pid);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.stale-'))).toEqual([]);
    lock.release();
  });

  it('takes over a lock from a previous boot even if its pid is now reused by a live process', () => {
    fs.writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: process.pid, bootId: 'old-boot', startedAt: 'x' }));
    const lock = acquireLedgerLock(ledger, { bootId: () => 'new-boot' });
    expect(JSON.parse(fs.readFileSync(lock.path, 'utf-8')).bootId).toBe('new-boot');
    lock.release();
  });

  it('refuses (fails closed) on an unreadable/garbled lock file rather than guessing it is stale', () => {
    fs.writeFileSync(`${ledger}.lock`, 'not json');
    expect(() => acquireLedgerLock(ledger)).toThrow(/lock file .* unreadable/);
    expect(fs.readFileSync(`${ledger}.lock`, 'utf-8')).toBe('not json');
  });

  it('a lock held by a different live PROCESS refuses this one, and is taken over once that process dies', async () => {
    // Run the holder IN a plain node process (tsx as a loader, not the tsx CLI wrapper,
    // which would fork a grandchild): the pid in the lock is then exactly child.pid.
    const loader = pathToFileURL(path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs')).href;
    const mod = path.resolve(__dirname, '../../src/decide/ledgerLock.ts');
    const script = path.join(dir, 'holder.ts');
    fs.writeFileSync(script, `import { acquireLedgerLock } from ${JSON.stringify(mod)};\nacquireLedgerLock(${JSON.stringify(ledger)});\nconsole.log('LOCKED');\nsetInterval(() => {}, 1000);\n`);
    const child = spawn(process.execPath, ['--no-warnings', '--loader', loader, script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (d) => { if (String(d).includes('LOCKED')) resolve(); });
      child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
    });
    try {
      expect(() => acquireLedgerLock(ledger)).toThrow(new RegExp(`already running on ledger .*pid ${child.pid}`));
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    // SIGKILL ran no cleanup: the lock file is stale now and must be taken over.
    expect(fs.existsSync(`${ledger}.lock`)).toBe(true);
    const lock = acquireLedgerLock(ledger);
    expect(JSON.parse(fs.readFileSync(lock.path, 'utf-8')).pid).toBe(process.pid);
    lock.release();
  }, 20_000);

  it('release never removes a lock that is no longer ours', () => {
    const lock = acquireLedgerLock(ledger);
    fs.writeFileSync(lock.path, JSON.stringify({ pid: 999999, bootId: 'someone-else', startedAt: 'y' }));
    lock.release();
    expect(fs.existsSync(lock.path)).toBe(true);
  });
});
