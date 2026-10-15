// test/perp/labDb.test.ts
import { describe, it, expect } from 'vitest';
import { firstItemMs, getMeta, hasItem, insertItem, openLabDb, setMeta, type LabItemRow } from '../../src/perp/lab/labDb.js';

const row = (over: Partial<LabItemRow> = {}): LabItemRow => ({
  item_id: 'a', received_ms: 1_000, published_ms: 900, source_id: 'axios_all', tier: 3, headline: 'Inflation heats up', snippet: null,
  commit_sha: 'abc1234', class: 'press', score: 6, hits: '["inflation"]', prod_pass: 1, prod_reason: 'pass', dup_of: null,
  variants: '{"strict3":true,"loose1":true,"social_ok":true}', mark_at_ms: 990, mark: 13.5, ...over,
});

describe('lab db', () => {
  it('creates every table, including the shared model_calls spend table', () => {
    const db = openLabDb(':memory:');
    const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['items', 'audits', 'heartbeat', 'meta', 'model_calls']));
  });
  it('inserts an item once; a redelivery is a no-op', () => {
    const db = openLabDb(':memory:');
    expect(insertItem(db, row())).toBe(true);
    expect(insertItem(db, row({ headline: 'changed' }))).toBe(false);
    expect(hasItem(db, 'a')).toBe(true);
    expect(hasItem(db, 'zzz')).toBe(false);
    expect((db.prepare('select headline from items').get() as { headline: string }).headline).toBe('Inflation heats up');
  });
  it('firstItemMs is the earliest received time, or null when empty', () => {
    const db = openLabDb(':memory:');
    expect(firstItemMs(db)).toBeNull();
    insertItem(db, row({ item_id: 'b', received_ms: 5_000 }));
    insertItem(db, row({ item_id: 'c', received_ms: 2_000 }));
    expect(firstItemMs(db)).toBe(2_000);
  });
  it('meta get/set round-trips and overwrites', () => {
    const db = openLabDb(':memory:');
    expect(getMeta(db, 'k')).toBeNull();
    setMeta(db, 'k', 'v1');
    setMeta(db, 'k', 'v2');
    expect(getMeta(db, 'k')).toBe('v2');
  });
  it('rejects an audit kind other than random or boundary, and an unknown prod_pass', () => {
    const db = openLabDb(':memory:');
    insertItem(db, row());
    const ins = db.prepare("insert into audits (item_id, at_ms, stratum, kind, ok) values ('a', 1, 'social', ?, 1)");
    expect(() => ins.run('weird')).toThrow();
    expect(() => insertItem(db, row({ item_id: 'x', prod_pass: 2 as never }))).toThrow();
  });
});
