import { describe, it, expect } from 'vitest';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
import { fillReturns, markAtIngest, movedFlag, sigma4h } from '../../src/perp/lab/marks.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const item = (over: Partial<LabItemRow>): LabItemRow => ({
  item_id: 'a', received_ms: NOW - 5 * H, published_ms: null, source_id: 's', tier: 3, headline: 'h', snippet: null, commit_sha: 'c', class: 'press', score: 1,
  hits: '[]', prod_pass: 0, prod_reason: 'low_score', dup_of: null, variants: '{}', mark_at_ms: NOW - 5 * H, mark: 100, ...over,
});

describe('markAtIngest', () => {
  it('returns the nearest mark within 120 s, else null', () => {
    const bot = openPerpDb(':memory:');
    recordMark(bot, NOW - 30_000, 13.5);
    expect(markAtIngest(bot, NOW)).toEqual({ tsMs: NOW - 30_000, mark: 13.5 });
    expect(markAtIngest(bot, NOW + 10 * 60_000)).toBeNull();
    expect(markAtIngest(openPerpDb(':memory:'), NOW)).toBeNull();
  });
});

describe('fillReturns', () => {
  it('fills ret_1h and ret_4h from later marks once they are due, and leaves recent or unpriced items alone', () => {
    const bot = openPerpDb(':memory:'); const lab = openLabDb(':memory:');
    recordMark(bot, NOW - 5 * H + H, 101); // +1h
    recordMark(bot, NOW - 5 * H + 4 * H, 104); // +4h
    insertItem(lab, item({ item_id: 'due' }));
    insertItem(lab, item({ item_id: 'recent', received_ms: NOW - 30 * 60_000, mark_at_ms: NOW - 30 * 60_000 }));
    insertItem(lab, item({ item_id: 'nomark', mark: null, mark_at_ms: null }));
    expect(fillReturns(lab, bot, NOW)).toBe(1);
    const r = lab.prepare('select item_id, ret_1h, ret_4h from items order by item_id').all() as Array<{ item_id: string; ret_1h: number | null; ret_4h: number | null }>;
    const due = r.find((x) => x.item_id === 'due')!;
    expect(due.ret_1h).toBeCloseTo(0.01, 9);
    expect(due.ret_4h).toBeCloseTo(0.04, 9);
    expect(r.find((x) => x.item_id === 'recent')).toMatchObject({ ret_1h: null, ret_4h: null });
    expect(r.find((x) => x.item_id === 'nomark')).toMatchObject({ ret_1h: null, ret_4h: null });
    expect(fillReturns(lab, bot, NOW)).toBe(0); // idempotent
  });
  it('a missing later mark leaves the return null instead of inventing one', () => {
    const bot = openPerpDb(':memory:'); const lab = openLabDb(':memory:');
    insertItem(lab, item({ item_id: 'gap' }));
    expect(fillReturns(lab, bot, NOW)).toBe(0);
    expect((lab.prepare('select ret_1h from items').get() as { ret_1h: number | null }).ret_1h).toBeNull();
  });
});

describe('sigma4h / movedFlag', () => {
  it('is null with too little history and a positive number with enough', () => {
    const bot = openPerpDb(':memory:');
    expect(sigma4h(bot, NOW)).toBeNull();
    let m = 100;
    for (let h = 0; h < 80; h++) { m *= h % 8 < 4 ? 1.004 : 0.996; recordMark(bot, NOW - (80 - h) * H + 1000, m); }
    const s = sigma4h(bot, NOW);
    expect(s).not.toBeNull();
    expect(s!).toBeGreaterThan(0);
    expect(s!).toBeLessThan(0.02);
  });
  it('flags only when |ret_4h| reaches twice sigma, and never without both inputs', () => {
    expect(movedFlag(0.02, 0.01)).toBe(true);
    expect(movedFlag(-0.02, 0.01)).toBe(true);
    expect(movedFlag(0.0199, 0.01)).toBe(false);
    expect(movedFlag(null, 0.01)).toBe(false);
    expect(movedFlag(0.05, null)).toBe(false);
  });
});
