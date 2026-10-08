import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * One executor process per ledger (final review I2). Two processes on the same ledger
 * and consumer group split the stream between them, and the dedup on decision rows
 * then hides every item the wrong process handled from the right one forever.
 *
 * The lock is `<ledger>.lock`, created atomically with O_EXCL and holding
 * `{pid, bootId, startedAt}`. A lock whose holder is dead, or that was written during a
 * previous boot (its pid may since have been reused), is stale and is taken over. A
 * garbled lock file fails closed: a human deletes it. (An SQLite `BEGIN EXCLUSIVE`
 * lock file was tried first and did not exclude a second process in the dev
 * environment, so the pidfile is the mechanism.)
 */
export interface LedgerLock {
  path: string;
  release(): void;
}

interface LockBody {
  pid: number;
  bootId: string;
  startedAt: string;
}

export function lockPathFor(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

/** Linux boot id when readable; otherwise the boot time rounded to the minute. */
export function currentBootId(): string {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
  } catch {
    return `boot@${Math.round((Date.now() - os.uptime() * 1000) / 60_000)}`;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseBody(raw: string): LockBody | null {
  try {
    const b = JSON.parse(raw) as Partial<LockBody>;
    if (typeof b.pid === 'number' && Number.isInteger(b.pid) && b.pid > 0 && typeof b.bootId === 'string') {
      return { pid: b.pid, bootId: b.bootId, startedAt: String(b.startedAt ?? '') };
    }
  } catch {
    // fall through
  }
  return null;
}

function tryCreate(lockPath: string, body: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export function acquireLedgerLock(
  ledgerPath: string,
  deps: { bootId?: () => string } = {}
): LedgerLock {
  const lockPath = lockPathFor(ledgerPath);
  const bootId = (deps.bootId ?? currentBootId)();
  const mine = JSON.stringify({ pid: process.pid, bootId, startedAt: new Date().toISOString() });
  const lock: LedgerLock = {
    path: lockPath,
    release() {
      try {
        if (fs.readFileSync(lockPath, 'utf-8') === mine) fs.unlinkSync(lockPath);
      } catch {
        // already gone, or unreadable: never remove a lock that is not provably ours
      }
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(lockPath, mine)) return lock;

    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // released in between
      throw err;
    }
    const held = parseBody(raw);
    if (held === null) {
      throw new Error(
        `refusing to start: lock file ${lockPath} for ledger ${ledgerPath} is unreadable or garbled; ` +
          `if no executor is running on this ledger, delete it by hand`
      );
    }
    if (held.bootId === bootId && isAlive(held.pid)) {
      throw new Error(
        `refusing to start: another executor instance is already running on ledger ${ledgerPath} ` +
          `(pid ${held.pid}, since ${held.startedAt}; lock ${lockPath}). Two consumers on one ledger ` +
          `split the stream and hide items from each other.`
      );
    }

    // Stale. Move it aside under a unique name, then confirm what was moved is the stale
    // lock just read; if a racer replaced it in between, put theirs back and refuse.
    const aside = `${lockPath}.stale-${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(lockPath, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const moved = fs.readFileSync(aside, 'utf-8');
    if (moved !== raw) {
      try {
        fs.linkSync(aside, lockPath);
        fs.unlinkSync(aside);
      } catch {
        // leave `aside` for a human; the refusal below still stands
      }
      throw new Error(`refusing to start: lock ${lockPath} changed during stale-lock takeover (another instance is starting)`);
    }
    fs.unlinkSync(aside);
    console.warn(`[lock] removed stale lock ${lockPath} (pid ${held.pid}, boot ${held.bootId})`);
  }
  throw new Error(`refusing to start: could not take lock ${lockPath} for ledger ${ledgerPath} (contended)`);
}
