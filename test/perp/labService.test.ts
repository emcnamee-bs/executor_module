// test/perp/labService.test.ts
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { loadPrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { evaluate, makeEvaluator } from '../../src/perp/lab/features.js';
import { firstItemMs, getMeta, openLabDb } from '../../src/perp/lab/labDb.js';
import { makeRng } from '../../src/perp/lab/sampler.js';
import { LabService, type LabServiceDeps } from '../../src/perp/lab/service.js';
import { openPerpDb, recordMark } from '../../src/perp/store/db.js';

// Pass-through spy on evaluate so a test can prove a redelivered entry is never evaluated (and so never touches the dedup state) again.
vi.mock('../../src/perp/lab/features.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/perp/lab/features.js')>();
  return { ...m, evaluate: vi.fn(m.evaluate) };
});

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0); // UTC hour 12: allowance = cap/24 x 14
let n = 0;
const item = (source_id: string, headline: string, over: Partial<Item> = {}): Item => ({
  item_id: `s${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3, headline, snippet: null,
  url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0, provenance_gaps: [], amends_item_id: null, amendment_kind: null, ...over,
});
const entry = (it: Item) => ({ id: `${n}-0`, fields: { json: JSON.stringify(it) } });

function mk(over: Partial<LabServiceDeps> = {}, clock = { t: NOW }) {
  const labDb = openLabDb(':memory:');
  const botDb = openPerpDb(':memory:');
  recordMark(botDb, NOW - 30_000, 13.5);
  const cfg = loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json'));
  const alerts: string[] = []; const audits: string[] = []; const reports: string[] = [];
  const svc = new LabService({
    labDb, botDb, evaluator: makeEvaluator(cfg), cfg, now: () => clock.t, commit: 'abc1234', capUsd: 0.5, days: 7, rng: makeRng(1),
    audit: async (row) => { audits.push(row.item_id); return 'audited'; },
    alert: (m) => { alerts.push(m); }, writeReport: (md) => { reports.push(md); }, ...over,
  });
  return { svc, labDb, botDb, alerts, audits, reports, clock };
}
const items = (db: ReturnType<typeof openLabDb>) => db.prepare('select item_id, prod_pass, prod_reason, class, mark from items order by received_ms, item_id').all() as Array<Record<string, unknown>>;

describe('handleEntry', () => {
  it('logs a passing item with the production verdict, lexicon features and the mark at ingest (a source absent from the config is class unknown)', async () => {
    const { svc, labDb } = mk();
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')))).toBe('logged');
    expect(items(labDb)[0]).toMatchObject({ prod_pass: 1, prod_reason: 'pass', class: 'unknown', mark: 13.5 });
  });
  it('logs a dropped social post with its drop reason', async () => {
    const { svc, labDb } = mk();
    await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    expect(items(labDb)[0]).toMatchObject({ prod_pass: 0, prod_reason: 'source_class_drop', class: 'social' });
  });
  it('applies the shared hygiene: replays and stale items are skipped and not logged', async () => {
    const { svc, labDb } = mk();
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation', { replay: true })))).toBe('skipped');
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation', { source_publish_ts: new Date(NOW - 7 * H).toISOString() })))).toBe('skipped');
    expect(items(labDb)).toHaveLength(0);
  });
  it('an unparseable entry is a parse_error and never throws', async () => {
    const { svc } = mk();
    expect(await svc.handleEntry({ id: '1-0', fields: {} })).toBe('parse_error');
    expect(await svc.handleEntry({ id: '1-1', fields: { json: '{nope' } })).toBe('parse_error');
  });
  it('a redelivered entry neither double-logs nor changes the dedup state a second time', async () => {
    const { svc, labDb } = mk();
    const first = item('axios_all', 'Inflation heats up as gas prices surge');
    vi.mocked(evaluate).mockClear();
    expect(await svc.handleEntry(entry(first))).toBe('logged');
    expect(vi.mocked(evaluate)).toHaveBeenCalledTimes(1);
    expect(await svc.handleEntry(entry(first))).toBe('duplicate');
    expect(vi.mocked(evaluate)).toHaveBeenCalledTimes(1); // the redelivery was not evaluated again
    // had the redelivery re-run the prefilter it would now look like a duplicate of itself; a later fresh item must still see only ONE earlier pass
    expect(items(labDb)).toHaveLength(1);
    await svc.handleEntry(entry(item('thehill_news', 'Inflation heats up as gas prices surge again')));
    expect(items(labDb)[1]).toMatchObject({ prod_reason: 'duplicate' });
  });
  it('works with no bot database: features are still logged, the mark is null', async () => {
    const { svc, labDb } = mk({ botDb: null });
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')))).toBe('logged');
    expect(items(labDb)[0].mark).toBeNull();
  });
  it('a bot database that throws on read degrades to a null mark instead of failing the entry', async () => {
    const { svc, labDb, botDb } = mk();
    botDb.close();
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')))).toBe('logged');
    expect(items(labDb)[0].mark).toBeNull();
  });
  it('tracks when the last entry arrived, even for an unparseable one', async () => {
    const { svc } = mk();
    expect(svc.lastEntryAtMs).toBeNull();
    await svc.handleEntry({ id: '1-0', fields: {} });
    expect(svc.lastEntryAtMs).toBe(NOW);
  });
});

describe('auditTick', () => {
  const dropped = async (svc: LabService) => { await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall'))); };
  it('audits one candidate per tick through the injected audit function', async () => {
    const { svc, audits } = mk();
    await dropped(svc);
    expect(await svc.auditTick()).toBe('audited');
    expect(audits).toHaveLength(1);
  });
  it('is idle when there is nothing to audit', async () => {
    const { svc } = mk();
    expect(await svc.auditTick()).toBe('idle');
  });
  it('is paced: once the day allowance is spent it does not audit', async () => {
    const { svc, labDb, audits } = mk();
    await dropped(svc);
    labDb.prepare("insert into model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok) values (?, 'impact', 'm', 'z', 1, 1, 0.3, 1)").run(NOW - 1000);
    expect(await svc.auditTick()).toBe('paced');
    expect(audits).toHaveLength(0);
  });
  it('two overlapping ticks never pay for the same item twice (re-entrancy guard)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const audits: string[] = [];
    const { svc } = mk({ audit: async (row) => { audits.push(row.item_id); await gate; return 'audited'; } });
    await dropped(svc);
    const a = svc.auditTick();
    const b = svc.auditTick();
    release();
    expect([await a, await b].sort()).toEqual(['audited', 'busy']);
    expect(audits).toHaveLength(1);
  });
  it('an audit that rejects resolves to error, releases the overlap guard and leaves the service working', async () => {
    let healthy = false;
    const { svc } = mk({ audit: async () => { if (!healthy) throw new Error('model exploded'); return 'audited'; } });
    await dropped(svc);
    await expect(svc.auditTick()).resolves.toBe('error');
    healthy = true;
    await expect(svc.auditTick()).resolves.toBe('audited'); // not 'busy': the guard was released
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')))).toBe('logged');
  });
  it('a database failure inside the tick also resolves to error instead of rejecting', async () => {
    const { svc, labDb } = mk();
    labDb.close();
    await expect(svc.auditTick()).resolves.toBe('error');
  });
  it('after the audit window (day 7) it is inactive and spends nothing, but logging continues', async () => {
    const clock = { t: NOW };
    const { svc, audits, labDb } = mk({}, clock);
    await dropped(svc);
    clock.t = NOW + 7 * 24 * H + 1;
    expect(svc.auditActive()).toBe(false);
    expect(await svc.auditTick()).toBe('inactive');
    expect(audits).toHaveLength(0);
    expect(await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge', {
      source_publish_ts: new Date(clock.t - 60_000).toISOString(), first_seen_ts: new Date(clock.t - 50_000).toISOString() })))).toBe('logged');
    expect(items(labDb).length).toBe(2);
  });
  it('the window boundary is exact: still active one millisecond before 7 days, inactive at 7 days', async () => {
    const clock = { t: NOW };
    const { svc } = mk({}, clock);
    await dropped(svc);
    clock.t = NOW + 7 * 24 * H - 1;
    expect(svc.auditActive()).toBe(true);
    clock.t = NOW + 7 * 24 * H;
    expect(svc.auditActive()).toBe(false);
  });
});

describe('maybeReport / heartbeat / silence / marks', () => {
  it('writes the report and alerts exactly once, only after the window closes', async () => {
    const clock = { t: NOW };
    const { svc, reports, alerts, labDb } = mk({}, clock);
    await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    expect(await svc.maybeReport()).toBe(false);
    clock.t = NOW + 7 * 24 * H;
    expect(await svc.maybeReport()).toBe(true);
    expect(await svc.maybeReport()).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('# Intake lab report');
    expect(alerts.filter((a) => a.startsWith('[PERP-LAB]'))).toHaveLength(1);
    expect(getMeta(labDb, 'report_done')).not.toBeNull();
  });
  it('the completion alert names the configured number of days and an overridable report path', async () => {
    const clock = { t: NOW };
    const a = mk({ days: 3 }, clock);
    await a.svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    clock.t = NOW + 3 * 24 * H;
    await a.svc.maybeReport();
    expect(a.alerts[0]).toMatch(/^\[PERP-LAB\] the 3-day audit is complete; the report is in data\/perp\/intake-lab-week1\.md$/);
    const clock2 = { t: NOW };
    const b = mk({ reportPathLabel: 'somewhere/else.md' }, clock2);
    await b.svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    clock2.t = NOW + 7 * 24 * H;
    await b.svc.maybeReport();
    expect(b.alerts[0]).toContain('the 7-day audit is complete; the report is in somewhere/else.md');
  });
  it('a report failure returns false, sends no alert, leaves report_done unset, and the next tick retries', async () => {
    const clock = { t: NOW };
    let healthy = false;
    const written: string[] = [];
    const { svc, alerts, labDb } = mk({ writeReport: (md) => { if (!healthy) throw new Error('disk full'); written.push(md); } }, clock);
    await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    clock.t = NOW + 7 * 24 * H;
    await expect(svc.maybeReport()).resolves.toBe(false);
    expect(alerts).toHaveLength(0);
    expect(getMeta(labDb, 'report_done')).toBeNull();
    healthy = true;
    await expect(svc.maybeReport()).resolves.toBe(true);
    expect(written).toHaveLength(1);
    expect(alerts.filter((x) => x.startsWith('[PERP-LAB]'))).toHaveLength(1);
    expect(getMeta(labDb, 'report_done')).not.toBeNull();
  });
  it('an alert that throws after a successful write still counts as done and is not repeated', async () => {
    const clock = { t: NOW };
    let alertCalls = 0;
    const { svc, reports, labDb } = mk({ alert: () => { alertCalls++; throw new Error('slack down'); } }, clock);
    await svc.handleEntry(entry(item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall')));
    clock.t = NOW + 7 * 24 * H;
    await expect(svc.maybeReport()).resolves.toBe(true);
    expect(getMeta(labDb, 'report_done')).not.toBeNull();
    await expect(svc.maybeReport()).resolves.toBe(false);
    expect(reports).toHaveLength(1);
    expect(alertCalls).toBe(1);
  });
  it('records a heartbeat with stream, bot db and marks health', async () => {
    const { svc, labDb } = mk();
    await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')));
    svc.recordHeartbeat();
    expect(labDb.prepare('select stream_ok, bot_db_ok, marks_fresh from heartbeat').get()).toEqual({ stream_ok: 1, bot_db_ok: 1, marks_fresh: 1 });
  });
  it('heartbeat reports an unreadable bot db as 0 without throwing', () => {
    const { svc, labDb, botDb } = mk();
    botDb.close();
    expect(() => svc.recordHeartbeat()).not.toThrow();
    expect(labDb.prepare('select bot_db_ok, marks_fresh from heartbeat').get()).toEqual({ bot_db_ok: 0, marks_fresh: 0 });
  });
  it('alerts once when the stream has been silent for more than 30 minutes, and re-arms after an entry', async () => {
    const clock = { t: NOW };
    const { svc, alerts } = mk({}, clock);
    await svc.silenceTick();
    expect(alerts).toHaveLength(0);
    clock.t = NOW + 31 * 60_000;
    await svc.silenceTick();
    await svc.silenceTick();
    expect(alerts.filter((a) => /no IIP items/i.test(a))).toHaveLength(1);
    // an entry arrives: the detector re-arms ...
    await svc.handleEntry({ id: '9-0', fields: {} });
    await svc.silenceTick();
    expect(alerts.filter((a) => /no IIP items/i.test(a))).toHaveLength(1);
    // ... and a second silence alerts again
    clock.t += 31 * 60_000;
    await svc.silenceTick();
    expect(alerts.filter((a) => /no IIP items/i.test(a))).toHaveLength(2);
  });
  it('fillMarks returns 0 with no bot db and never throws', () => {
    const { svc } = mk({ botDb: null });
    expect(svc.fillMarks()).toBe(0);
  });
  it('firstItemMs reflects the first logged item (the 7-day clock)', async () => {
    const { svc, labDb } = mk();
    expect(firstItemMs(labDb)).toBeNull();
    await svc.handleEntry(entry(item('axios_all', 'Inflation heats up as gas prices surge')));
    expect(firstItemMs(labDb)).toBe(NOW);
  });
});
