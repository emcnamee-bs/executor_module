// test/perp/labSampler.test.ts
import { describe, it, expect } from 'vitest';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
import {
  canSpendNow, chooseCandidate, isBoundary, listCandidates, makeRng, pacedAllowanceUsd, randomAuditCounts, stratumOf, STRATA, type Candidate, type Stratum,
} from '../../src/perp/lab/sampler.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const row = (over: Partial<LabItemRow>): LabItemRow => ({
  item_id: 'x', received_ms: NOW - 60_000, published_ms: null, source_id: 'axios_all', tier: 3, headline: 'h', snippet: null, commit_sha: 'c', class: 'press',
  score: 1, hits: '[]', prod_pass: 0, prod_reason: 'low_score', dup_of: null, variants: '{}', mark_at_ms: null, mark: null, ...over,
});
const zero = (): Record<Stratum, number> => ({ social: 0, low_score: 0, duplicate: 0, cooldown: 0, haiku_cap: 0 });

describe('stratumOf / isBoundary', () => {
  it('maps drop reasons to strata and a pass to none', () => {
    expect(stratumOf('source_class_drop')).toBe('social');
    expect(stratumOf('low_score')).toBe('low_score');
    expect(stratumOf('duplicate')).toBe('duplicate');
    expect(stratumOf('cooldown')).toBe('cooldown');
    expect(stratumOf('haiku_cap')).toBe('haiku_cap');
    expect(stratumOf('pass')).toBeNull();
    expect(STRATA).toHaveLength(5);
  });
  it('boundary = non-social low score at threshold-1, or social at/above the threshold', () => {
    expect(isBoundary({ class: 'press', score: 2, prod_pass: 0, prod_reason: 'low_score' }, 3)).toBe(true);
    expect(isBoundary({ class: 'press', score: 1, prod_pass: 0, prod_reason: 'low_score' }, 3)).toBe(false);
    expect(isBoundary({ class: 'social', score: 3, prod_pass: 0, prod_reason: 'source_class_drop' }, 3)).toBe(true);
    expect(isBoundary({ class: 'social', score: 2, prod_pass: 0, prod_reason: 'source_class_drop' }, 3)).toBe(false);
    expect(isBoundary({ class: 'press', score: 2, prod_pass: 1, prod_reason: 'pass' }, 3)).toBe(false);
    expect(isBoundary({ class: 'press', score: 5, prod_pass: 0, prod_reason: 'duplicate' }, 3)).toBe(false);
  });
});

describe('pacing', () => {
  const at = (h: number) => Date.UTC(2026, 9, 14, h, 30, 0);
  it('allows two hourly slices at the start of the UTC day and the full cap from hour 22', () => {
    expect(pacedAllowanceUsd(0.5, at(0))).toBeCloseTo((0.5 / 24) * 2);
    expect(pacedAllowanceUsd(0.5, at(10))).toBeCloseTo((0.5 / 24) * 12);
    expect(pacedAllowanceUsd(0.5, at(22))).toBeCloseTo(0.5);
    expect(pacedAllowanceUsd(0.5, at(23))).toBeCloseTo(0.5);
  });
  it('canSpendNow is strictly below the allowance', () => {
    expect(canSpendNow(0.5, 0, at(0))).toBe(true);
    expect(canSpendNow(0.5, (0.5 / 24) * 2, at(0))).toBe(false);
    expect(canSpendNow(0.5, 0.5, at(23))).toBe(false);
  });
});

describe('makeRng', () => {
  it('is reproducible per seed, in [0,1), and differs between seeds', () => {
    const a = makeRng(7); const b = makeRng(7); const c = makeRng(8);
    const xs = [a(), a(), a()]; const ys = [b(), b(), b()];
    expect(xs).toEqual(ys);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect([c(), c(), c()]).not.toEqual(xs);
  });
});

describe('listCandidates / randomAuditCounts', () => {
  it('lists unaudited dropped items inside the window, never passes or audited ones', () => {
    const db = openLabDb(':memory:');
    insertItem(db, row({ item_id: 'drop1' }));
    insertItem(db, row({ item_id: 'passed', prod_pass: 1, prod_reason: 'pass' }));
    insertItem(db, row({ item_id: 'old', received_ms: NOW - 4 * 3_600_000 }));
    insertItem(db, row({ item_id: 'audited' }));
    insertItem(db, row({ item_id: 'soc', class: 'social', prod_reason: 'source_class_drop', score: 4 }));
    db.prepare("insert into audits (item_id, at_ms, stratum, kind, ok) values ('audited', 1, 'low_score', 'random', 1)").run();
    const c = listCandidates(db, NOW - 3 * 3_600_000, 3);
    expect(c.map((x) => x.itemId).sort()).toEqual(['drop1', 'soc']);
    expect(c.find((x) => x.itemId === 'soc')).toMatchObject({ stratum: 'social', boundary: true });
    expect(c.find((x) => x.itemId === 'drop1')).toMatchObject({ stratum: 'low_score', boundary: false });
  });
  it('counts only random audits per stratum', () => {
    const db = openLabDb(':memory:');
    insertItem(db, row({ item_id: 'a' })); insertItem(db, row({ item_id: 'b' })); insertItem(db, row({ item_id: 'c' }));
    const ins = db.prepare('insert into audits (item_id, at_ms, stratum, kind, ok) values (?, 1, ?, ?, 1)');
    ins.run('a', 'low_score', 'random'); ins.run('b', 'low_score', 'boundary'); ins.run('c', 'social', 'random');
    expect(randomAuditCounts(db)).toEqual({ ...zero(), low_score: 1, social: 1 });
  });
});

describe('chooseCandidate', () => {
  const cands: Candidate[] = [
    { itemId: 'a1', stratum: 'social', boundary: false }, { itemId: 'a2', stratum: 'social', boundary: true },
    { itemId: 'b1', stratum: 'low_score', boundary: false }, { itemId: 'c1', stratum: 'duplicate', boundary: false },
  ];
  it('returns null with no candidates', () => {
    expect(chooseCandidate([], zero(), makeRng(1))).toBeNull();
  });
  it('random picks use equal allocation: the least-audited stratum wins', () => {
    const rng = () => 0.99; // never boundary
    expect(chooseCandidate(cands, { ...zero(), social: 5, low_score: 2, duplicate: 3 }, rng)).toMatchObject({ kind: 'random', candidate: { stratum: 'low_score' } });
    expect(chooseCandidate(cands, { ...zero(), social: 0, low_score: 2, duplicate: 3 }, rng)?.candidate.stratum).toBe('social');
  });
  it('a boundary pick is taken only from boundary candidates, and falls back to random when there are none', () => {
    const lowRng = () => 0.0; // wants boundary
    expect(chooseCandidate(cands, zero(), lowRng)).toMatchObject({ kind: 'boundary', candidate: { itemId: 'a2' } });
    const noBoundary = cands.filter((c) => !c.boundary);
    expect(chooseCandidate(noBoundary, zero(), lowRng)?.kind).toBe('random');
  });
  it('over many seeded draws about 30% are boundary', () => {
    const rng = makeRng(42);
    let b = 0; const n = 2000;
    for (let i = 0; i < n; i++) if (chooseCandidate(cands, zero(), rng)?.kind === 'boundary') b += 1;
    expect(b / n).toBeGreaterThan(0.25);
    expect(b / n).toBeLessThan(0.35);
  });
});
