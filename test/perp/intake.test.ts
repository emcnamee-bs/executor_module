import { describe, it, expect, vi } from 'vitest';
import type { Item } from '../../src/item.js';
import { NewsIntake } from '../../src/perp/intake/newsIntake.js';
import { checkSilence } from '../../src/perp/intake/silence.js';
import { SpendCapError } from '../../src/perp/model/callJson.js';
import { listJournal, openPerpDb } from '../../src/perp/store/db.js';
import type { ImpactAssessment } from '../../src/perp/types.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;

const item = (over: Partial<Item> = {}): Item => ({
  item_id: `i-${Math.random()}`, dedup_id: 'd', story_key: null, event_type: 'item', replay: false,
  source_id: 'reuters', adapter: 'rss', trust_tier: 1, headline: 'Fed cuts rates', snippet: null, url: null, raw_url: null,
  enrich_url: null, author: null, lang: null, body_state: 'absent', body: null, event_time: null,
  source_publish_ts: new Date(NOW - 60_000).toISOString(), first_seen_ts: new Date(NOW - 50_000).toISOString(),
  emitted_ts: new Date(NOW - 40_000).toISOString(), latency_ms: null, is_first_sighting: true, corroborations: 0,
  provenance_gaps: [], amends_item_id: null, amendment_kind: null, ...over,
});

function mk(over: Record<string, unknown> = {}) {
  const calls = { gate: 0, extract: [] as string[], assessed: [] as ImpactAssessment[] };
  const alerts: string[] = [];
  let ctx: string | null = 'CTX';
  const db = openPerpDb(':memory:');
  const intake = new NewsIntake({
    db, now: () => NOW, alert: (m: string) => alerts.push(m),
    engine: { contextText: () => ctx, onAssessment: async (a: ImpactAssessment) => { calls.assessed.push(a); } },
    gate: async () => { calls.gate += 1; return { relevant: true, reason: 'r' }; },
    extract: async (it: Item, c: string) => {
      calls.extract.push(c);
      return { itemId: it.item_id, receivedAtMs: NOW, publishedAtMs: NOW - 60_000, direction: 'up', bucket: 'minor', horizon: 'days', credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r' };
    },
    ...over,
  } as never);
  return { intake, calls, alerts, db, setCtx: (c: string | null) => { ctx = c; } };
}

describe('NewsIntake', () => {
  it('gates, extracts with the engine context, and hands the assessment to the engine', async () => {
    const { intake, calls } = mk();
    expect(await intake.handleItem(item())).toBe('assessed');
    expect(calls.gate).toBe(1);
    expect(calls.extract).toEqual(['CTX']);
    expect(calls.assessed).toHaveLength(1);
  });

  it('skips replays, amendments and stale items without calling any model', async () => {
    const { intake, calls } = mk();
    expect(await intake.handleItem(item({ replay: true }))).toBe('skipped_replay');
    expect(await intake.handleItem(item({ event_type: 'item_amended' }))).toBe('skipped_amended');
    expect(await intake.handleItem(item({ source_publish_ts: new Date(NOW - 7 * H).toISOString() }))).toBe('skipped_old');
    expect(calls.gate).toBe(0);
  });

  it('a redelivered item id is processed only once', async () => {
    const { intake, calls } = mk();
    const it = item({ item_id: 'same' });
    expect(await intake.handleItem(it)).toBe('assessed');
    expect(await intake.handleItem(it)).toBe('skipped_seen');
    expect(calls.gate).toBe(1);
  });

  it('stops after the gate when the item is not relevant', async () => {
    const { intake, calls } = mk({ gate: async () => ({ relevant: false, reason: 'sports' }) });
    expect(await intake.handleItem(item())).toBe('gated_out');
    expect(calls.extract).toHaveLength(0);
  });

  it('skips when the engine has no context yet (no snapshot)', async () => {
    const m = mk();
    m.setCtx(null);
    expect(await m.intake.handleItem(item())).toBe('skipped_no_context');
    expect(m.calls.gate).toBe(0);
  });

  it('alerts once per UTC day when the model spend cap is hit, and never throws (review focus 6)', async () => {
    const { intake, alerts } = mk({ gate: async () => { throw new SpendCapError('cap reached'); } });
    expect(await intake.handleItem(item())).toBe('error');
    expect(await intake.handleItem(item())).toBe('error');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/spend cap/);
    expect(alerts[0]).toMatch(/exchange-side stop/);
  });

  it('records other model errors in the journal without alerting', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // the intake logs the failed item
    const { intake, alerts, db } = mk({ extract: async () => { throw new Error('503'); } });
    expect(await intake.handleItem(item())).toBe('error');
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    expect(alerts).toHaveLength(0);
    expect(listJournal(db, 'intake_error', 5)).toHaveLength(1);
  });

  it('handleEntry parses a stream entry and reports a malformed one as parse_error', async () => {
    const { intake, calls, db } = mk();
    expect(await intake.handleEntry({ id: '1-0', fields: { json: JSON.stringify(item()) } })).toBe('assessed');
    expect(calls.assessed).toHaveLength(1);
    expect(await intake.handleEntry({ id: '2-0', fields: { json: '{"headline": 1}' } })).toBe('parse_error');
    expect(await intake.handleEntry({ id: '3-0', fields: {} })).toBe('parse_error');
    expect(listJournal(db, 'intake_parse_error', 5)).toHaveLength(2);
  });

  it('counts outcomes', async () => {
    const { intake } = mk();
    await intake.handleItem(item());
    await intake.handleItem(item({ replay: true }));
    expect(intake.counters.assessed).toBe(1);
    expect(intake.counters.skipped_replay).toBe(1);
  });

  describe('never rejects, never loses an alert (R25)', () => {
    const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const capGate = async () => { throw new SpendCapError('cap reached'); };

    it('a throwing journal write on the parse-failure path does not reject handleEntry', async () => {
      const errSpy = quiet();
      const { intake, db } = mk();
      db.close();
      expect(await intake.handleEntry({ id: '2-0', fields: {} })).toBe('parse_error');
      expect(intake.counters.parse_error).toBe(1);
      errSpy.mockRestore();
    });

    it('a throwing journal write inside the error path still resolves error', async () => {
      const errSpy = quiet();
      const { intake, db } = mk({ extract: async () => { throw new Error('503'); } });
      db.close();
      expect(await intake.handleItem(item())).toBe('error');
      expect(intake.counters.error).toBe(1);
      errSpy.mockRestore();
    });

    it('handleEntry resolves error on anything unexpected', async () => {
      const errSpy = quiet();
      const { intake } = mk();
      const entry = { id: '9-0', get fields(): Record<string, string> { throw new Error('boom'); } };
      expect(await intake.handleEntry(entry)).toBe('error');
      expect(intake.counters.error).toBe(1);
      errSpy.mockRestore();
    });

    it('a synchronously throwing alert resolves error and does not suppress the next cap alert that day', async () => {
      const errSpy = quiet();
      const sent: string[] = [];
      let attempts = 0;
      const alert = (m: string) => { attempts += 1; if (attempts === 1) throw new Error('slack down'); sent.push(m); };
      const { intake } = mk({ gate: capGate, alert });
      expect(await intake.handleItem(item())).toBe('error');
      expect(sent).toHaveLength(0);
      expect(await intake.handleItem(item())).toBe('error');
      expect(sent).toHaveLength(1);
      expect(await intake.handleItem(item())).toBe('error');
      expect(sent).toHaveLength(1); // delivered once, now suppressed for the day
      errSpy.mockRestore();
    });

    it('an alert returning a rejected promise causes no unhandled rejection and resolves error', async () => {
      const errSpy = quiet();
      const unhandled: unknown[] = [];
      const onUnhandled = (r: unknown) => { unhandled.push(r); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { intake } = mk({ gate: capGate, alert: () => Promise.reject(new Error('slack 500')) });
        expect(await intake.handleItem(item())).toBe('error');
        await new Promise((r) => setImmediate(r));
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        errSpy.mockRestore();
      }
    });
  });

  describe('sustained provider outage alerts loudly, once per UTC day (R26)', () => {
    const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fail = async () => { throw new Error('anthropic 529 overloaded'); };
    const fresh = (clock: number) => item({ source_publish_ts: new Date(clock - 60_000).toISOString() });

    it('4 consecutive errors do not alert; the 5th alerts exactly once; later errors that day do not', async () => {
      const errSpy = quiet();
      const { intake, alerts } = mk({ extract: fail });
      for (let i = 0; i < 4; i++) await intake.handleItem(item());
      expect(alerts).toHaveLength(0);
      await intake.handleItem(item());
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatch(/5 consecutive/);
      expect(alerts[0]).toMatch(/anthropic 529 overloaded/);
      expect(alerts[0]).toMatch(/exchange-side stop/);
      for (let i = 0; i < 5; i++) await intake.handleItem(item());
      expect(alerts).toHaveLength(1);
      errSpy.mockRestore();
    });

    it('truncates the latest message to 200 characters', async () => {
      const errSpy = quiet();
      const long = 'x'.repeat(500);
      const { intake, alerts } = mk({ extract: async () => { throw new Error(long); } });
      for (let i = 0; i < 5; i++) await intake.handleItem(item());
      expect(alerts[0]).toContain('x'.repeat(200));
      expect(alerts[0]).not.toContain('x'.repeat(201));
      errSpy.mockRestore();
    });

    it('a successful assessment resets the counter', async () => {
      const errSpy = quiet();
      let failing = true;
      const { intake, alerts } = mk({
        extract: async (it: Item) => {
          if (failing) throw new Error('503');
          return { itemId: it.item_id, receivedAtMs: NOW, publishedAtMs: NOW - 60_000, direction: 'up', bucket: 'minor', horizon: 'days', credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r' };
        },
      });
      for (let i = 0; i < 4; i++) await intake.handleItem(item());
      failing = false;
      expect(await intake.handleItem(item())).toBe('assessed');
      failing = true;
      for (let i = 0; i < 4; i++) await intake.handleItem(item());
      expect(alerts).toHaveLength(0);
      errSpy.mockRestore();
    });

    it('a gated-out item resets the counter', async () => {
      const errSpy = quiet();
      let mode: 'err' | 'irrelevant' = 'err';
      const { intake, alerts } = mk({ gate: async () => { if (mode === 'err') throw new Error('503'); return { relevant: false, reason: 'x' }; } });
      for (let i = 0; i < 4; i++) await intake.handleItem(item());
      mode = 'irrelevant';
      expect(await intake.handleItem(item())).toBe('gated_out');
      mode = 'err';
      for (let i = 0; i < 4; i++) await intake.handleItem(item());
      expect(alerts).toHaveLength(0);
      errSpy.mockRestore();
    });

    it('spend-cap errors do not count toward the outage alert', async () => {
      const errSpy = quiet();
      const { intake, alerts } = mk({ gate: async () => { throw new SpendCapError('cap reached'); } });
      for (let i = 0; i < 10; i++) await intake.handleItem(item());
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatch(/spend cap/);
      errSpy.mockRestore();
    });

    it('re-arms on the next UTC day', async () => {
      const errSpy = quiet();
      let clock = NOW;
      const { intake, alerts } = mk({ extract: fail, now: () => clock });
      for (let i = 0; i < 5; i++) await intake.handleItem(fresh(clock));
      expect(alerts).toHaveLength(1);
      clock = NOW + 24 * H;
      await intake.handleItem(fresh(clock));
      expect(alerts).toHaveLength(2);
      await intake.handleItem(fresh(clock));
      expect(alerts).toHaveLength(2);
      errSpy.mockRestore();
    });

    it('a failed outage alert is retried on the next error the same day', async () => {
      const errSpy = quiet();
      const sent: string[] = [];
      let attempts = 0;
      const alert = (m: string) => { attempts += 1; if (attempts === 1) throw new Error('slack down'); sent.push(m); };
      const { intake } = mk({ extract: fail, alert });
      for (let i = 0; i < 5; i++) await intake.handleItem(item());
      expect(sent).toHaveLength(0);
      await intake.handleItem(item());
      expect(sent).toHaveLength(1);
      await intake.handleItem(item());
      expect(sent).toHaveLength(1);
      errSpy.mockRestore();
    });
  });
});

describe('IIP silence (W3)', () => {
  it('lastEntryAtMs is null before any entry and is stamped at the start of every handleEntry, even unparseable ones', async () => {
    let now = NOW;
    const { intake } = mk({ now: () => now });
    expect(intake.lastEntryAtMs).toBeNull();
    now = NOW + 1000;
    await intake.handleEntry({ id: '1-0', fields: {} }); // parse_error
    expect(intake.lastEntryAtMs).toBe(NOW + 1000);
    now = NOW + 2000;
    const entry = { id: '9-0', get fields(): Record<string, string> { throw new Error('boom'); } };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await intake.handleEntry(entry)).toBe('error');
    errSpy.mockRestore();
    expect(intake.lastEntryAtMs).toBe(NOW + 2000);
  });
});

describe('checkSilence (W3)', () => {
  const T = 30 * 60_000;
  it('does not alert within the threshold, counting from the later of the last entry and the start', () => {
    expect(checkSilence({ alerted: false }, NOW + T, null, NOW).alert).toBe(false);
    expect(checkSilence({ alerted: false }, NOW + T + 1, NOW + 1000, NOW).alert).toBe(false);
    expect(checkSilence({ alerted: false }, NOW + 10 * T, NOW + 9 * T + 1, NOW).alert).toBe(false);
  });
  it('alerts once past the threshold, then stays quiet until an entry re-arms it', () => {
    const first = checkSilence({ alerted: false }, NOW + T + 1, null, NOW);
    expect(first).toEqual({ alert: true, silentForMs: T + 1, state: { alerted: true } });
    const second = checkSilence(first.state, NOW + 2 * T, null, NOW);
    expect(second.alert).toBe(false);
    expect(second.state.alerted).toBe(true);
    const rearmed = checkSilence(second.state, NOW + 2 * T + 1000, NOW + 2 * T, NOW);
    expect(rearmed).toMatchObject({ alert: false, state: { alerted: false } });
    expect(checkSilence(rearmed.state, NOW + 3 * T + 1, NOW + 2 * T, NOW).alert).toBe(true);
  });
  it('uses the default 30 minute threshold', () => {
    expect(checkSilence({ alerted: false }, NOW + T, NOW, 0).alert).toBe(false);
    expect(checkSilence({ alerted: false }, NOW + T + 1, NOW, 0).alert).toBe(true);
  });
});
