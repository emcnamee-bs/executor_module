// src/perp/lab/report.ts
//
// The end-of-week report (spec section 6). Pure over the lab database (and, read-only, the bot's); returns markdown.
import type Database from 'better-sqlite3';
import { listProcessStarts } from './labDb.js';
import { STRATA, type Stratum } from './sampler.js';
import { sigma4h, movedFlag } from './marks.js';
import { clopperPearsonUpper, stratifiedEstimate, type StratumCount } from './stats.js';

/** Share of gate calls that escalated to Sonnet before the prefilter existed (measured 2026-10-14 from the bot ledger). */
export const BASELINE_SONNET_RATE = 0.31;
/** Haiku gate calls per day before the prefilter existed (measured 2026-10-14: 661 in 6 h). */
export const BASELINE_HAIKU_PER_DAY = 2640;
/** Sonnet impact calls per day before the prefilter existed (measured 2026-10-14: 207 in 6 h). */
export const BASELINE_SONNET_PER_DAY = 830;
const DAY_MS = 86_400_000;
const MIN_AUDITS_FOR_VERDICT = 100;
const pct = (x: number | null, d = 2): string => (x === null ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const one = <T>(db: Database.Database, sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;
const all = <T>(db: Database.Database, sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];

/** The bot journal inside the lab window: how many items it prefiltered and how many it escalated to Sonnet. Null when unreadable. */
function botWindow(botDb: Database.Database | null, a: number | null, b: number | null): { intakeItems: number; escalations: number } | null {
  if (botDb === null || a === null || b === null) return null;
  try {
    const intakeItems = one<{ n: number }>(botDb, "SELECT COUNT(*) AS n FROM journal WHERE kind = 'intake_item' AND ts_ms >= ? AND ts_ms <= ?", a, b).n;
    const escalations = all<{ payload: string }>(botDb, "SELECT payload FROM journal WHERE kind = 'intake_outcome' AND ts_ms >= ? AND ts_ms <= ?", a, b).filter((r) => JSON.parse(r.payload).escalated === true).length;
    return { intakeItems, escalations };
  } catch {
    return null;
  }
}

export function buildReport(labDb: Database.Database, botDb: Database.Database | null, nowMs: number): string {
  const L: string[] = [];
  const items = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items').n;
  const passed = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM items WHERE prod_pass = 1').n;
  const range = one<{ a: number | null; b: number | null }>(labDb, 'SELECT MIN(received_ms) AS a, MAX(received_ms) AS b FROM items');
  L.push('# Intake lab report', '');
  L.push(`Generated ${new Date(nowMs).toISOString()}. Items logged: ${items}. Window: ${range.a === null ? 'n/a' : new Date(range.a).toISOString()} to ${range.b === null ? 'n/a' : new Date(range.b).toISOString()}.`, '');
  L.push('Scope: only prefilter drops are audited; items Haiku rates minor that the code does not escalate (not_escalated) are journaled by the bot but not audited by the lab. The prod_* columns are the prefilter verdict as reproduced by the lab (cold state after each process start; no seen/no_context skips), not a copy of the bot\'s own verdicts.', '');

  const bw = botWindow(botDb, range.a, range.b);
  L.push('## Success criteria', '');
  if (range.a === null || range.b === null || range.b - range.a < DAY_MS) {
    L.push(`Less than a day of data (window ${range.a === null || range.b === null ? 'empty' : ((range.b - range.a) / DAY_MS).toFixed(2) + ' days'}): the per-day comparison against the 2026-10-14 baseline is not meaningful yet. Raw counts: ${items} items, ${passed} passed to Haiku${bw === null ? '' : `, ${bw.escalations} bot escalations`}.`);
  } else {
    const days = (range.b - range.a) / DAY_MS;
    const passedPerDay = passed / days;
    const haikuCut = 1 - passedPerDay / BASELINE_HAIKU_PER_DAY;
    L.push(`Window: ${days.toFixed(2)} days (first to last logged item). Baseline of 2026-10-14: ${BASELINE_HAIKU_PER_DAY} Haiku calls/day, ${BASELINE_SONNET_PER_DAY} Sonnet calls/day.`, '');
    L.push(`- Items per day: ${(items / days).toFixed(0)}`);
    L.push(`- Passed to Haiku per day (as reproduced by the lab): ${passedPerDay.toFixed(0)} vs ${BASELINE_HAIKU_PER_DAY}: reduction ${pct(haikuCut, 1)}. Target (Haiku calls down at least 80%): ${haikuCut >= 0.8 ? 'MET' : 'NOT MET'}.`);
    if (bw === null) L.push('- Sonnet escalations: no bot ledger supplied or readable, so no figure.');
    else if (bw.intakeItems === 0) L.push('- Sonnet escalations: the bot journal has no intake_item rows in the lab window, so the bot ran without the prefilter and its Sonnet figures are not comparable; no Sonnet reduction is computed.');
    else {
      const escPerDay = bw.escalations / days;
      const sonnetCut = 1 - escPerDay / BASELINE_SONNET_PER_DAY;
      L.push(`- Bot escalations to Sonnet per day: ${escPerDay.toFixed(0)} vs ${BASELINE_SONNET_PER_DAY}: reduction ${pct(sonnetCut, 1)}. Target (Sonnet escalations down at least 70%): ${sonnetCut >= 0.7 ? 'MET' : 'NOT MET'}.`);
    }
  }
  L.push('');

  L.push('## Funnel', '');
  L.push(`- Items logged: ${items}`);
  L.push(`- Passed the prefilter (to Haiku): ${passed} (${items === 0 ? 'n/a' : pct(passed / items, 1)}), as reproduced by the lab`);
  L.push('', '| Drop reason | Items |', '|---|---|');
  for (const r of all<{ prod_reason: string; n: number }>(labDb, 'SELECT prod_reason, COUNT(*) AS n FROM items GROUP BY prod_reason ORDER BY n DESC')) L.push(`| ${r.prod_reason} | ${r.n} |`);
  L.push('', '| Source | Items | Passed |', '|---|---|---|');
  for (const r of all<{ source_id: string; n: number; p: number }>(labDb, 'SELECT source_id, COUNT(*) AS n, SUM(prod_pass) AS p FROM items GROUP BY source_id ORDER BY n DESC LIMIT 20')) L.push(`| ${r.source_id} | ${r.n} | ${r.p} |`);

  L.push('', '## Audit: did the filter drop anything that mattered?', '');
  L.push('A miss is an audited dropped item that Sonnet rates moderate, major or shock. Random samples are unbiased; boundary samples target the likeliest misses and are reported separately. Caveat: within a stratum the random sample is time-weighted (an item that arrives in a quiet hour is more likely to be audited than one arriving in a news burst) and boundary audits remove boundary items from the random pool, so the random miss rate can lean optimistic; read the bound as an estimate, not a guarantee.', '');
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
  const unaudited = counts.map((c, i) => ({ s: STRATA[i], volume: c.volume, n: c.n })).filter((x) => x.volume > 0 && x.n === 0);
  const unauditedText = unaudited.map((x) => `${x.s} (${x.volume} items)`).join(', ');
  L.push('', `Overall random estimate: ${est.n} audited, ${est.k} miss${est.k === 1 ? '' : 'es'}, rate ${pct(est.rate)}, 95% upper bound ${pct(est.upper95)} (volume-weighted; the bound is the weighted sum of per-stratum bounds, so it is conservative). Covers ${pct(est.coverage, 0)} of dropped volume${unaudited.length > 0 ? `; unaudited strata, counted at a bound of 100%: ${unauditedText}` : ''}.`);
  const bd = one<{ n: number; k: number | null }>(labDb, "SELECT COUNT(*) AS n, SUM(miss) AS k FROM audits WHERE kind = 'boundary' AND ok = 1");
  L.push('', `Boundary samples (not part of the estimate): ${bd.n} audited, ${bd.k ?? 0} miss${(bd.k ?? 0) === 1 ? '' : 'es'}.`);
  const failed = one<{ n: number }>(labDb, 'SELECT COUNT(*) AS n FROM audits WHERE ok = 0').n;
  if (failed > 0) L.push(`${failed} audit call(s) failed and were not retried.`);

  L.push('', '## Every miss', '');
  const misses = all<{ item_id: string; source_id: string; headline: string; stratum: string; kind: string; bucket: string; direction: string; rationale: string }>(
    labDb, 'SELECT i.item_id, i.source_id, i.headline, a.stratum, a.kind, a.bucket, a.direction, a.rationale FROM audits a JOIN items i ON i.item_id = a.item_id WHERE a.miss = 1 AND a.ok = 1 ORDER BY a.at_ms'
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

  L.push('', '## Rule variants', '', '| Variant | Would pass | Extra vs the prefilter as reproduced by the lab | Audited extras | Misses it would have caught |', '|---|---|---|---|---|');
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
    // The Sonnet count must cover the same window as `items`/`passed`: only the bot's journal rows between the first and last lab item.
    const sonnetCalls = range.a === null || range.b === null
      ? 0
      : all<{ payload: string }>(botDb, "SELECT payload FROM journal WHERE kind = 'intake_outcome' AND ts_ms >= ? AND ts_ms <= ?", range.a, range.b).filter((r) => JSON.parse(r.payload).escalated === true).length;
    const noPrefilterNote = bw !== null && bw.intakeItems === 0 ? ' The Sonnet part is not comparable: the bot journal has no intake_item rows in the lab window (the prefilter was off).' : '';
    if (g === null || s === null) L.push('The bot ledger has no gate/impact cost rows yet: spend estimate unavailable.');
    else {
      const sonnetSaved = range.a === null ? 0 : Math.max(0, items * BASELINE_SONNET_RATE - sonnetCalls) * s;
      const saved = (items - passed) * g + sonnetSaved;
      L.push(`Estimated model spend avoided: $${saved.toFixed(2)} (unfiltered Haiku reads ${items} vs ${passed}; Sonnet calls at the pre-prefilter rate ${(BASELINE_SONNET_RATE * 100).toFixed(0)}% vs ${sonnetCalls}, the bot's own escalations in the lab window; average cost per gate call $${g.toFixed(5)}, per impact call $${s.toFixed(5)}).${noPrefilterNote}`);
    }
  } catch {
    L.push('The bot ledger could not be read for costs: spend estimate unavailable.');
  }
  const labSpend = one<{ s: number | null }>(labDb, 'SELECT SUM(cost_usd) AS s FROM model_calls').s ?? 0;
  L.push(`Lab audit spend: $${labSpend.toFixed(2)}.`);

  L.push('', '## Lab process starts', '');
  const starts = listProcessStarts(labDb);
  if (starts.length === 0) L.push('None recorded.');
  else for (const s of starts) L.push(`- ${new Date(s.atMs).toISOString()} commit ${s.commit}`);
  L.push('', "The prefilter's dedup and cap state is cold after each start (it lives in the lab process's memory), so the prod_* columns (the production verdict as reproduced by the lab) in the first hours after a restart may under-report duplicates.");

  L.push('', '## Recommendation', '');
  if (est.n < MIN_AUDITS_FOR_VERDICT) L.push(`Not enough audited items (${est.n} random audits; ${MIN_AUDITS_FOR_VERDICT} needed) for a verdict: keep the production filter and keep collecting.`);
  else if (est.k === 0) {
    const boundaryNote = (bd.k ?? 0) > 0 ? ` Boundary sampling found ${bd.k} miss${bd.k === 1 ? '' : 'es'}; review ${bd.k === 1 ? 'it' : 'them'} for lexicon additions.` : '';
    if (unaudited.length > 0) L.push(`No miss in ${est.n} random audits, but ${unauditedText} had dropped items and no random audits, so the overall bound (${pct(est.upper95)}) is loose: it counts those strata at 100%. Do not decide to loosen the filter on this evidence; the production filter stays until every stratum with dropped items has been audited.${boundaryNote}`);
    else L.push(`Keep the production filter. No miss in ${est.n} random audits; the 95% upper bound on the miss rate is ${pct(est.upper95)}. Consider loosening only if the bot is starved of news it should read.${boundaryNote}`);
  } else {
    // Only strata that contribute to the estimate (volume and audits), so the breakdown adds up to est.k.
    const where = counts.map((c, i) => ({ s: STRATA[i], c })).filter((x) => x.c.volume > 0 && x.c.n > 0 && x.c.k > 0).map((x) => `${x.s} (${x.c.k}/${x.c.n})`).join(', ');
    const gap = unaudited.length > 0 ? ` Note: ${unauditedText} had dropped items and no random audits, so the overall bound is loose.` : '';
    L.push(`Review the ${est.k} miss${est.k === 1 ? '' : 'es'} above before changing anything. Misses came from: ${where}. If they share a pattern, add it to the lexicon; if they are social posts, consider allow-listing that account class (variant social_ok shows the cost).${gap}`);
  }
  L.push('');
  return L.join('\n');
}

function stratumReason(s: Stratum): string {
  return s === 'social' ? 'source_class_drop' : s;
}
