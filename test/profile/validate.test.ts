import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  matchCorpus,
  selectCandidates,
  pickSample,
  decideRemovals,
  makeCoreMatcher,
  applyRemovals,
  judgeCandidates,
  loadCorpusFromIipDb,
  type CorpusItem,
} from '../../src/profile/validate.js';

const item = (id: string, text: string, source = 'bluesky_geopolitics', ts = '2026-10-01T00:00:00Z'): CorpusItem => ({ id, source, trustTier: 4, text, ts });

describe('matchCorpus', () => {
  const corpus = [
    item('1', 'Gold price jumps as Fed signals cuts'),
    item('2', 'Sanctions on Russia widen again'),
    item('3', 'More sanctions on Russia announced'),
    item('4', 'SANCTIONS ON RUSSIA are in the news'),
    item('5', 'Nothing relevant here'),
    item('6', 'The gold price record', 'aljazeera_all'),
  ];

  it('counts hits per phrase with the executor matcher (case-insensitive, whole words), and shares over matched items', () => {
    const r = matchCorpus(['gold price', 'sanctions on Russia'], corpus, 10);
    const by = Object.fromEntries(r.perPhrase.map((p) => [p.phrase, p]));
    expect(by['sanctions on Russia'].hits).toBe(3);
    expect(by['gold price'].hits).toBe(2);
    expect(r.matchedItems).toBe(5);
    expect(by['sanctions on Russia'].share).toBeCloseTo(3 / 5, 6);
    expect(by['sanctions on Russia'].perDay).toBeCloseTo(0.3, 6);
    expect(r.perPhrase[0].phrase).toBe('sanctions on Russia'); // sorted by hits, descending
    expect(by['gold price'].bySource).toEqual({ bluesky_geopolitics: 1, aljazeera_all: 1 });
  });

  it('does not match inside longer words', () => {
    const r = matchCorpus(['gold price'], [item('1', 'marigold prices fall')], 1);
    expect(r.matchedItems).toBe(0);
  });

  it('skips items from direct sources: they bypass keyphrases, so they say nothing about the phrase list', () => {
    const r = matchCorpus(['gold price'], [item('1', 'gold price up', 'eia_today_in_energy'), item('2', 'gold price down')], 1, ['eia_today_in_energy']);
    expect(r.matchedItems).toBe(1);
    expect(r.perPhrase[0].itemIds).toEqual(['2']);
  });
});

describe('selectCandidates', () => {
  it('takes phrases with at least minHits, most-firing first, capped at maxCandidates', () => {
    const report = { totalItems: 0, days: 1, matchedItems: 100, perPhrase: [
      { phrase: 'a b', hits: 50, share: 0.5, perDay: 50, bySource: {}, itemIds: [] },
      { phrase: 'c d', hits: 20, share: 0.2, perDay: 20, bySource: {}, itemIds: [] },
      { phrase: 'e f', hits: 9, share: 0.09, perDay: 9, bySource: {}, itemIds: [] },
      { phrase: 'g h', hits: 12, share: 0.12, perDay: 12, bySource: {}, itemIds: [] },
    ] };
    expect(selectCandidates(report, { minHits: 10, maxCandidates: 10 }).map((p) => p.phrase)).toEqual(['a b', 'c d', 'g h']);
    expect(selectCandidates(report, { minHits: 10, maxCandidates: 2 }).map((p) => p.phrase)).toEqual(['a b', 'c d']);
  });
});

describe('pickSample', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `id${i}`);
  const stat = { phrase: 'x y', hits: 40, share: 1, perDay: 1, bySource: {}, itemIds: ids };
  const byId = new Map(ids.map((id, i) => [id, item(id, 't', i % 4 === 0 ? 'aljazeera_all' : 'bluesky_geopolitics')]));

  it('is deterministic and returns n distinct items', () => {
    const a = pickSample(stat, byId, 12).map((i) => i.id);
    const b = pickSample(stat, byId, 12).map((i) => i.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(12);
  });

  it('spreads across sources instead of sampling only the dominant one', () => {
    const s = pickSample(stat, byId, 12);
    expect(s.filter((i) => i.source === 'aljazeera_all').length).toBeGreaterThanOrEqual(3);
  });

  it('returns everything when there are fewer hits than n', () => {
    expect(pickSample({ ...stat, itemIds: ids.slice(0, 5) }, byId, 12)).toHaveLength(5);
  });
});

describe('decideRemovals', () => {
  const stat = (phrase: string, hits: number) => ({ phrase, hits, share: 0.1, perDay: 1, bySource: {}, itemIds: [] });
  const opts = { minJudged: 8, maxPassRate: 0.2 };

  it('removes a phrase whose judged hits the gate (almost) never passes', () => {
    const v = decideRemovals([stat('sanctions on Russia', 1274)], new Map([['sanctions on Russia', [false, false, false, false, false, false, false, false, false, true]]]), opts);
    expect(v[0]).toMatchObject({ action: 'remove', judged: 10, passed: 1 });
    expect(v[0].passRate).toBeCloseTo(0.1, 6);
  });

  it('keeps a phrase the gate usually passes', () => {
    const v = decideRemovals([stat('Strait of Hormuz', 571)], new Map([['Strait of Hormuz', Array(10).fill(true)]]), opts);
    expect(v[0].action).toBe('keep');
  });

  it('never removes on thin evidence: fewer than minJudged verdicts is kept as unjudged', () => {
    const v = decideRemovals([stat('rare phrase', 12)], new Map([['rare phrase', [false, false, false]]]), opts);
    expect(v[0]).toMatchObject({ action: 'keep', reason: expect.stringMatching(/only 3 judged/) });
  });

  it('a protected core phrase is kept even when its sampled hits fail, and the reason says to review it by hand', () => {
    const v = decideRemovals([stat('diesel export ban', 18)], new Map([['diesel export ban', Array(12).fill(false)]]), { ...opts, protect: (p) => p === 'diesel export ban' });
    expect(v[0]).toMatchObject({ action: 'keep', judged: 12, passed: 0, reason: expect.stringMatching(/protected phrase.*review by hand/) });
  });

  it('a phrase with no verdicts at all (budget ran out) is kept and marked unjudged', () => {
    const v = decideRemovals([stat('never judged', 30)], new Map(), opts);
    expect(v[0]).toMatchObject({ action: 'keep', judged: 0 });
  });
});

describe('makeCoreMatcher', () => {
  const core = makeCoreMatcher(['Will the US ban diesel exports before Election Day?', 'Resolves YES if the Strait of Hormuz weekly transit calls exceed 75.']);

  it('treats a phrase made only of the trade\'s own title/settlement words as core, tolerating plurals and word forms', () => {
    expect(core('diesel export ban')).toBe(true);        // "exports" in the title
    expect(core('Strait of Hormuz')).toBe(true);
    expect(core('transit call')).toBe(true);
  });

  it('a phrase with any word outside the trade\'s own text is not core', () => {
    expect(core('Tren de Aragua')).toBe(false);
    expect(core('sanctions on Russia')).toBe(false);
    expect(core('Hormuz shipping sanctions')).toBe(false);
  });

  it('a phrase with no content words is never core (so it cannot be protected by accident)', () => {
    expect(core('of the')).toBe(false);
  });
});

describe('applyRemovals', () => {
  const verdict = (phrase: string, passRate: number, hits = 10) => ({ phrase, hits, judged: 10, passed: Math.round(passRate * 10), passRate, action: 'remove' as const, reason: '' });
  const phrases = ['a a', 'b b', 'c c', 'd d', 'e e'];

  it('drops removed phrases and keeps the rest in their original order', () => {
    const r = applyRemovals(phrases, [verdict('b b', 0), verdict('d d', 0.1)], 1);
    expect(r.kept).toEqual(['a a', 'c c', 'e e']);
    expect(r.removed).toEqual(['b b', 'd d']);
    expect(r.blocked).toEqual([]);
  });

  it('never goes below the floor: the worst phrases go first, the rest are blocked', () => {
    const r = applyRemovals(phrases, [verdict('a a', 0.1), verdict('b b', 0), verdict('c c', 0.2)], 4);
    expect(r.kept).toHaveLength(4);
    expect(r.removed).toEqual(['b b']);
    expect(r.blocked.sort()).toEqual(['a a', 'c c']);
  });

  it('ignores verdicts for phrases that are not in the list', () => {
    expect(applyRemovals(phrases, [verdict('zz zz', 0)], 1).removed).toEqual([]);
  });
});

describe('judgeCandidates', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `i${i}`);
  const byId = new Map(ids.map((id) => [id, item(id, `text ${id}`)]));
  const stat = (phrase: string, itemIds: string[]) => ({ phrase, hits: itemIds.length, share: 0.5, perDay: 1, bySource: {}, itemIds });

  it('judges each item once even when several phrases sampled it, and reports verdicts per phrase', async () => {
    const calls: string[] = [];
    const judge = async (it: CorpusItem) => { calls.push(it.id); return it.id !== 'i0'; };
    const r = await judgeCandidates([stat('p p', ids), stat('q q', ids.slice(0, 3))], byId, judge, { sampleSize: 6, concurrency: 2, maxCalls: 100 });
    expect(calls.sort()).toEqual([...ids].sort());                // 6 calls, not 9
    expect(r.verdicts.get('p p')).toHaveLength(6);
    expect(r.verdicts.get('q q')).toHaveLength(3);
    expect(r.callsMade).toBe(6);
  });

  it('stops at the call budget and leaves later phrases unjudged', async () => {
    const judge = async () => true;
    const r = await judgeCandidates([stat('p p', ids.slice(0, 3)), stat('q q', ids.slice(3))], byId, judge, { sampleSize: 3, concurrency: 1, maxCalls: 3 });
    expect(r.callsMade).toBe(3);
    expect(r.verdicts.get('p p')).toHaveLength(3);
    expect(r.verdicts.get('q q')).toBeUndefined();
    expect(r.budgetExhausted).toBe(true);
  });

  it('a judge error is skipped, not counted as a pass or a fail', async () => {
    const judge = async (it: CorpusItem) => { if (it.id === 'i1') throw new Error('boom'); return true; };
    const r = await judgeCandidates([stat('p p', ids.slice(0, 3))], byId, judge, { sampleSize: 3, concurrency: 1, maxCalls: 10 });
    expect(r.verdicts.get('p p')).toEqual([true, true]);
    expect(r.errors).toBe(1);
  });
});

describe('loadCorpusFromIipDb', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function makeDb(rows: Array<{ id: string; src: string; q: number; ts: string; headline?: string | null; snippet?: string | null; gaps?: string[]; tier?: number }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iipdb-')); dirs.push(dir);
    const p = path.join(dir, 'iip.db');
    const db = new Database(p);
    db.exec('CREATE TABLE items (item_id TEXT, dedup_id TEXT, source_id TEXT, first_seen_ts TEXT, quarantined INTEGER, payload TEXT, observed_live INTEGER, story_key TEXT)');
    const ins = db.prepare('INSERT INTO items VALUES (?,?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(r.id, r.id, r.src, r.ts, r.q, JSON.stringify({ item_id: r.id, source_id: r.src, trust_tier: r.tier ?? 4, headline: r.headline ?? null, snippet: r.snippet ?? null, provenance_gaps: r.gaps ?? [], first_seen_ts: r.ts }), 1, 'sk');
    db.close();
    return p;
  }

  it('reads items read-only, drops quarantined ones (withheld from the stream), and builds the matchable text like the executor', () => {
    const p = makeDb([
      { id: 'a', src: 's1', q: 0, ts: '2026-10-01T00:00:00+00:00', headline: 'Head', snippet: 'Snip' },
      { id: 'b', src: 's1', q: 1, ts: '2026-10-01T00:00:00+00:00', headline: 'Quarantined' },
      { id: 'c', src: 's2', q: 0, ts: '2026-10-03T00:00:00+00:00', headline: 'Synthetic headline', snippet: 'Only snippet', gaps: ['synthetic_headline'] },
      { id: 'd', src: 's2', q: 0, ts: '2026-10-03T12:00:00+00:00', headline: null, snippet: null },
    ]);
    const c = loadCorpusFromIipDb(p);
    expect(c.items.map((i) => i.id)).toEqual(['a', 'c']);        // quarantined and empty-text items are dropped
    expect(c.items[0].text).toBe('Head Snip');
    expect(c.items[1].text).toBe('Only snippet');                  // synthetic headline is ignored, as getMatchableText does
    expect(c.days).toBe(2);
  });

  it('sinceDays keeps only the most recent window', () => {
    const p = makeDb([
      { id: 'old', src: 's', q: 0, ts: '2026-09-01T00:00:00+00:00', headline: 'old' },
      { id: 'new', src: 's', q: 0, ts: '2026-10-10T00:00:00+00:00', headline: 'new' },
      { id: 'newer', src: 's', q: 0, ts: '2026-10-11T00:00:00+00:00', headline: 'newer' },
    ]);
    expect(loadCorpusFromIipDb(p, { sinceDays: 3 }).items.map((i) => i.id)).toEqual(['new', 'newer']);
  });
});
