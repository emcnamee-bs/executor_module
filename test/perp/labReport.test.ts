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
    expect(md).toMatch(/Boundary samples[\s\S]*1 miss/i);
  });
  it('compares the rule variants: what each would add and which misses it would have caught', () => {
    const { lab, bot } = fixture();
    const md = buildReport(lab, bot, NOW);
    expect(md).toMatch(/loose1\s*\|\s*6\b/);        // 2 passed + 4 low-score pass under loose1
    expect(md).toMatch(/social_ok\s*\|\s*7\b/);     // 2 + 1 social post + 4 low-score
    expect(md).toMatch(/social_ok[^\n]*\|\s*1\s*\|?/); // it would have caught the single audited miss
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
  it('works without a bot database and with an empty lab', () => {
    expect(() => buildReport(openLabDb(':memory:'), null, NOW)).not.toThrow();
  });
});
