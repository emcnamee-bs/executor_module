// src/perp/lab/report.ts
//
// The end-of-week report (spec section 6). Pure over the lab database (and, read-only, the bot's); returns markdown.
import type Database from 'better-sqlite3';
import { STRATA, type Stratum } from './sampler.js';
import { sigma4h, movedFlag } from './marks.js';
import { clopperPearsonUpper, stratifiedEstimate, type StratumCount } from './stats.js';

/** Share of gate calls that escalated to Sonnet before the prefilter existed (measured 2026-10-14 from the bot ledger). */
export const BASELINE_SONNET_RATE = 0.31;
const MIN_AUDITS_FOR_VERDICT = 100;
const pct = (x: number | null, d = 2): string => (x === null ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const one = <T>(db: Database.Database, sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
const all = <T>(db: Database.Database, sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

export function buildReport(labDb: Database.Database, botDb: Database.Database | null, nowMs: number): string {
  const L: string[] = [];
  const items = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items').n;
  const passed = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items WHERE prod_pass = 1').n;
  const range = one<{ a: number | null; b: number | null }>(labDb, 'SELECT MIN(received_ms) AS a, MAX(received_ms) AS b FROM items');
  L.push('# Intake lab report', '');
  L.push(`Generated ${new Date(nowMs).toISOString()}. Items logged: ${items}. Window: ${range.a === null ? 'n/a' : new Date(range.a).toISOString()} to ${range.b === null ? 'n/a' : new Date(range.b).toISOString()}.`, '');

  L.push('## Funnel', '');
  L.push(`- Items logged: ${items}`);
  L.push(`- Passed the prefilter (to Haiku): ${passed} (${items === 0 ? 'n/a' : pct(passed / items, 1)})`);
  L.push('', '| Drop reason | Items |', '|---|---|');
  for (const r of all<{ prod_reason: string; n: number }>(labDb, 'SELECT prod_reason, COUNT(*) AS n FROM items GROUP BY prod_reason ORDER BY n DESC')) L.push(`| ${r.prod_reason} | ${r.n} |`);
  L.push('', '| Source | Items | Passed |', '|---|---|---|');
  for (const r of all<{ source_id: string; n: number; p: number }>(labDb, 'SELECT source_id, COUNT(*) AS n, SUM(prod_pass) AS p FROM items GROUP BY source_id ORDER BY n DESC LIMIT 20')) L.push(`| ${r.source_id} | ${r.n} | ${r.p} |`);

  L.push('', '## Audit: did the filter drop anything that mattered?', '');
  L.push('A miss is an audited dropped item that Sonnet rates moderate, major or shock. Random samples are unbiased; boundary samples target the likeliest misses and are reported separately.', '');
  L.push('| Stratum | Volume dropped | Random audited | Random misses | 95% upper bound |', '|---|---|---|---|---|');
  const counts: StratumCount[] = [];
  for (const s of STRATA) {
    const volume = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items WHERE prod_pass = 0 AND prod_reason = ?', stratumReason(s)).n;
    const a = one<{ n: number; k: number | null }>(labDb, "SELECT COUNT(*) AS n, SUM(miss) AS k FROM audits WHERE kind = 'random' AND ok = 1 AND stratum = ?", s);
    const k = a.k ?? 0;
    counts.push({ volume, n: a.n, k });
    L.push(`| ${s} | ${volume} | ${a.n} | ${k} | ${a.n === 0 ? 'n/a' : pct(clopperPearsonUpper(k, a.n))} |`);
  }
  const est = stratifiedEstimate(counts);
  L.push('', `Overall random estimate: ${est.n} audited, ${est.k} miss${est.k === 1 ? '' : 'es'}, rate ${pct(est.rate)}, 95% upper bound ${pct(est.upper95)} (volume-weighted; the bound is the weighted sum of per-stratum bounds, so it is conservative).`);
  const bd = one<{ n: number; k: number | null }>(labDb, "SELECT COUNT(*) AS n, SUM(miss) AS k FROM audits WHERE kind = 'boundary' AND ok = 1");
  L.push('', `Boundary samples (not part of the estimate): ${bd.n} audited, ${bd.k ?? 0} miss${(bd.k ?? 0) === 1 ? '' : 'es'}.`);
  const failed = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM audits WHERE ok = 0').n;
  if (failed > 0) L.push(`${failed} audit call(s) failed and were not retried.`);

  L.push('', '## Every miss', '');
  const misses = all<{ item_id: string; source_id: string; headline: string; stratum: string; kind: string; bucket: string; direction: string; rationale: string }>(
    labDb, 'SELECT i.item_id, i.source_id, i.headline, a.stratum, a.kind, a.bucket, a.direction, a.rationale FROM audits a JOIN items i ON i.item_id = a.item_id WHERE a.miss = 1 ORDER BY a.at_ms'
  );
  if (misses.length === 0) L.push('None.');
  for (const m of misses) L.push(`- [${m.kind}/${m.stratum}] ${m.source_id}: ${m.headline.slice(0, 160)} -> ${m.bucket} ${m.direction}. ${m.rationale.slice(0, 200)}`);

  L.push('', '## Dropped items followed by an unusually large move (second signal)', '');
  const sigma = botDb === null ? null : sigma4h(botDb, nowMs);
  if (sigma === null) L.push('Not enough price history to estimate the 4 h volatility.');
  else {
    const moved = all<{ source_id: string; headline: string; prod_reason: string; ret_4h: number }>(labDb, 'SELECT source_id, headline, prod_reason, ret_4h FROM items WHERE prod_pass = 0 AND ret_4h IS NOT NULL ORDER BY received_ms')
      .filter((r) => movedFlag(r.ret_4h, sigma));
    L.push(`Flagged when |4 h return| >= 2 x sigma (sigma = ${pct(sigma)}). Supporting evidence only: other news also moves the price. ${moved.length} flagged.`);
    for (const r of moved.slice(0, 30)) L.push(`- ${r.source_id} (${r.prod_reason}): ${r.headline.slice(0, 140)}  ret_4h ${pct(r.ret_4h)}`);
  }

  L.push('', '## Rule variants', '', '| Variant | Would pass | Extra vs production | Audited extras | Misses it would have caught |', '|---|---|---|---|---|');
  for (const v of ['strict3', 'loose1', 'social_ok']) {
    const would = one<{ n: number }>(labDb, `SELECT COUNT(*) AS n FROM items WHERE json_extract(variants, '$.${v}') = 1`).n;
    const extra = one<{ n: number }>(labDb, `SELECT COUNT(*) AS n FROM items WHERE json_extract(variants, '$.${v}') = 1 AND prod_pass = 0`).n;
    const ex = one<{ n: number; k: number | null }>(labDb, `SELECT COUNT(*) AS n, SUM(a.miss) AS k FROM items i JOIN audits a ON a.item_id = i.item_id WHERE json_extract(i.variants, '$.${v}') = 1 AND i.prod_pass = 0 AND a.ok = 1`);
    L.push(`| ${v} | ${would} | ${extra} | ${ex.n} | ${ex.k ?? 0} |`);
  }

  L.push('', '## Cost', '');
  if (botDb === null) L.push('No bot ledger supplied: spend estimate unavailable.');
  else try {
    const avg = (stage: string): number | null => one<{ a: number | null }>(botDb, 'SELECT AVG(cost_usd) AS a FROM model_calls WHERE stage = ? AND ok = 1', stage).a;
    const g = avg('gate');
    const s = avg('impact');
    const sonnetCalls = all<{ payload: string }>(botDb, "SELECT payload FROM journal WHERE kind = 'intake_outcome'").filter((r) => JSON.parse(r.payload).escalated === true).length;
    if (g === null || s === null) L.push('The bot ledger has no gate/impact cost rows yet: spend estimate unavailable.');
    else {
      const saved = (items - passed) * g + Math.max(0, items * BASELINE_SONNET_RATE - sonnetCalls) * s;
      L.push(`Estimated model spend avoided: $${saved.toFixed(2)} (unfiltered Haiku reads ${items} vs ${passed}; Sonnet calls at the pre-prefilter rate ${(BASELINE_SONNET_RATE * 100).toFixed(0)}% vs ${sonnetCalls}; average cost per gate call $${g.toFixed(5)}, per impact call $${s.toFixed(5)}).`);
    }
  } catch {
    L.push('The bot ledger could not be read for costs: spend estimate unavailable.');
  }
  const labSpend = one<{ s: number | null }>(labDb, 'SELECT SUM(cost_usd) AS s FROM model_calls').s ?? 0;
  L.push(`Lab audit spend: $${labSpend.toFixed(2)}.`);

  L.push('', '## Recommendation', '');
  if (est.n < MIN_AUDITS_FOR_VERDICT) L.push(`Not enough audited items (${est.n} random audits; ${MIN_AUDITS_FOR_VERDICT} needed) for a verdict: keep the production filter and keep collecting.`);
  else if (est.k === 0) L.push(`Keep the production filter. No miss in ${est.n} random audits; the 95% upper bound on the miss rate is ${pct(est.upper95)}. Consider loosening only if the bot is starved of news it should read.`);
  else {
    const where = counts.map((c, i) => ({ s: STRATA[i], c })).filter((x) => x.c.k > 0).map((x) => `${x.s} (${x.c.k}/${x.c.n})`).join(', ');
    L.push(`Review the ${est.k} miss${est.k === 1 ? '' : 'es'} above before changing anything. Misses came from: ${where}. If they share a pattern, add it to the lexicon; if they are social posts, consider allow-listing that account class (variant social_ok shows the cost).`);
  }
  L.push('');
  return L.join('\n');
}

function stratumReason(s: Stratum): string {
  return s === 'social' ? 'source_class_drop' : s;
}
