// test/perp/labReport.test.ts
import { describe, it, expect } from 'vitest';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';
import { ensureModelCallsTable } from '../../src/perp/model/callJson.js';
import { insertItem, openLabDb, type LabItemRow } from '../../src/perp/lab/labDb.js';
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
  it('works without a bot database and with an empty lab', () => {
    expect(() => buildReport(openLabDb(':memory:'), null, NOW)).not.toThrow();
  });
});
