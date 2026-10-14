import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { DEFAULT_PAPER_CONFIG, PaperBroker, type PaperState } from '../../src/perp/broker/paper.js';
import type { BrokerQuote } from '../../src/perp/broker/types.js';
import { PerpEngine, type Collected } from '../../src/perp/engine/engine.js';
import { clearHaltInDb } from '../../src/perp/ops/clearHalt.js';
import { fundPaperInDb } from '../../src/perp/ops/paperFund.js';
import {
  getState, listExits, listJournal, loadPosition, loadRiskState, openPerpDb, savePosition, setState,
} from '../../src/perp/store/db.js';
import type { Broker, BrokerEvent, BrokerPosition } from '../../src/perp/broker/types.js';
import type { ImpactAssessment, PositionState } from '../../src/perp/types.js';

const NOW0 = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;
let seq = 0;

function harness(over: { startEquityUsd?: number } = {}) {
  let now = NOW0;
  const q = { bid: 13.75, ask: 13.76, mark: 13.755 };
  const getQuote = async (): Promise<BrokerQuote> => ({ ...q, tsMs: now });
  const broker = new PaperBroker(getQuote, { ...DEFAULT_PAPER_CONFIG, ...over }, () => now);
  const db = openPerpDb(':memory:');
  const alerts: string[] = [];
  let collectError: Error | null = null;
  let nextCloseTsMs: number | null = NOW0 + 3 * 24 * H;
  let marketOpen = true;
  let macroAgeMs = 0;
  const collect = async (): Promise<Collected> => {
    if (collectError) throw collectError;
    return {
      perp: { bid: q.bid, ask: q.ask, mark: q.mark, marketOpen, nextCloseTsMs, fundingEstimate: 0.0001 },
      perpFetchedAtMs: now,
      macro: { vix: { value: 16, change1d: 0, asOf: '2026-10-13' } },
      macroFetchedAtMs: now - macroAgeMs,
      events: [],
      kalshiEvents: [],
    };
  };
  const newEngine = (b: PaperBroker, persist: () => void = () => setState(db, 'paper', b.exportState())) =>
    new PerpEngine({
      cfg: DEFAULT_CONFIG, db, broker: b, now: () => now, collect, alert: (m) => alerts.push(m),
      persistBroker: persist,
      applyFunding: (r, m) => b.applyFunding(r, m),
    });
  return {
    broker, db, alerts, engine: newEngine(broker), newEngine, getQuote,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    setMark: (m: number) => { q.mark = m; q.bid = m - 0.005; q.ask = m + 0.005; },
    setCollectError: (e: Error | null) => { collectError = e; },
    setNextClose: (ts: number | null) => { nextCloseTsMs = ts; },
    setMarketOpen: (open: boolean) => { marketOpen = open; },
    setMacroAge: (ms: number) => { macroAgeMs = ms; },
  };
}
type H = ReturnType<typeof harness>;

const assess = (h: H, over: Partial<ImpactAssessment> = {}): ImpactAssessment => ({
  itemId: `item-${++seq}`, receivedAtMs: h.now(), publishedAtMs: h.now() - 30_000, direction: 'up', bucket: 'major',
  horizon: 'days', credibility: 0.8, novelty: 'new', alreadyPriced: 'no', confidence: 0.75, rationale: 'test', ...over,
});
async function openLong(h: H, over: Partial<ImpactAssessment> = {}) {
  await h.engine.tick();
  await h.engine.onAssessment(assess(h, over));
}
async function stopOut(h: H) {
  h.setMark(14.2);
  await h.engine.tick();
  h.setMark(13.6); // 14.2 * (1 - 0.0388) = 13.649
  await h.engine.tick();
}

describe('entries', () => {
  it('opens a long on credible bullish news, sizes the stop from realized leverage, and journals it', async () => {
    const h = harness();
    await openLong(h);
    expect((await h.broker.position())?.side).toBe('long');
    const stored = loadPosition(h.db)!;
    expect(stored.side).toBe('long');
    expect(stored.stopBps).toBe(388);
    expect(stored.leverage).toBeCloseTo(13.755 / 3.5, 6);
    expect(listJournal(h.db, 'open', 5)).toHaveLength(1);
    expect(h.alerts.join('\n')).toMatch(/OPENED long/);
  });

  it('records news but does nothing before the first snapshot exists (review focus 3)', async () => {
    const h = harness();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
  });

  it('never enters on news published before we had any price history (review focus 3)', async () => {
    const h = harness();
    await h.engine.tick();
    await h.engine.onAssessment(assess(h, { publishedAtMs: h.now() - 2 * H }));
    expect(await h.broker.position()).toBeNull();
  });

  it('journals and alerts a failed open without throwing or tracking a position', async () => {
    const h = harness();
    await h.engine.tick();
    vi.spyOn(h.broker, 'open').mockRejectedValue(new Error('exchange down'));
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
    expect(loadPosition(h.db)).toBeNull();
    expect(listJournal(h.db, 'open_failed', 1)).toHaveLength(1);
    expect(h.alerts.join('\n')).toMatch(/open failed/i);
  });
});

describe('exits', () => {
  it('after an exchange-side stop-out both sides cool down for 24h and a fresh bullish item is ignored', async () => {
    const h = harness();
    await openLong(h);
    await stopOut(h);
    expect(await h.broker.position()).toBeNull();
    expect(loadPosition(h.db)).toBeNull();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['trailing_stop']);
    expect(loadRiskState(h.db).cooldownUntilMs.long).toBe(h.now() + 24 * H);
    h.advance(10 * MIN);
    h.setMark(13.755);
    await h.engine.tick();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
  });

  it('a credible adverse shock exits the long and flips to a short immediately', async () => {
    const h = harness();
    await openLong(h);
    await h.engine.onAssessment(assess(h, { direction: 'down', bucket: 'shock', credibility: 1, confidence: 0.9 }));
    expect((await h.broker.position())?.side).toBe('short');
    expect(listExits(h.db, 0).map((e) => [e.rule, e.side])).toEqual([['shock', 'long']]);
    expect(loadRiskState(h.db).cooldownUntilMs.long).toBeGreaterThan(h.now());
    expect(loadPosition(h.db)?.side).toBe('short');
  });

  it('keeps the position when a close cannot fill, and retries on the next evaluation', async () => {
    const h = harness();
    await openLong(h);
    const spy = vi.spyOn(h.broker, 'close').mockRejectedValueOnce(new Error('no liquidity'));
    await h.engine.onAssessment(assess(h, { direction: 'down', bucket: 'shock', credibility: 1, confidence: 0.9 }));
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(listJournal(h.db, 'close_failed', 1)).toHaveLength(1);
    spy.mockRestore();
    h.advance(MIN);
    // The failed evaluation already counted one adverse-pressure breach (-2.7% vs the 2% exit threshold); the next
    // tick is the second consecutive breach, so the pressure rule closes the position even without a new item.
    await h.engine.tick();
    expect(await h.broker.position()).toBeNull();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['pressure']);
  });
});

describe('kill switch (review focus 2)', () => {
  async function twoStopOuts() {
    const h = harness();
    await openLong(h);
    await stopOut(h);
    h.advance(25 * H);
    h.setMark(13.755);
    await h.engine.tick();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).not.toBeNull();
    await stopOut(h);
    return h;
  }

  it('halts after two stop-outs in 30 days and refuses further entries', async () => {
    const h = await twoStopOuts();
    expect(loadRiskState(h.db).halted).toBe(true);
    expect(h.alerts.join('\n')).toMatch(/HALT/);
    h.advance(25 * H);
    h.setMark(13.755);
    await h.engine.tick();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
  });

  it('clearing the halt starts a new epoch: the old exits do not re-halt it', async () => {
    const h = await twoStopOuts();
    clearHaltInDb(h.db, h.now());
    h.advance(MIN);
    await h.engine.tick();
    expect(loadRiskState(h.db).halted).toBe(false);
  });
});

describe('restart reconciliation (review focus 1)', () => {
  it('keeps a stored position when the restored broker still holds it', async () => {
    const h = harness();
    await openLong(h);
    const b2 = new PaperBroker(h.getQuote, DEFAULT_PAPER_CONFIG, h.now);
    b2.importState(getState<PaperState>(h.db, 'paper')!);
    const e2 = h.newEngine(b2);
    await e2.start();
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(h.alerts.join('\n')).not.toMatch(/vanished/);
  });

  it('records a position that vanished while the bot was down as an unverified stop-out', async () => {
    const h = harness();
    await openLong(h);
    const flat = new PaperBroker(h.getQuote, DEFAULT_PAPER_CONFIG, h.now);
    const e2 = h.newEngine(flat);
    await e2.start();
    expect(loadPosition(h.db)).toBeNull();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['trailing_stop']);
    expect(h.alerts.join('\n')).toMatch(/vanished/);
  });

  it('adopts an orphan broker position and protects it with a stop', async () => {
    const h = harness();
    await h.broker.open({ side: 'short', contracts: 1, stopBps: 400 });
    await h.engine.start();
    const p = loadPosition(h.db)!;
    expect(p.side).toBe('short');
    expect(p.stopBps).toBe(388);
    expect(h.alerts.join('\n')).toMatch(/orphan/i);
  });
});

describe('resilience (review focus 5)', () => {
  it('survives collector failures, alerts once at 5 consecutive failures, and recovers', async () => {
    const h = harness();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // the engine logs each failed tick
    await h.engine.tick();
    h.setCollectError(new Error('boom'));
    for (let i = 0; i < 7; i++) await h.engine.tick();
    expect(h.alerts.filter((a) => /consecutive/.test(a))).toHaveLength(1);
    expect(h.engine.status().consecutiveFailures).toBe(7);
    h.setCollectError(null);
    await h.engine.tick();
    expect(h.engine.status().consecutiveFailures).toBe(0);
    h.setCollectError(new Error('boom'));
    for (let i = 0; i < 5; i++) await h.engine.tick();
    expect(h.alerts.filter((a) => /consecutive/.test(a))).toHaveLength(2);
    expect(errSpy).toHaveBeenCalledTimes(12);
    errSpy.mockRestore();
  });

  it('serializes a tick and a news item that arrive at the same time', async () => {
    const h = harness();
    await h.engine.tick();
    await Promise.all([h.engine.tick(), h.engine.onAssessment(assess(h)), h.engine.tick()]);
    expect(listJournal(h.db, 'open', 5)).toHaveLength(1);
  });
});

describe('paper funding', () => {
  it('charges the last pre-settlement estimate once per UTC day after 20:00', async () => {
    const h = harness();
    await openLong(h); // 15:00Z
    h.advance(4 * H + 50 * MIN); // 19:50Z
    await h.engine.tick();
    const before = (await h.broker.balance()).equityUsd;
    h.advance(11 * MIN); // 20:01Z
    await h.engine.tick();
    const after = (await h.broker.balance()).equityUsd;
    expect(before - after).toBeCloseTo(0.0001 * 13.755, 6);
    h.advance(MIN);
    await h.engine.tick();
    expect((await h.broker.balance()).equityUsd).toBeCloseTo(after, 8);
  });
});

describe('paper collateral top-up (W1)', () => {
  const lastDecisionReasons = (h: H): string =>
    (listJournal(h.db, 'decision', 1)[0].payload as { action: { reasons: string[] } }).action.reasons.join(' | ');

  it('a full-distance stop-out leaves the bot flat on the leverage guard; a top-up of the saved state lets it re-enter', async () => {
    const h = harness();
    await openLong(h);
    h.setMark(13.2); // below the 388 bps trail from 13.755 (13.221): stopped out at the bid, a ~0.57 USD loss
    await h.engine.tick();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['trailing_stop']);
    const equityAfter = (await h.broker.balance()).equityUsd;
    expect(13.755 / equityAfter).toBeGreaterThan(4 * DEFAULT_CONFIG.entryLeverageSlack);

    h.advance(25 * H); // past the 24h stop-out cooldown
    h.setMark(13.755);
    await h.engine.tick();
    await h.engine.onAssessment(assess(h));
    expect(await h.broker.position()).toBeNull();
    expect(lastDecisionReasons(h)).toMatch(/long: realized leverage .* exceeds governed/);

    const out = fundPaperInDb(h.db, 1, h.now());
    expect(out.cashAfter).toBeCloseTo(out.cashBefore + 1, 9);
    const b2 = new PaperBroker(h.getQuote, DEFAULT_PAPER_CONFIG, h.now);
    b2.importState(getState<PaperState>(h.db, 'paper')!);
    const e2 = h.newEngine(b2);
    await e2.start();
    h.advance(MIN);
    await e2.tick();
    await e2.onAssessment(assess(h));
    expect((await b2.position())?.side).toBe('long');
    expect(loadPosition(h.db)?.side).toBe('long');
  });
});

describe('stale VIX (W4)', () => {
  it('macro data fetched 5 days ago is not used: with no realized history the governor falls back to default and no entry is made', async () => {
    const h = harness();
    h.setMacroAge(5 * 24 * H);
    await openLong(h);
    expect(await h.broker.position()).toBeNull();
    const d = listJournal(h.db, 'decision', 1)[0].payload as { sigmaSource: string; action: { reasons: string[] } };
    expect(d.sigmaSource).toBe('default');
    expect(d.action.reasons.join(' ')).toMatch(/no volatility estimate/);
  });
  it('macro data fetched 3 days ago is still used', async () => {
    const h = harness();
    h.setMacroAge(3 * 24 * H);
    await openLong(h);
    expect((await h.broker.position())?.side).toBe('long');
  });
});

describe('holding across the weekly close (W2b)', () => {
  it('alerts and journals weekend_hold once per weekly close when strong aligned pressure keeps the position', async () => {
    const h = harness();
    await openLong(h);
    await h.engine.onAssessment(assess(h)); // a second bullish item: aligned pressure ~3.6% >= 1.5 x 1.5%
    expect(h.engine.status().pressure).toBeGreaterThanOrEqual(DEFAULT_CONFIG.weekendHoldMult * 0.015);
    const closeTs = h.now() + 21 * MIN;
    h.setNextClose(closeTs);
    h.advance(MIN);
    await h.engine.tick();
    expect(loadPosition(h.db)?.side).toBe('long');
    const rows = listJournal(h.db, 'weekend_hold', 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ side: 'long', nextCloseTsMs: closeTs, stopBps: 388 });
    const msgs = h.alerts.filter((a) => /across the weekly close/.test(a));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/holding long across the weekly close \(aligned pressure 3\.\d\d% >= 2\.25%\); the exchange-side trailing stop \(388 bps\) remains in force/);
    h.advance(MIN);
    await h.engine.tick();
    h.advance(MIN);
    await h.engine.tick();
    expect(listJournal(h.db, 'weekend_hold', 5)).toHaveLength(1);
    expect(h.alerts.filter((a) => /across the weekly close/.test(a))).toHaveLength(1);
    // The next weekly close is a new one: it alerts again.
    h.setNextClose(closeTs + 7 * 24 * H);
    h.advance(7 * 24 * H - 2 * MIN);
    await h.engine.onAssessment(assess(h));
    await h.engine.onAssessment(assess(h));
    await h.engine.tick(); // fresh snapshot carrying the new close time
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(listJournal(h.db, 'weekend_hold', 5)).toHaveLength(2);
  });

  it('no weekend_hold for a hold that is not the strong-pressure decision (market closed inside the window, weak pressure)', async () => {
    const h = harness();
    await openLong(h); // one item: ~1.8% < 2.25%
    h.setNextClose(h.now() + 20 * MIN);
    h.setMarketOpen(false);
    h.advance(MIN);
    await h.engine.tick();
    expect(loadPosition(h.db)?.side).toBe('long'); // the policy held: nothing can trade while the market is closed
    expect(listJournal(h.db, 'weekend_hold', 5)).toHaveLength(0);
    expect(h.alerts.join('\n')).not.toMatch(/across the weekly close/);
  });

  it('no weekend_hold when weak pressure flattens the position before the close', async () => {
    const h = harness();
    await openLong(h); // one item: ~1.8% < 2.25%
    h.setNextClose(h.now() + 20 * MIN);
    h.advance(MIN);
    await h.engine.tick();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['weekend']);
    expect(listJournal(h.db, 'weekend_hold', 5)).toHaveLength(0);
    expect(h.alerts.join('\n')).not.toMatch(/across the weekly close/);
  });
});

describe('contextText / status', () => {
  it('is null before the first snapshot and describes the position afterwards', async () => {
    const h = harness();
    expect(h.engine.contextText()).toBeNull();
    await openLong(h);
    expect(h.engine.contextText()).toContain('position: long');
    expect(h.engine.status().position?.side).toBe('long');
    expect(h.engine.status().mark).toBe(13.755);
  });
});

describe('positionMayBeOpen on a failed open (R18)', () => {
  const longPos: BrokerPosition = {
    side: 'long', contracts: 1, entryPrice: 13.76, markPrice: 13.755, liqDistance: 0.2, feesUsd: 0.001, liqPrice: 10.8,
    unrealizedPnlUsd: 0,
  };

  /** Hand-written broker whose open() always rejects with `openError` while position() reports a held long. */
  function stubHarness(openError: Error) {
    const now = NOW0;
    const db = openPerpDb(':memory:');
    const alerts: string[] = [];
    let held = false;
    const setTrailingStop = vi.fn(async (_bps: number) => undefined);
    const stub: Broker = {
      mode: 'paper',
      quote: async () => ({ bid: 13.75, ask: 13.76, mark: 13.755, tsMs: now }),
      position: async () => (held ? longPos : null),
      balance: async () => ({ equityUsd: 3.5, availableUsd: 3.5 }),
      open: async () => {
        held = true; // the exchange did fill; the bot just could not confirm it
        throw openError;
      },
      close: async () => {
        throw new Error('close not expected');
      },
      setTrailingStop,
      poll: async () => [],
      watch: () => undefined,
    };
    const collect = async (): Promise<Collected> => ({
      perp: { bid: 13.75, ask: 13.76, mark: 13.755, marketOpen: true, nextCloseTsMs: NOW0 + 3 * 24 * H, fundingEstimate: 0.0001 },
      perpFetchedAtMs: now,
      macro: { vix: { value: 16, change1d: 0, asOf: '2026-10-13' } },
      macroFetchedAtMs: now,
      events: [],
      kalshiEvents: [],
    });
    const engine = new PerpEngine({ cfg: DEFAULT_CONFIG, db, broker: stub, now: () => now, collect, alert: (m) => alerts.push(m) });
    const item: ImpactAssessment = {
      itemId: `r18-${++seq}`, receivedAtMs: now, publishedAtMs: now - 30_000, direction: 'up', bucket: 'major',
      horizon: 'days', credibility: 0.8, novelty: 'new', alreadyPriced: 'no', confidence: 0.75, rationale: 'test',
    };
    return { db, alerts, engine, setTrailingStop, item };
  }

  it('adopts the possibly-open position, protects it with a stop and alerts URGENT when the error carries positionMayBeOpen: true', async () => {
    const s = stubHarness(Object.assign(new Error('flatten failed'), { positionMayBeOpen: true }));
    await s.engine.tick();
    await s.engine.onAssessment(s.item);
    expect(loadPosition(s.db)?.side).toBe('long');
    expect(s.setTrailingStop).toHaveBeenCalledTimes(1);
    expect(s.setTrailingStop).toHaveBeenCalledWith(388); // governor-sized: realized leverage 13.755 / 3.5
    expect(s.alerts.join('\n')).toMatch(/URGENT/);
    expect(s.alerts.some((a) => a.startsWith('[PERP paper] URGENT:'))).toBe(true);
    expect(listJournal(s.db, 'open_failed', 5)).toHaveLength(1);
    expect(listJournal(s.db, 'open_failed_unprotected', 5)).toHaveLength(1);
    expect(listJournal(s.db, 'reconcile', 5).map((r) => (r.payload as { result: string }).result)).toEqual(['orphan_adopted']);
  });

  it.each([
    ['positionMayBeOpen: false', Object.assign(new Error('rejected'), { positionMayBeOpen: false })],
    ['no flag', new Error('rejected')],
  ])('does not adopt, set a stop or alert URGENT when the error has %s', async (_label, err) => {
    const s = stubHarness(err);
    await s.engine.tick();
    await s.engine.onAssessment(s.item);
    expect(loadPosition(s.db)).toBeNull();
    expect(s.setTrailingStop).not.toHaveBeenCalled();
    expect(s.alerts.join('\n')).not.toMatch(/URGENT/);
    expect(listJournal(s.db, 'open_failed', 5)).toHaveLength(1);
    expect(listJournal(s.db, 'open_failed_unprotected', 5)).toHaveLength(0);
  });
});

describe('vanished position not yet classified by the broker (R19)', () => {
  it('does not decide or close while broker.position() is null and poll() reports nothing; journals the wait once per 10 minutes', async () => {
    const h = harness();
    await openLong(h);
    expect(loadPosition(h.db)?.side).toBe('long');
    vi.spyOn(h.broker, 'position').mockResolvedValue(null);
    vi.spyOn(h.broker, 'poll').mockResolvedValue([]);
    const close = vi.spyOn(h.broker, 'close');
    await h.engine.onAssessment(assess(h, { direction: 'down', bucket: 'shock', credibility: 1, confidence: 0.9 }));
    expect(close).not.toHaveBeenCalled();
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(listJournal(h.db, 'awaiting_exit_classification', 10)).toHaveLength(1);
    expect(listJournal(h.db, 'close', 5)).toHaveLength(0);
    h.advance(MIN);
    await h.engine.tick(); // second evaluation inside the 10 minute window
    expect(close).not.toHaveBeenCalled();
    expect(listJournal(h.db, 'awaiting_exit_classification', 10)).toHaveLength(1);
    h.advance(8 * MIN);
    await h.engine.tick(); // 9 minutes after the first sighting: still waiting, still one row (R21 ends the wait at 10)
    expect(close).not.toHaveBeenCalled();
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(listJournal(h.db, 'awaiting_exit_classification', 10)).toHaveLength(1);
  });
});

const shock = (h: H) => assess(h, { direction: 'down', bucket: 'shock', credibility: 1, confidence: 0.9 });

describe('tracked position the broker cannot see and never classifies (R21)', () => {
  async function vanishedHarness() {
    const h = harness();
    await openLong(h);
    vi.spyOn(h.broker, 'position').mockResolvedValue(null);
    vi.spyOn(h.broker, 'poll').mockResolvedValue([]);
    return h;
  }

  it('waits 10 minutes, then records exactly one conservative stop-out, clears the position and alerts', async () => {
    const h = await vanishedHarness();
    await h.engine.tick(); // first sighting
    expect(listJournal(h.db, 'awaiting_exit_classification', 10)).toHaveLength(1);
    expect(listExits(h.db, 0)).toHaveLength(0);
    h.advance(9 * MIN);
    await h.engine.tick();
    expect(listExits(h.db, 0)).toHaveLength(0);
    expect(loadPosition(h.db)?.side).toBe('long');
    h.advance(MIN); // 10 minutes since the first sighting
    await h.engine.tick();
    expect(listExits(h.db, 0).map((e) => [e.rule, e.side])).toEqual([['trailing_stop', 'long']]);
    expect(loadPosition(h.db)).toBeNull();
    expect(h.engine.status().position).toBeNull();
    expect(h.alerts.join('\n')).toMatch(/closed outside the bot/);
    expect(listJournal(h.db, 'broker_event', 5)).toHaveLength(1);
    h.advance(MIN);
    await h.engine.tick();
    expect(listExits(h.db, 0)).toHaveLength(1);
  });

  it('ignores a late broker event after the synthetic close: no second exit, journaled as broker_event_ignored', async () => {
    const h = await vanishedHarness();
    await h.engine.tick();
    h.advance(10 * MIN);
    await h.engine.tick();
    expect(listExits(h.db, 0)).toHaveLength(1);
    const late: BrokerEvent = {
      kind: 'stopped_out', rule: 'trailing_stop', side: 'long', pnlUsd: -0.1,
      fill: { side: 'long', contracts: 1, price: 13.2, feeUsd: 0.001, tsMs: h.now() },
    };
    vi.spyOn(h.broker, 'poll').mockResolvedValueOnce([late]);
    h.advance(MIN);
    await h.engine.tick();
    expect(listExits(h.db, 0)).toHaveLength(1);
    expect(listJournal(h.db, 'broker_event_ignored', 5)).toHaveLength(1);
    expect(h.alerts.join('\n')).toMatch(/ignored a broker stopped_out event/);
  });

  it('resets the waiting timer when the broker position reappears', async () => {
    const h = await vanishedHarness();
    await h.engine.tick(); // awaiting since T
    h.advance(6 * MIN);
    vi.mocked(h.broker.position).mockRestore(); // the broker sees the position again
    await h.engine.tick();
    vi.spyOn(h.broker, 'position').mockResolvedValue(null);
    await h.engine.tick(); // a fresh wait starts here
    h.advance(6 * MIN); // 12 minutes after the first sighting but only 6 after the second
    await h.engine.tick();
    expect(listExits(h.db, 0)).toHaveLength(0);
    expect(loadPosition(h.db)?.side).toBe('long');
    h.advance(4 * MIN);
    await h.engine.tick();
    expect(listExits(h.db, 0)).toHaveLength(1);
  });
});

describe('bookkeeping failures after a successful broker call (R23)', () => {
  it('close succeeds, then balance() throws: no close_failed row or alert, exit recorded, failure shown as assess_error', async () => {
    const h = harness();
    await openLong(h);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // assess_error is logged
    const realClose = h.broker.close.bind(h.broker);
    vi.spyOn(h.broker, 'close').mockImplementation(async () => {
      const res = await realClose();
      vi.spyOn(h.broker, 'balance').mockRejectedValue(new Error('balance down'));
      return res;
    });
    await h.engine.onAssessment(shock(h));
    expect(listJournal(h.db, 'close_failed', 5)).toHaveLength(0);
    expect(h.alerts.join('\n')).not.toMatch(/close failed/);
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(['shock']);
    expect(loadPosition(h.db)).toBeNull();
    expect(listJournal(h.db, 'close', 5)).toHaveLength(1);
    expect(listJournal(h.db, 'assess_error', 5)).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('open succeeds, then persistBroker throws: no open_failed row or alert, the position stays tracked, failure shown as assess_error', async () => {
    const h = harness();
    let armed = false;
    const e2 = h.newEngine(h.broker, () => {
      if (armed) throw new Error('disk full');
    });
    await e2.tick();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // assess_error is logged
    armed = true;
    await e2.onAssessment(assess(h));
    expect(listJournal(h.db, 'open_failed', 5)).toHaveLength(0);
    expect(h.alerts.join('\n')).not.toMatch(/open failed/);
    expect((await h.broker.position())?.side).toBe('long');
    expect(loadPosition(h.db)?.side).toBe('long');
    expect(listJournal(h.db, 'assess_error', 5)).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe('stub-broker reconciliation (R22, R24)', () => {
  const longBp: BrokerPosition = {
    side: 'long', contracts: 1, entryPrice: 13.76, markPrice: 13.755, liqDistance: 0.2, feesUsd: 0.001, liqPrice: 10.8,
    unrealizedPnlUsd: 0,
  };
  const storedShort: PositionState = {
    side: 'short', contracts: 1, entryPrice: 13.7, entryTimeMs: NOW0 - H, extreme: 13.7, leverage: 3.9, stopBps: 388,
    tightenedUntilMs: null,
  };

  function setup(positionFn: (call: number) => BrokerPosition | null, stored: PositionState | null = null) {
    let now = NOW0;
    const db = openPerpDb(':memory:');
    const alerts: string[] = [];
    let opens = 0;
    const position = vi.fn(async () => positionFn(position.mock.calls.length));
    const setTrailingStop = vi.fn(async (_bps: number) => undefined);
    const watch = vi.fn((_side: 'long' | 'short', _sinceMs: number) => undefined);
    const stub: Broker = {
      mode: 'paper',
      quote: async () => ({ bid: 13.75, ask: 13.76, mark: 13.755, tsMs: now }),
      position,
      balance: async () => ({ equityUsd: 3.5, availableUsd: 3.5 }),
      open: async () => {
        opens += 1;
        throw opens === 1 ? Object.assign(new Error('unresolved'), { positionMayBeOpen: true }) : new Error('rejected');
      },
      close: async () => {
        throw new Error('close not expected');
      },
      setTrailingStop,
      poll: async () => [],
      watch,
    };
    const collect = async (): Promise<Collected> => ({
      perp: { bid: 13.75, ask: 13.76, mark: 13.755, marketOpen: true, nextCloseTsMs: NOW0 + 3 * 24 * H, fundingEstimate: 0.0001 },
      perpFetchedAtMs: now,
      macro: { vix: { value: 16, change1d: 0, asOf: '2026-10-13' } },
      macroFetchedAtMs: now,
      events: [],
      kalshiEvents: [],
    });
    if (stored !== null) savePosition(db, stored);
    const engine = new PerpEngine({ cfg: DEFAULT_CONFIG, db, broker: stub, now: () => now, collect, alert: (m) => alerts.push(m) });
    const item = (): ImpactAssessment => ({
      itemId: `r22-${++seq}`, receivedAtMs: now, publishedAtMs: now - 30_000, direction: 'up', bucket: 'major',
      horizon: 'days', credibility: 0.8, novelty: 'new', alreadyPriced: 'no', confidence: 0.75, rationale: 'test',
    });
    return { db, alerts, engine, position, setTrailingStop, watch, item, now: () => now, advance: (ms: number) => { now += ms; } };
  }

  it.each([
    ['reads flat', (): BrokerPosition | null => null],
    ['read fails', (): BrokerPosition | null => { throw new Error('read failed'); }],
  ])('R22: when the immediate reconcile after a flagged open fails or reads flat (%s), the next tick adopts the position and sets the stop', async (_label, firstRead) => {
    const s = setup((call) => (call === 1 ? firstRead() : longBp));
    await s.engine.tick();
    await s.engine.onAssessment(s.item()); // open throws positionMayBeOpen; the immediate reconcile finds nothing usable
    expect(loadPosition(s.db)).toBeNull();
    expect(s.setTrailingStop).not.toHaveBeenCalled();
    expect(s.alerts.join('\n')).not.toMatch(/startup/);
    s.advance(MIN);
    await s.engine.tick();
    expect(loadPosition(s.db)?.side).toBe('long');
    expect(s.setTrailingStop).toHaveBeenCalledTimes(1);
    expect(s.setTrailingStop).toHaveBeenCalledWith(388);
    expect(s.watch.mock.calls).toEqual([['long', s.now()]]); // W5: the adopted position is watched
  });

  it('R22: gives up after exactly 30 retries with exactly one alert and makes no further reconcile calls', async () => {
    const s = setup(() => {
      throw new Error('read failed');
    });
    await s.engine.tick();
    await s.engine.onAssessment(s.item());
    expect(s.position).toHaveBeenCalledTimes(1); // the immediate reconcile
    for (let i = 0; i < 40; i++) {
      s.advance(MIN);
      await s.engine.tick();
    }
    expect(s.position).toHaveBeenCalledTimes(31); // 1 immediate + 30 retries
    expect(s.alerts.filter((a) => /could not confirm the exchange position/.test(a))).toHaveLength(1);
    expect(s.alerts.join('\n')).not.toMatch(/startup/);
  });

  it('W5: a consistent restart reconcile watches the stored position from its entry time', async () => {
    const storedLong: PositionState = { ...storedShort, side: 'long' };
    const s = setup(() => longBp, storedLong);
    await s.engine.start();
    expect(loadPosition(s.db)?.side).toBe('long');
    expect(s.setTrailingStop).not.toHaveBeenCalled();
    expect(s.watch.mock.calls).toEqual([['long', storedLong.entryTimeMs]]);
    expect(listJournal(s.db, 'reconcile', 5).map((r) => (r.payload as { result: string }).result)).toEqual(['consistent']);
  });

  it('W5: a startup reconcile that finds the broker flat with nothing stored watches nothing', async () => {
    const s = setup(() => null);
    await s.engine.start();
    expect(s.watch).not.toHaveBeenCalled();
  });

  it('R24: a stored short against a broker long adopts the broker long, halts, sets a stop and alerts the mismatch', async () => {
    const s = setup(() => longBp, storedShort);
    await s.engine.start();
    expect(loadPosition(s.db)?.side).toBe('long');
    expect(s.engine.status().position?.side).toBe('long');
    expect(loadRiskState(s.db).halted).toBe(true);
    expect(s.setTrailingStop).toHaveBeenCalledWith(388);
    expect(s.watch.mock.calls).toEqual([['long', NOW0]]); // W5: the adopted broker side is watched
    expect(s.alerts.join('\n')).toMatch(/side mismatch/);
    expect(listJournal(s.db, 'reconcile', 5).map((r) => (r.payload as { result: string }).result)).toEqual([
      'side_mismatch_adopted', 'side_mismatch',
    ]);
  });
});
