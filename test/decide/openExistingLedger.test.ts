import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger, openExistingLedger } from '../../src/decide/ledger.js';

describe('openExistingLedger', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oel-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('throws naming the path for a missing file, and does not create it', () => {
    const p = path.join(tmp(), 'nope.db');
    expect(() => openExistingLedger(p)).toThrow(p);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('opens an existing ledger', () => {
    const p = path.join(tmp(), 'ok.db');
    openLedger(p).close();
    const db = openExistingLedger(p);
    expect(db.prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({ n: 0 });
    db.close();
  });
});
