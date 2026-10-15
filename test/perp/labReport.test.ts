// test/perp/labReport.test.ts
import { describe, it, expect } from 'vitest';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';
import { ensureModelCallsTable } from '../../src/perp/model/callJson.js';
import { insertItem, openLabDb, recordProcessStart, type LabItemRow } from '../../src/perp/lab/labDb.js';
import { buildReport } from '../../src/perp/lab/report.js';

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 15, 0, 0);
const row = (over: Partial<LabItemRow>): LabItemRow => ({
  item_id: 'x', received_ms: NOW - 2 * H, published_ms: null, source_id: 'axios_all', tier: 3, headline: 'A headline', snippet: null, commit_sha: 'abc1234', class: 'press',
  score: 1, hits: '[]', prod_pass: 0, prod_reason: 'low_score', dup_of: null, variants: '{"strict3":false,"loose1":false,"social_ok":false}', mark_at_ms: null, mark: null, ...over,
});

function fixture() {
  const lab = openLabDb(':memory:');
  const bot = openPerpDb(':memory:');
  ensureModelCallsTable(bot);
  insertItem(lab, row({ item_id: 'p1', prod_pass: 1, prod_reason: 'pass', score: 6, variants: '{"strict3":true,"loose1":true,"social_ok":true}' }));
  insertItem(lab, row({ item_id: 'p2', prod_pass: 1, prod_reason: 'pass', score: 4, variants: '{"strict3":true,"loose1":true,"social_ok":true}' }));
  for (let i = 0; i < 6; i++) insertItem(lab, row({ item_id: `s${i}`, source_id: 'bluesky_geopolitics', class: 'social', prod_reason: 'source_class_drop', score: i === 0 ? 5 : 0, variants: i === 0 ? '{"strict3":false,"loose1":false,"social_ok":true}' : '{"strict3":false,"loose1":false,"social_ok":false}' }));
  for (let i = 0; i < 4; i++) insertItem(lab, row({ item_id: `l${i}`, prod_reason: 'low_score', score: 2, variants: '{"strict3":false,"loose1":true,"social_ok":true}' }));
  insertItem(lab, row({ item_id: 'd0', prod_reason: 'duplicate', dup_of: 'p1', score: 6 }));
  const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, ?, ?, ?, ?, ?, ?, 1)");
  a.run('s0', NOW - H, 'social', 'boundary', 'moderate', 'down', 'Surprise Fed comment moves rates', 1);
  a.run('s1', NOW - H, 'social', 'random', 'minor', 'neutral', 'rant', 0);
  a.run('s2', NOW - H, 'social', 'random', 'minor', 'neutral', 'rant', 0);
  a.run('l0', NOW - H, 'low_score', 'random', 'minor', 'neutral', 'meh', 0);
  a.run('l1', NOW - H, 'low_score', 'boundary', 'minor', 'neutral', 'meh', 0);
  a.run('d0', NOW - H, 'duplicate', 'random', 'minor', 'neutral', 'repeat', 0);
  bot.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'gate', 'claude-haiku-5-5', 'g', 1, 1, 0.0001, 1)").run(NOW - 3 * H);
  bot.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'impact', 'claude-sonnet-5-5', 'i', 1, 1, 0.004, 1)").run(NOW - 3 * H);
  recordMark(bot, NOW - 2 * H, 100);
  return { lab, bot };
}

describe('buildReport', () => {
  it('states the funnel, the per-stratum audit results, the misses and the bound', () => {
    const { lab, bot } = fixture();
    const md = buildReport(lab, bot, NOW);
    expect(md).toContain('# Intake lab report');
    expect(md).toMatch(/Items logged: 13\b/);
    expect(md).toMatch(/Passed the prefilter \(to Haiku\): 2\b/);
    expect(md).toMatch(/social\s*\|\s*6\s*\|\s*2\s*\|\s*0\b/);                 // stratum | volume | random audited | random misses
    expect(md).toMatch(/low_score\s*\|\s*4\s*\|\s*1\s*\|\s*0\b/);
    expect(md).toContain('95% upper bound');
    expect(md).toContain('Surprise Fed comment moves rates');                 // the one miss, with its headline context
    expect(md).toMatch(/Boundary samples \(not part of the estimate\): 2 audited, 1 miss\./);  // s0 (a miss) and l1
  });
  it('compares the rule variants: what each would add and which misses it would have caught', () => {
    const { lab, bot } = fixture();
    const md = buildReport(lab, bot, NOW);
    // | variant | would pass | extra vs production | audited extras | misses it would have caught |
    expect(md).toMatch(/^\| loose1 \| 6 \| 4 \| 2 \| 0 \|$/m);      // 2 passed + 4 low-score; 4 extras, 2 audited (l0, l1), no miss among them
    expect(md).toMatch(/^\| social_ok \| 7 \| 5 \| 3 \| 1 \|$/m);   // 2 + 1 social post + 4 low-score; 5 extras, 3 audited (s0, l0, l1), the single miss s0
  });
  it('estimates the saving from the bot actual per-call costs', () => {
    const { lab, bot } = fixture();
    const md = buildReport(lab, bot, NOW);
    expect(md).toMatch(/Estimated model spend avoided: \$[0-9.]+/);
  });
  it('recommends keeping the filter when there are too few audits, and says so plainly', () => {
    const { lab, bot } = fixture();
    expect(buildReport(lab, bot, NOW)).toMatch(/Not enough audited items/i);
  });
  it('recommends keeping the production filter when many random audits found no miss', () => {
    const lab = openLabDb(':memory:');
    for (let i = 0; i < 150; i++) insertItem(lab, row({ item_id: `n${i}`, class: 'social', prod_reason: 'source_class_drop', source_id: 'bluesky_geopolitics' }));
    const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, 'social', 'random', 'minor', 'neutral', 'x', 0, 1)");
    for (let i = 0; i < 150; i++) a.run(`n${i}`, NOW - H);
    const md = buildReport(lab, null, NOW);
    expect(md).toMatch(/Keep the production filter/i);
  });
  // Fix round 1 (authorised plan deviation): the tests below pin the new behaviour.
  it('does not say keep the production filter while a stratum with dropped items has no random audits, and names it', () => {
    const lab = openLabDb(':memory:');
    for (let i = 0; i < 150; i++) insertItem(lab, row({ item_id: `n${i}`, class: 'social', prod_reason: 'source_class_drop', source_id: 'bluesky_geopolitics' }));
    for (let i = 0; i < 100; i++) insertItem(lab, row({ item_id: `h${i}`, prod_reason: 'haiku_cap' }));
    const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, 'social', 'random', 'minor', 'neutral', 'x', 0, 1)");
    for (let i = 0; i < 150; i++) a.run(`n${i}`, NOW - H);
    const md = buildReport(lab, null, NOW);
    expect(md).not.toMatch(/Keep the production filter/i);
    expect(md).toMatch(/Covers 60% of dropped volume; unaudited strata, counted at a bound of 100%: haiku_cap \(100 items\)/);
    expect(md).toMatch(/## Recommendation[\s\S]*haiku_cap \(100 items\)[\s\S]*loose/);
    // 0.6 x CP(0,150) + 0.4 x 1, about 41.9%: the bound is dominated by the unaudited stratum
    expect(md).toMatch(/95% upper bound 4[0-2]\.\d\d%/);
  });
  it('a boundary miss with no random miss is named in the recommendation', () => {
    const lab = openLabDb(':memory:');
    for (let i = 0; i < 151; i++) insertItem(lab, row({ item_id: `n${i}`, class: 'social', prod_reason: 'source_class_drop', source_id: 'bluesky_geopolitics' }));
    lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values ('n150', ?, 'social', 'boundary', 'major', 'up', 'edge', 1, 1)").run(NOW - H);
    const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, 'social', 'random', 'minor', 'neutral', 'x', 0, 1)");
    for (let i = 0; i < 150; i++) a.run(`n${i}`, NOW - H);
    const md = buildReport(lab, null, NOW);
    expect(md).toMatch(/Keep the production filter/i);
    expect(md).toMatch(/Boundary sampling found 1 miss; review it for lexicon additions\./);
  });
  it('the miss breakdown in the recommendation lists only strata that contribute to the estimate', () => {
    const lab = openLabDb(':memory:');
    for (let i = 0; i < 100; i++) insertItem(lab, row({ item_id: `n${i}`, class: 'social', prod_reason: 'source_class_drop', source_id: 'bluesky_geopolitics' }));
    const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, 'social', 'random', ?, 'down', 'r', ?, 1)");
    for (let i = 0; i < 100; i++) a.run(`n${i}`, NOW - H, i === 0 ? 'moderate' : 'minor', i === 0 ? 1 : 0);
    const md = buildReport(lab, null, NOW);
    expect(md).toMatch(/Review the 1 miss above/);
    expect(md).toContain('Misses came from: social (1/100).');
    expect(md).toMatch(/Covers 100% of dropped volume\./);
  });
  it('failed audits (ok = 0) count neither in the estimate nor in the miss list', () => {
    const lab = openLabDb(':memory:');
    for (let i = 0; i < 3; i++) insertItem(lab, row({ item_id: `n${i}`, class: 'social', prod_reason: 'source_class_drop', source_id: 'bluesky_geopolitics' }));
    const a = lab.prepare("insert into audits (item_id, at_ms, stratum, kind, bucket, direction, rationale, miss, ok) values (?, ?, 'social', 'random', ?, 'down', 'r', ?, ?)");
    a.run('n0', NOW - H, 'minor', 0, 1);
    a.run('n1', NOW - H, 'minor', 0, 1);
    a.run('n2', NOW - H, 'major', 1, 0);
    const md = buildReport(lab, null, NOW);
    expect(md).toMatch(/^\| social \| 3 \| 2 \| 0 \|/m);
    expect(md).toMatch(/## Every miss\s+None\./);
    expect(md).toContain('1 audit call(s) failed');
  });
  it('the Sonnet saving counts only the bot escalations inside the lab window', () => {
    const { lab, bot } = fixture();           // all 13 items were received at NOW - 2h, so the window is that single instant
    bot.prepare("update model_calls set cost_usd = 0.5 where stage = 'gate'").run();
    bot.prepare("update model_calls set cost_usd = 2.0 where stage = 'impact'").run();
    const j = bot.prepare("insert into journal (ts_ms, kind, payload) values (?, 'intake_outcome', ?)");
    j.run(NOW - 2 * H, '{"escalated":true}');       // inside (at the window edge)
    j.run(NOW - 2 * H, '{"escalated":true}');       // inside
    j.run(NOW - 2 * H, '{"escalated":false}');      // inside, not escalated
    j.run(NOW - 9 * H, '{"escalated":true}');       // outside, before
    j.run(NOW - 9 * H, '{"escalated":true}');       // outside, before
    j.run(NOW - H, '{"escalated":true}');           // outside, after
    // Haiku: (13 - 2) x 0.5 = 5.5.  Sonnet: (13 x 0.31 - 2) x 2.0 = (4.03 - 2) x 2 = 4.06.  Total 9.56 (all six escalations would give 5.50).
    const md = buildReport(lab, bot, NOW);
    expect(md).toContain('Estimated model spend avoided: $9.56');
    expect(md).toContain("vs 2, the bot's own escalations in the lab window");
  });
  it('lists the lab process starts and warns that the prefilter state is cold after each one', () => {
    const { lab, bot } = fixture();
    recordProcessStart(lab, Date.UTC(2026, 9, 14, 12, 0, 0), 'abc1234');
    recordProcessStart(lab, Date.UTC(2026, 9, 17, 3, 30, 0), 'def5678');
    const md = buildReport(lab, bot, NOW);
    expect(md).toContain('## Lab process starts');
    expect(md).toContain('- 2026-10-14T12:00:00.000Z commit abc1234');
    expect(md).toContain('- 2026-10-17T03:30:00.000Z commit def5678');
    expect(md.indexOf('abc1234')).toBeLessThan(md.indexOf('def5678'));
    expect(md).toMatch(/dedup and cap state is cold after each start/);
    expect(md).toMatch(/prod_\* columns .* may under-report duplicates/);
  });
  it('says so when no process start was recorded', () => {
    const { lab, bot } = fixture();
    expect(buildReport(lab, bot, NOW)).toMatch(/## Lab process starts\s+None recorded\./);
  });
  describe('success criteria and caveats', () => {
    const D = 24 * H;
    /** `n` items over exactly 2 days (first at NOW - 2 d, last at NOW), the first `passed` of them passed. */
    function twoDayLab(n: number, passed: number) {
      const lab = openLabDb(':memory:');
      const tx = lab.transaction(() => {
        for (let i = 0; i < n; i++) {
          const at = i === 0 ? NOW - 2 * D : i === n - 1 ? NOW : NOW - D;
          insertItem(lab, row({ item_id: `w${i}`, received_ms: at, prod_pass: i < passed ? 1 : 0, prod_reason: i < passed ? 'pass' : 'low_score' }));
        }
      });
      tx();
      return lab;
    }
    function journal(bot: ReturnType<typeof openPerpDb>, kind: string, payload: string, count: number, ts = NOW - D) {
      const j = bot.prepare('insert into journal (ts_ms, kind, payload) values (?, ?, ?)');
      for (let i = 0; i < count; i++) j.run(ts, kind, payload);
    }

    it('computes the per-day reduction against the 2026-10-14 baseline and says MET', () => {
      const lab = twoDayLab(5280, 528);        // 2640 items/day, 264 passed/day: 1 - 264/2640 = 90.0%
      const bot = openPerpDb(':memory:');
      journal(bot, 'intake_item', '{}', 3);
      journal(bot, 'intake_outcome', '{"escalated":true}', 100);   // 50/day: 1 - 50/830 = 94.0%
      journal(bot, 'intake_outcome', '{"escalated":true}', 7, NOW - 5 * D);   // outside the window
      const md = buildReport(lab, bot, NOW);
      expect(md).toContain('## Success criteria');
      expect(md).toContain('Window: 2.00 days');
      expect(md).toContain('2640 Haiku calls/day, 830 Sonnet calls/day');
      expect(md).toContain('- Items per day: 2640');
      expect(md).toContain('264 vs 2640: reduction 90.0%. Target (Haiku calls down at least 80%): MET.');
      expect(md).toContain('- Bot escalations to Sonnet per day: 50 vs 830: reduction 94.0%. Target (Sonnet escalations down at least 70%): MET.');
    });
    it('says NOT MET when the reductions fall short of the targets', () => {
      const lab = twoDayLab(2640, 2640);       // 1320 passed/day: 1 - 1320/2640 = 50.0%
      const bot = openPerpDb(':memory:');
      journal(bot, 'intake_item', '{}', 1);
      journal(bot, 'intake_outcome', '{"escalated":true}', 664);   // 332/day: 1 - 332/830 = 60.0%
      const md = buildReport(lab, bot, NOW);
      expect(md).toContain('1320 vs 2640: reduction 50.0%. Target (Haiku calls down at least 80%): NOT MET.');
      expect(md).toContain('332 vs 830: reduction 60.0%. Target (Sonnet escalations down at least 70%): NOT MET.');
    });
    it('skips the Sonnet reduction and says why when the bot journal has no intake_item rows in the window', () => {
      const lab = twoDayLab(100, 10);
      const bot = openPerpDb(':memory:');
      ensureModelCallsTable(bot);
      journal(bot, 'intake_outcome', '{"escalated":true}', 100);
      bot.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'gate', 'claude-haiku-5-5', 'g', 1, 1, 0.0001, 1)").run(NOW - D);
      bot.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'impact', 'claude-sonnet-5-5', 'i', 1, 1, 0.004, 1)").run(NOW - D);
      const md = buildReport(lab, bot, NOW);
      expect(md).toMatch(/the bot ran without the prefilter and its Sonnet figures are not comparable/);
      expect(md).not.toContain('Bot escalations to Sonnet per day');
      expect(md).toContain('The Sonnet part is not comparable');                      // the savings line says it too
      expect(md).toContain('Target (Haiku calls down at least 80%): MET.');           // 5/day vs 2640
    });
    it('does not flag the savings line when the bot journal has intake_item rows', () => {
      const { lab, bot } = fixture();
      journal(bot, 'intake_item', '{}', 1, NOW - 2 * H);
      expect(buildReport(lab, bot, NOW)).not.toContain('The Sonnet part is not comparable');
    });
    it('says less than a day of data instead of a per-day verdict', () => {
      const { lab, bot } = fixture();          // every item at one instant
      const md = buildReport(lab, bot, NOW);
      expect(md).toMatch(/Less than a day of data/);
      expect(md).not.toContain('Target (Haiku');
    });
    it('states the scope, the as-reproduced-by-the-lab wording and the sampling caveat', () => {
      const { lab, bot } = fixture();
      const md = buildReport(lab, bot, NOW);
      expect(md).toMatch(/Scope: only prefilter drops are audited;.*not_escalated.*not audited by the lab/);
      expect(md).toContain('as reproduced by the lab');
      expect(md).toMatch(/time-weighted .*quiet hour.*boundary audits remove boundary items from the random pool.*estimate, not a guarantee/);
    });
  });
  it('works without a bot database and with an empty lab', () => {
    expect(() => buildReport(openLabDb(':memory:'), null, NOW)).not.toThrow();
  });
});
