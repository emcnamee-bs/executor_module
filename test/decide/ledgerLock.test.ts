import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireLedgerLock, lockPathFor, readProcCmdline } from '../../src/decide/ledgerLock.js';

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

  const age = (p: string, seconds: number) => {
    const t = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(p, t, t);
  };

  it.each([['garbled', 'not json'], ['empty', '']])(
    'refuses a FRESH %s lock file (it may be a racer mid-write) and leaves it alone', (_l, body) => {
      fs.writeFileSync(`${ledger}.lock`, body);
      expect(() => acquireLedgerLock(ledger)).toThrow(/lock file .* unreadable or garbled/);
      expect(fs.readFileSync(`${ledger}.lock`, 'utf-8')).toBe(body);
    });

  it.each([['garbled', 'not json'], ['empty', '']])(
    'treats a %s lock file older than 10 s as stale and takes it over', (_l, body) => {
      fs.writeFileSync(`${ledger}.lock`, body);
      age(`${ledger}.lock`, 11);
      const lock = acquireLedgerLock(ledger);
      expect(JSON.parse(fs.readFileSync(lock.path, 'utf-8')).pid).toBe(process.pid);
      lock.release();
    });

  it('a garbled lock just under 10 s old is still refused', () => {
    fs.writeFileSync(`${ledger}.lock`, '{');
    age(`${ledger}.lock`, 8);
    expect(() => acquireLedgerLock(ledger)).toThrow(/unreadable or garbled/);
  });

  describe('a live pid is only a holder if it is an executor (pid reuse)', () => {
    let other: ReturnType<typeof spawn>;
    beforeEach(async () => {
      other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      await new Promise((r) => setTimeout(r, 100));
    });
    afterEach(async () => {
      other.kill('SIGKILL');
      await new Promise((r) => other.once('exit', r));
    });
    const writeLock = (pid: number) =>
      fs.writeFileSync(`${ledger}.lock`, JSON.stringify({ pid, bootId: 'b', startedAt: 'x' }));

    it('a live pid whose /proc cmdline lacks main.ts is stale (reused pid) and is taken over', () => {
      writeLock(other.pid!);
      const lock = acquireLedgerLock(ledger, { bootId: () => 'b', readCmdline: () => 'node -e setInterval' });
      expect(JSON.parse(fs.readFileSync(lock.path, 'utf-8')).pid).toBe(process.pid);
      lock.release();
    });

    it('a live pid whose cmdline contains main.ts is a real holder: refused', () => {
      writeLock(other.pid!);
      expect(() =>
        acquireLedgerLock(ledger, { bootId: () => 'b', readCmdline: () => 'node /home/x/executor_module/src/main.ts' })
      ).toThrow(/already running/);
    });

    it('where /proc is unavailable (null) the cmdline check is skipped: a live pid holds', () => {
      writeLock(other.pid!);
      expect(() => acquireLedgerLock(ledger, { bootId: () => 'b', readCmdline: () => null })).toThrow(/already running/);
    });

    it('this very process is always a holder (a second start in-process), whatever its cmdline', () => {
      writeLock(process.pid);
      expect(() => acquireLedgerLock(ledger, { bootId: () => 'b', readCmdline: () => 'vitest' })).toThrow(/already running/);
    });

    it('the default cmdline reader returns null without /proc and a string with it', () => {
      const v = readProcCmdline(process.pid);
      if (fs.existsSync('/proc/self')) expect(typeof v).toBe('string');
      else expect(v).toBeNull();
    });
  });

  it('a lock held by a different live PROCESS refuses this one, and is taken over once that process dies', async () => {
    // Run the holder IN a plain node process (tsx as a loader, not the tsx CLI wrapper,
    // which would fork a grandchild): the pid in the lock is then exactly child.pid.
    const loader = pathToFileURL(path.resolve(__dirname, '../../node_modules/tsx/dist/loader.mjs')).href;
    const mod = path.resolve(__dirname, '../../src/decide/ledgerLock.ts');
    // Named main.ts so the /proc cmdline check (Linux) recognises it as an executor.
    fs.mkdirSync(path.join(dir, 'holder'));
    const script = path.join(dir, 'holder', 'main.ts');
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
