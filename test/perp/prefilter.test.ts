// test/perp/prefilter.test.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countLastHour, createPrefilterState, jaccard, loadPrefilterConfig, prefilter, recordPass, resolvePrefilterSetting,
  scoreText, tokenize, type PrefilterConfig, type PrefilterItem,
} from '../../src/perp/intake/prefilter.js';

const CFG_FILE = path.resolve(__dirname, '../../config/perp-prefilter.json');
const cfg = (over: Partial<PrefilterConfig> = {}): PrefilterConfig => ({ ...loadPrefilterConfig(CFG_FILE), ...over });
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;
let n = 0;
const mk = (source_id: string, headline: string, snippet: string | null = null): PrefilterItem => ({ item_id: `i${++n}`, source_id, headline, snippet });
const run = (c: PrefilterConfig, s: ReturnType<typeof createPrefilterState>, item: PrefilterItem, now = NOW) => {
  const v = prefilter(item, c, s, now);
  if (v.pass) recordPass(s, item, v, now, c);
  return v;
};

describe('config', () => {
  it('loads the shipped config', () => {
    const c = cfg();
    expect(c.threshold).toBe(3);
    expect(c.sources.bluesky_geopolitics).toBe('social');
    expect(c.compiled.length).toBeGreaterThan(40);
  });
  const tmp = (mutate: (j: any) => void): string => {
    const j = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    mutate(j);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-')), 'c.json');
    fs.writeFileSync(f, JSON.stringify(j));
    return f;
  };
  it('names the pattern when a regex is invalid', () => {
    expect(() => loadPrefilterConfig(tmp((j) => { j.patterns.strong[0].regex = '(unclosed'; }))).toThrow(/federal_reserve/);
  });
  it('rejects an unknown source class, a missing file and an unknown key', () => {
    expect(() => loadPrefilterConfig(tmp((j) => { j.sources.x = 'blog'; }))).toThrow();
    expect(() => loadPrefilterConfig('/nonexistent/perp-prefilter.json')).toThrow();
    expect(() => loadPrefilterConfig(tmp((j) => { j.extra = 1; }))).toThrow();
  });
});

describe('resolvePrefilterSetting', () => {
  it('is on by default, off only for "off", and refuses anything else', () => {
    expect(resolvePrefilterSetting({} as NodeJS.ProcessEnv)).toBe(true);
    expect(resolvePrefilterSetting({ PERP_PREFILTER: '' } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolvePrefilterSetting({ PERP_PREFILTER: 'on' } as NodeJS.ProcessEnv)).toBe(true);
    expect(resolvePrefilterSetting({ PERP_PREFILTER: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(() => resolvePrefilterSetting({ PERP_PREFILTER: 'yes' } as NodeJS.ProcessEnv)).toThrow(/"on" or "off"/);
  });
});

describe('scoreText', () => {
  it('weights headline hits double and counts each pattern once', () => {
    const c = cfg();
    expect(scoreText('Inflation heats up as gas prices surge', null, c).score).toBe(6); // strong 3 x headline 2
    expect(scoreText('Nothing here', 'inflation inflation inflation', c).score).toBe(3); // strong 3 x snippet 1, once
    expect(scoreText('Crude falls', null, c).score).toBe(2); // medium 1 x 2
  });
  it('subtracts negative patterns and never goes below zero', () => {
    const c = cfg();
    expect(scoreText('Opinion: celebrity chef recipe', null, c).score).toBe(0);
    expect(scoreText('Inflation opinion', null, c).score).toBe(2); // 6 - 4
  });
  it('caps the total however long the snippet is', () => {
    const c = cfg();
    const s = 'inflation fomc cpi gdp recession tariffs payrolls unemployment bank failure credit crisis wall street nasdaq';
    expect(scoreText('', s, c).score).toBe(10);
  });
  it('never throws on hostile or empty input', () => {
    const c = cfg();
    expect(scoreText('', null, c).score).toBe(0);
    expect(scoreText('(((((((((( [[[[ \\\\ ' + 'a'.repeat(100_000), 'x'.repeat(100_000), c).score).toBe(0);
  });
});

describe('prefilter: source classes and threshold', () => {
  it('drops the social class without scoring', () => {
    const v = prefilter(mk('bluesky_geopolitics', 'Inflation and the Fed: rates must fall'), cfg(), createPrefilterState(), NOW);
    expect(v).toMatchObject({ pass: false, reason: 'source_class_drop', sourceClass: 'social', score: 0 });
  });
  it.each([
    ['axios_all', 'Inflation heats up as gas prices surge'],
    ['cbs_politics', 'Trump insists inflation is low as CPI report shows a 3.7% increase'],
    ['axios_all', "The Fed's going to take its time with rate hikes"],
    ['oilprice_main', 'Oil Market Tightens as Tanker Attacks and Inventory Draws Mount'],
    ['someone_new', 'Tariffs on chips raise recession fears'],
  ])('passes real macro news: %s | %s', (src, headline) => {
    expect(prefilter(mk(src, headline), cfg(), createPrefilterState(), NOW)).toMatchObject({ pass: true, reason: 'pass' });
  });
  it.each([
    ['ukrinform_news', 'Zelensky briefs Burnham on Russian attacks against Ukraine'],
    ['guardian_world', "OpenAI's London staff receive average of 2.3m per person annually"],
    ['thehill_news', 'Senate debates the farm bill'],
  ])('drops low-score items: %s | %s', (src, headline) => {
    expect(prefilter(mk(src, headline), cfg(), createPrefilterState(), NOW)).toMatchObject({ pass: false, reason: 'low_score' });
  });
  it('market_wire passes at score 1, press needs the threshold', () => {
    const c = cfg();
    expect(prefilter(mk('oilprice_main', 'Crude inventories fall'), c, createPrefilterState(), NOW).pass).toBe(true);
    expect(prefilter(mk('axios_all', 'Crude inventories fall'), c, createPrefilterState(), NOW)).toMatchObject({ pass: false, reason: 'low_score' });
  });
  it('official_macro always passes, even with a score of 0', () => {
    expect(prefilter(mk('federal_reserve_monetary', 'Press release'), cfg(), createPrefilterState(), NOW)).toMatchObject({ pass: true, sourceClass: 'official_macro', score: 0 });
  });
  it('an unlisted source is treated as press', () => {
    const v = prefilter(mk('brand_new_feed', 'Quarterly earnings guidance'), cfg(), createPrefilterState(), NOW);
    expect(v.sourceClass).toBe('unknown');
    expect(v.pass).toBe(true); // earnings 2 + guidance 2 = 4 >= 3
  });
});

describe('prefilter: dedup and cooldown', () => {
  it('drops a near-duplicate headline and names the original', () => {
    const c = cfg(); const s = createPrefilterState();
    const first = mk('axios_all', 'Inflation heats up as gas prices surge');
    expect(run(c, s, first).pass).toBe(true);
    const v = run(c, s, mk('thehill_news', 'Inflation heats up as gas prices surge again'));
    expect(v).toMatchObject({ pass: false, reason: 'duplicate', dupOf: first.item_id });
  });
  it('a duplicate older than the window passes again', () => {
    const c = cfg(); const s = createPrefilterState();
    run(c, s, mk('axios_all', 'Inflation heats up as gas prices surge'));
    expect(run(c, s, mk('axios_all', 'Inflation heats up as gas prices surge'), NOW + 7 * H).pass).toBe(true);
  });
  it('cooldown: the same strong topic is suppressed, a new strong pattern is not, and it expires', () => {
    const c = cfg(); const s = createPrefilterState();
    expect(run(c, s, mk('axios_all', 'CPI report shows a 3.7% increase')).pass).toBe(true);
    expect(run(c, s, mk('cbs_politics', 'Core CPI climbs for another month in the data')).reason).toBe('cooldown');
    expect(run(c, s, mk('nyt_politics', 'CPI surprise raises Fed rate hike fears for traders')).pass).toBe(true);
    expect(run(c, s, mk('nbc_politics', 'Another CPI reading puzzles economists today'), NOW + 3 * H).pass).toBe(true);
  });
  it.each([
    // the 2026-10-22 miss: a Hormuz item sharing only the generic strong topic `inflation` with an unrelated earlier pass
    ['Economy set to worsen, with higher unemployment and inflation on the way', 'Iran: 7 ships hit in the Strait of Hormuz as oil jumps and inflation fears grow'],
    // not Hormuz-specific: any item that brings a topic the earlier pass lacked gets through
    ['CPI report shows a 3.7% increase', 'OPEC trims crude output days after the CPI report'],
  ])('cooldown does not suppress an item that adds a topic the earlier pass lacked: %s -> %s', (first, second) => {
    const c = cfg(); const s = createPrefilterState();
    expect(run(c, s, mk('guardian_world', first)).pass).toBe(true);
    const v = run(c, s, mk('thehill_news', second));
    expect(v).toMatchObject({ pass: true, reason: 'pass' });
  });
  it('cooldown still suppresses an item whose topics are all covered by the earlier pass', () => {
    const c = cfg(); const s = createPrefilterState();
    expect(run(c, s, mk('guardian_world', 'Inflation and unemployment worsen as oil prices jump')).pass).toBe(true);
    expect(run(c, s, mk('thehill_news', 'Unemployment and inflation data point to a weaker economy')).reason).toBe('cooldown');
  });
  it('very short headlines are never deduplicated', () => {
    const c = cfg(); const s = createPrefilterState();
    run(c, s, mk('axios_all', 'Fed cuts'));
    expect(run(c, s, mk('cbs_politics', 'Fed cuts')).reason).not.toBe('duplicate');
  });
});

describe('prefilter: hourly cap', () => {
  it('raises the floor once the hour is used up, but never blocks official_macro or a top score', () => {
    const c = cfg({ haikuPerHour: 1 }); const s = createPrefilterState();
    expect(run(c, s, mk('axios_all', 'Inflation heats up as gas prices surge')).pass).toBe(true); // score 6, used 0 -> 1
    // used == 1 >= cap: floor = 3 + 1 = 4; a score-3 item (strong only in the snippet) is capped
    expect(run(c, s, mk('axios_all', 'Quarterly numbers out', 'wage growth and unemployment')).reason).toBe('haiku_cap');
    expect(run(c, s, mk('cbs_politics', 'Recession fears grip Wall Street as Nasdaq slides')).pass).toBe(true); // score 10 >= floor 4
    expect(run(c, s, mk('federal_reserve_press', 'Statement')).pass).toBe(true);
  });
  it('the cap window slides: an hour later the floor is back to the threshold', () => {
    const c = cfg({ haikuPerHour: 1 }); const s = createPrefilterState();
    run(c, s, mk('axios_all', 'Inflation heats up as gas prices surge'));
    expect(run(c, s, mk('axios_all', 'Quarterly numbers out', 'wage growth and unemployment'), NOW + 61 * 60_000).pass).toBe(true);
  });
});

describe('state', () => {
  it('prune: a long run keeps only what the windows need', () => {
    const c = cfg(); const s = createPrefilterState();
    for (let i = 0; i < 300; i++) {
      const at = NOW + i * 10 * 60_000; // 50 hours
      run(c, s, mk('axios_all', `Earnings guidance update ${i} alpha${i} beta${i}`), at); // medium-only: no strong hit, so no cooldown; every item passes
      s.sonnetAtMs.push(at);
    }
    const last = NOW + 299 * 10 * 60_000;
    expect(s.passed.length).toBeGreaterThan(0); // the test is only meaningful if items actually passed
    expect(s.passed.every((p) => last - p.atMs <= Math.max(c.dedupWindowMs, c.cooldownMs))).toBe(true);
    expect(s.passAtMs.every((t) => last - t < H)).toBe(true);
    expect(s.sonnetAtMs.every((t) => last - t < H)).toBe(true);
  });
  it('recordPass ignores official_macro and drops', () => {
    const c = cfg(); const s = createPrefilterState();
    const off = mk('federal_reserve_press', 'Statement');
    recordPass(s, off, prefilter(off, c, s, NOW), NOW, c);
    const social = mk('bluesky_geopolitics', 'Inflation');
    recordPass(s, social, prefilter(social, c, s, NOW), NOW, c);
    expect(s.passed).toHaveLength(0);
    expect(s.passAtMs).toHaveLength(0);
  });
  it('prefilter itself never mutates the state', () => {
    const c = cfg(); const s = createPrefilterState();
    prefilter(mk('axios_all', 'Inflation heats up as gas prices surge'), c, s, NOW);
    expect(s).toEqual(createPrefilterState());
  });
});

describe('helpers', () => {
  it('tokenize drops stopwords and short tokens; jaccard is symmetric', () => {
    expect([...tokenize('The Fed and the new rate hike!')].sort()).toEqual(['fed', 'hike', 'rate']);
    const a = new Set(['a1x', 'b2y', 'c3z']); const b = new Set(['b2y', 'c3z', 'd4w']);
    expect(jaccard(a, b)).toBeCloseTo(0.5);
    expect(jaccard(b, a)).toBeCloseTo(0.5);
    expect(jaccard(new Set(), a)).toBe(0);
  });
  it('countLastHour counts strictly inside the trailing hour', () => {
    expect(countLastHour([NOW - H, NOW - H + 1, NOW], NOW)).toBe(2);
  });
});
