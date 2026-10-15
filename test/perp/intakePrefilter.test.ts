// test/perp/intakePrefilter.test.ts
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import type { Item } from '../../src/item.js';
import { NewsIntake } from '../../src/perp/intake/newsIntake.js';
import { createPrefilterState, loadPrefilterConfig, type PrefilterConfig } from '../../src/perp/intake/prefilter.js';
import { listJournal, openPerpDb } from '../../src/perp/store/db.js';
import type { GateImpact } from '../../src/perp/model/gate.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
let n = 0;
const item = (source_id: string, headline: string, over: Partial<Item> = {}): Item => ({
  item_id: `p${++n}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false, source_id, adapter: 'rss', trust_tier: 3,
  headline, snippet: null, url: null, raw_url: null, enrich_url: null, author: null, lang: null, body_state: 'absent', body: null,
  event_time: null, source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0, provenance_gaps: [],
  amends_item_id: null, amendment_kind: null, ...over,
});
const CFG = (over: Partial<PrefilterConfig> = {}): PrefilterConfig => ({ ...loadPrefilterConfig(path.resolve(__dirname, '../../config/perp-prefilter.json')), ...over });

function mk(opts: { impact?: GateImpact; enabled?: boolean; cfg?: PrefilterConfig; calendar?: boolean; state?: any } = {}) {
  const calls = { gate: 0, extract: 0 };
  const alerts: string[] = [];
  const db = openPerpDb(':memory:');
  const prefilter = opts.enabled === undefined && opts.cfg === undefined && opts.state === undefined
    ? { enabled: true, cfg: CFG(), state: createPrefilterState() }
    : { enabled: opts.enabled ?? true, cfg: opts.cfg ?? CFG(), state: opts.state ?? createPrefilterState() };
  const intake = new NewsIntake({
    db, now: () => NOW, alert: (m: string) => { alerts.push(m); },
    engine: { contextText: () => 'CTX', onAssessment: async () => undefined },
    gate: async () => { calls.gate += 1; const impact = opts.impact ?? 'moderate'; return { relevant: impact !== 'none', impact, reason: 'because' }; },
    extract: async (it: Item): Promise<ImpactAssessment> => {
      calls.extract += 1;
      return { itemId: it.item_id, receivedAtMs: NOW, publishedAtMs: NOW, direction: 'neutral', bucket: 'minor', horizon: 'days', credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r' };
    },
    prefilter, calendarWindowOpen: () => opts.calendar ?? false, commit: 'abc1234',
  } as never);
  const journal = (kind: string) => listJournal(db, kind, 50).map((r) => r.payload as any);
  return { intake, calls, alerts, db, journal, prefilter };
}

describe('NewsIntake with the prefilter', () => {
  it('drops a social item before any model call and journals why', async () => {
    const { intake, calls, journal } = mk();
    const it = item('bluesky_geopolitics', 'Inflation and the Fed: rates must fall');
    expect(await intake.handleItem(it)).toBe('prefiltered');
    expect(calls.gate).toBe(0);
    expect(intake.counters.prefiltered).toBe(1);
    expect(journal('intake_item')[0]).toMatchObject({ itemId: it.item_id, pass: false, reason: 'source_class_drop', sourceClass: 'social', commit: 'abc1234' });
    expect(journal('intake_outcome')).toHaveLength(0);
  });

  it('drops a low-score item, journals it, and counts it', async () => {
    const { intake, calls, journal } = mk();
    expect(await intake.handleItem(item('ukrinform_news', 'Zelensky briefs Burnham on Russian attacks against Ukraine'))).toBe('prefiltered');
    expect(calls.gate).toBe(0);
    expect(journal('intake_item')[0]).toMatchObject({ pass: false, reason: 'low_score', score: 2 });
  });

  it('a passing macro item reaches the gate; moderate escalates to Sonnet and journals both rows', async () => {
    const { intake, calls, journal } = mk({ impact: 'moderate' });
    const it = item('axios_all', 'Inflation heats up as gas prices surge');
    expect(await intake.handleItem(it)).toBe('assessed');
    expect(calls.gate).toBe(1);
    expect(calls.extract).toBe(1);
    expect(journal('intake_item')[0]).toMatchObject({ pass: true, reason: 'pass', score: 6 });
    expect(journal('intake_outcome')[0]).toMatchObject({ itemId: it.item_id, impact: 'moderate', escalated: true, reason: 'impact', haikuReason: 'because' });
  });

  it('impact none stops after the gate (gated_out); minor stops without a calendar window (not_escalated)', async () => {
    const none = mk({ impact: 'none' });
    expect(await none.intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'))).toBe('gated_out');
    expect(none.calls.extract).toBe(0);
    const minor = mk({ impact: 'minor' });
    expect(await minor.intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'))).toBe('not_escalated');
    expect(minor.calls.extract).toBe(0);
    expect(minor.journal('intake_outcome')[0]).toMatchObject({ impact: 'minor', escalated: false, reason: 'below_threshold' });
  });

  it('minor escalates inside a high-impact calendar window', async () => {
    const { intake, calls } = mk({ impact: 'minor', calendar: true });
    expect(await intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'))).toBe('assessed');
    expect(calls.extract).toBe(1);
  });

  it('the Sonnet hourly cap stops moderate items but a major one still goes through', async () => {
    const cfg = CFG({ sonnetPerHour: 1 });
    const a = mk({ impact: 'moderate', cfg });
    expect(await a.intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'))).toBe('assessed');
    expect(await a.intake.handleItem(item('cbs_politics', 'Tariffs on chips raise recession fears for markets'))).toBe('not_escalated');
    expect(a.journal('intake_outcome')[0]).toMatchObject({ reason: 'sonnet_cap', escalated: false });
    const b = mk({ impact: 'major', cfg });
    expect(await b.intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'))).toBe('assessed');
    expect(await b.intake.handleItem(item('cbs_politics', 'Tariffs on chips raise recession fears for markets'))).toBe('assessed');
  });

  it('a near-duplicate of an item that already passed is dropped without a model call', async () => {
    const { intake, calls, journal } = mk();
    await intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'));
    expect(await intake.handleItem(item('thehill_news', 'Inflation heats up as gas prices surge again'))).toBe('prefiltered');
    expect(calls.gate).toBe(1);
    expect(journal('intake_item')[0]).toMatchObject({ reason: 'duplicate' });
  });

  it('a failed gate call does not record the pass: a near-duplicate from another source still reaches the gate, and the Haiku-cap window is untouched', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state = createPrefilterState();
    const calls = { gate: 0 };
    const db = openPerpDb(':memory:');
    const intake = new NewsIntake({
      db, now: () => NOW, alert: () => undefined,
      engine: { contextText: () => 'CTX', onAssessment: async () => undefined },
      gate: async () => {
        calls.gate += 1;
        if (calls.gate === 1) throw new Error('haiku 529');
        return { relevant: true, impact: 'moderate', reason: 'ok' };
      },
      extract: async (it: Item) => ({ itemId: it.item_id, receivedAtMs: NOW, publishedAtMs: NOW, direction: 'neutral', bucket: 'minor', horizon: 'days', credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r' }) as ImpactAssessment,
      prefilter: { enabled: true, cfg: CFG(), state },
    } as never);
    expect(await intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'))).toBe('error');
    expect(state.passed).toHaveLength(0);
    expect(state.passAtMs).toHaveLength(0);
    expect(await intake.handleItem(item('thehill_news', 'Inflation heats up as gas prices surge again'))).toBe('assessed');
    expect(calls.gate).toBe(2);
    expect(state.passed).toHaveLength(1);
    expect(state.passAtMs).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('hygiene still runs first: a replay is skipped before the prefilter', async () => {
    const { intake, journal } = mk();
    expect(await intake.handleItem(item('axios_all', 'Inflation heats up', { replay: true }))).toBe('skipped_replay');
    expect(journal('intake_item')).toHaveLength(0);
  });

  it('fails closed when the prefilter throws: dropped, journaled, counted, one alert after five', async () => {
    const { intake, calls, journal, alerts } = mk({ state: undefined as never, enabled: true });
    (intake as any).d.prefilter.state = undefined; // a corrupt state makes prefilter() throw
    for (let i = 0; i < 6; i++) expect(await intake.handleItem(item('axios_all', `Inflation story ${i} heats up`))).toBe('prefilter_error');
    expect(calls.gate).toBe(0);
    expect(intake.counters.prefilter_error).toBe(6);
    expect(journal('prefilter_error')).toHaveLength(6);
    expect(alerts.filter((a) => /prefilter/i.test(a))).toHaveLength(1);
  });

  it('PERP_PREFILTER=off (enabled: false) behaves as before: every hygiene-passing item reaches the gate and relevant decides', async () => {
    const off = mk({ enabled: false, impact: 'minor' });
    expect(await off.intake.handleItem(item('bluesky_geopolitics', 'Anything at all'))).toBe('assessed');
    expect(off.calls.gate).toBe(1);
    expect(off.calls.extract).toBe(1);
    expect(off.journal('intake_item')).toHaveLength(0);
    expect(off.journal('intake_outcome')).toHaveLength(0);
  });

  it('a gate without an impact field (older callers) is treated as moderate when relevant', async () => {
    const calls = { extract: 0 };
    const db = openPerpDb(':memory:');
    const intake = new NewsIntake({
      db, now: () => NOW, alert: () => undefined,
      engine: { contextText: () => 'CTX', onAssessment: async () => undefined },
      gate: async () => ({ relevant: true, reason: 'r' }),
      extract: async (it: Item) => { calls.extract += 1; return { itemId: it.item_id, receivedAtMs: NOW, publishedAtMs: NOW, direction: 'neutral', bucket: 'minor', horizon: 'days', credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r' } as ImpactAssessment; },
      prefilter: { enabled: true, cfg: CFG(), state: createPrefilterState() },
    } as never);
    expect(await intake.handleItem(item('axios_all', 'Inflation heats up as gas prices surge'))).toBe('assessed');
    expect(calls.extract).toBe(1);
  });
});
