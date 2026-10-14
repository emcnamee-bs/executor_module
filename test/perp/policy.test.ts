import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { computeGovernors } from '../../src/perp/risk/governor.js';
import { initialRiskState } from '../../src/perp/risk/state.js';
import { decide, entryThreshold, type NewItem, type PolicyInput } from '../../src/perp/policy/policy.js';
import type { PositionState, ScheduledEvent, Snapshot } from '../../src/perp/types.js';

const cfg = DEFAULT_CONFIG;
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;

function snap(over: Partial<Snapshot['perp']> = {}, events: ScheduledEvent[] = []): Snapshot {
  return {
    tsMs: NOW,
    perp: { bid: 13.75, ask: 13.76, mark: 13.755, marketOpen: true, nextCloseTsMs: NOW + 3 * 24 * H, fundingEstimate: 0, ...over },
    returns: { d1: 0, d5: 0 },
    realizedWeeklySigma: null,
    macro: {},
    events,
    kalshiEvents: [],
    freshness: { perpAgeMs: 1000, macroAgeMs: 1000 },
  };
}

function item(over: Partial<NewItem> = {}): NewItem {
  return {
    itemId: 'i1',
    receivedAtMs: NOW,
    publishedAtMs: NOW - MIN,
    direction: 'up',
    bucket: 'moderate',
    horizon: 'days',
    credibility: 0.8,
    novelty: 'new',
    alreadyPriced: 'no',
    confidence: 0.75,
    rationale: 'because',
    movedSincePublish: 0.001,
    ...over,
  };
}

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    nowMs: NOW,
    cfg,
    snapshot: snap(),
    position: null,
    pressureNow: 0.02,
    pressure12hAgo: 0,
    newItems: [item()],
    governors: computeGovernors(cfg, 16, null),
    realizedLeverage: 4,
    liqDistance: null,
    weeklyExtreme: null,
    risk: initialRiskState(),
    prevBreachStreak: 0,
    ...over,
  };
}

const longPos = (over: Partial<PositionState> = {}): PositionState => ({
  side: 'long', contracts: 1, entryPrice: 13.76, entryTimeMs: NOW - 24 * H, extreme: 13.9, leverage: 4, stopBps: 388, tightenedUntilMs: null, ...over,
});
const shortPos = (over: Partial<PositionState> = {}): PositionState => ({
  side: 'short', contracts: 1, entryPrice: 13.76, entryTimeMs: NOW - 24 * H, extreme: 13.5, leverage: 4, stopBps: 388, tightenedUntilMs: null, ...over,
});

describe('entryThreshold', () => {
  it('is 1.5% for longs and 1.25x that for shorts', () => {
    expect(entryThreshold('long', cfg)).toBe(0.015);
    expect(entryThreshold('short', cfg)).toBeCloseTo(0.01875, 10);
  });
});

describe('flat: entries', () => {
  it('opens a long on bullish pressure + a new, confident, not-late item', () => {
    const { action } = decide(input());
    expect(action.kind).toBe('open');
    if (action.kind !== 'open') return;
    expect(action.side).toBe('long');
    expect(action.leverage).toBe(4);
    expect(action.stopFrac).toBeCloseTo(0.038829, 5);
    expect(action.triggerItemId).toBe('i1');
  });
  it('holds when pressure is below the long threshold', () => {
    expect(decide(input({ pressureNow: 0.01 })).action.kind).toBe('hold');
  });
  it('holds when the trigger item is known (not new) or low confidence', () => {
    expect(decide(input({ newItems: [item({ novelty: 'known' })] })).action.kind).toBe('hold');
    expect(decide(input({ newItems: [item({ confidence: 0.5 })] })).action.kind).toBe('hold');
  });
  it('holds when the market already moved >40% of the expected move (late)', () => {
    // moderate = 1.5% expected; 40% = 0.6%
    expect(decide(input({ newItems: [item({ movedSincePublish: 0.007 })] })).action.kind).toBe('hold');
    expect(decide(input({ newItems: [item({ movedSincePublish: 0.005 })] })).action.kind).toBe('open');
  });
  it('never enters when the move since publish is unknown (review focus 4)', () => {
    const out = decide(input({ newItems: [item({ movedSincePublish: null })] }));
    expect(out.action.kind).toBe('hold');
  });
  it('shorts need a 25% higher bar and higher confidence', () => {
    const bear = item({ direction: 'down', confidence: 0.75 });
    expect(decide(input({ pressureNow: -0.016, newItems: [bear] })).action.kind).toBe('hold'); // < 1.875%
    const ok = decide(input({ pressureNow: -0.02, newItems: [bear] }));
    expect(ok.action.kind).toBe('open');
    if (ok.action.kind === 'open') expect(ok.action.side).toBe('short');
    expect(decide(input({ pressureNow: -0.02, newItems: [item({ direction: 'down', confidence: 0.65 })] })).action.kind).toBe('hold');
  });
  it('respects allowShort=false', () => {
    const noShort = { ...cfg, allowShort: false };
    expect(decide(input({ cfg: noShort, pressureNow: -0.03, newItems: [item({ direction: 'down' })] })).action.kind).toBe('hold');
  });
  it('holds while halted, stale, market closed, inside the weekly-close window, or in an event window', () => {
    expect(decide(input({ risk: { ...initialRiskState(), halted: true, haltReason: 'x' } })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: { ...snap(), tsMs: NOW - 10 * MIN } })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: snap({ marketOpen: false }) })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: snap({ nextCloseTsMs: NOW + 20 * MIN }) })).action.kind).toBe('hold');
    expect(decide(input({ snapshot: snap({}, [{ tsMs: NOW + 3 * MIN, name: 'CPI', impact: 'high' }]) })).action.kind).toBe('hold');
  });
  it('holds during the per-side cooldown but allows the opposite side after a news exit', () => {
    const cooling = { ...initialRiskState(), cooldownUntilMs: { long: NOW + H, short: 0 } };
    expect(decide(input({ risk: cooling })).action.kind).toBe('hold');
    const bear = item({ direction: 'down', confidence: 0.8 });
    expect(decide(input({ risk: cooling, pressureNow: -0.03, newItems: [bear] })).action.kind).toBe('open');
  });
  it('applies the raised re-entry threshold', () => {
    const raised = { ...initialRiskState(), thresholdMult: { long: 1.2, short: 1 } };
    expect(decide(input({ risk: raised, pressureNow: 0.017 })).action.kind).toBe('hold'); // needs 1.8%
    expect(decide(input({ risk: raised, pressureNow: 0.019 })).action.kind).toBe('open');
  });
  it('refuses entries with no volatility estimate (review focus 1)', () => {
    const out = decide(input({ governors: computeGovernors(cfg, null, null) }));
    expect(out.action.kind).toBe('hold');
    expect(out.action.kind === 'hold' && out.action.reasons.join(' ')).toMatch(/volatility/);
  });
  it('refuses entries when governed leverage is below the minimum', () => {
    expect(decide(input({ governors: computeGovernors(cfg, 80, null) })).action.kind).toBe('hold');
  });
  it('refuses an entry whose realized leverage exceeds 1.05 x governed leverage (review focus 5)', () => {
    expect(decide(input({ realizedLeverage: 4.19 })).action.kind).toBe('open'); // limit is 4 x 1.05 = 4.2
    expect(decide(input({ realizedLeverage: 4.3 })).action.kind).toBe('hold');
    expect(decide(input({ realizedLeverage: null })).action.kind).toBe('hold');
  });
  it('sizes the stop from REALIZED leverage', () => {
    const out = decide(input({ realizedLeverage: 2.75 }));
    expect(out.action.kind === 'open' && out.action.leverage).toBe(2.75);
  });
});

describe('long: exits', () => {
  const noNews = { newItems: [] as NewItem[], pressureNow: 0, position: longPos() };

  it('closes via the margin guard when liquidation is closer than 2 stops', () => {
    const out = decide(input({ ...noNews, liqDistance: 0.07 })); // 2 * 0.0388 = 0.0776
    expect(out.action).toMatchObject({ kind: 'close', rule: 'margin_guard' });
    expect(decide(input({ ...noNews, liqDistance: 0.2 })).action.kind).toBe('hold');
  });
  it('closes on a credible, new, adverse shock', () => {
    const shock = item({ direction: 'down', bucket: 'shock', confidence: 0.8, credibility: 0.9 });
    expect(decide(input({ ...noNews, newItems: [shock] })).action).toMatchObject({ kind: 'close', rule: 'shock' });
  });
  it('ignores a shock that is low-confidence, known, or in the long\'s favour', () => {
    for (const s of [
      item({ direction: 'down', bucket: 'shock', confidence: 0.5, credibility: 0.9 }),
      item({ direction: 'down', bucket: 'shock', novelty: 'known', confidence: 0.9, credibility: 0.9 }),
      item({ direction: 'up', bucket: 'shock', confidence: 0.9, credibility: 0.9 }),
    ]) {
      expect(decide(input({ ...noNews, newItems: [s] })).action.kind).toBe('hold');
    }
  });
  it('closes on a slow bleed: >=3% off the weekly high, adverse pressure >= 2% and not decaying', () => {
    const base = { ...noNews, snapshot: snap({ mark: 13.4 }), weeklyExtreme: 13.9, pressureNow: -0.021, pressure12hAgo: -0.015 };
    expect(decide(input(base)).action).toMatchObject({ kind: 'close', rule: 'slow_bleed' });
  });
  it('does NOT close on price alone, nor when the adverse pressure is decaying, nor below 3%', () => {
    expect(decide(input({ ...noNews, snapshot: snap({ mark: 13.4 }), weeklyExtreme: 13.9, pressureNow: 0, pressure12hAgo: 0 })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, snapshot: snap({ mark: 13.4 }), weeklyExtreme: 13.9, pressureNow: -0.021, pressure12hAgo: -0.03 })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, snapshot: snap({ mark: 13.6 }), weeklyExtreme: 13.9, pressureNow: -0.021, pressure12hAgo: -0.015 })).action.kind).toBe('hold');
  });
  it('closes when adverse pressure breaches the exit threshold on two consecutive evaluations', () => {
    const first = decide(input({ ...noNews, pressureNow: -0.021, prevBreachStreak: 0 }));
    expect(first.action.kind).toBe('hold');
    expect(first.breachStreak).toBe(1);
    const second = decide(input({ ...noNews, pressureNow: -0.021, prevBreachStreak: first.breachStreak }));
    expect(second.action).toMatchObject({ kind: 'close', rule: 'pressure' });
    expect(decide(input({ ...noNews, pressureNow: -0.01, prevBreachStreak: 1 })).breachStreak).toBe(0);
  });
  it('flattens before the weekly close unless aligned pressure is at least 1.5x the entry threshold', () => {
    const closing = snap({ nextCloseTsMs: NOW + 20 * MIN });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: 0.01 })).action).toMatchObject({ kind: 'close', rule: 'weekend' });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: 0.0226 })).action.kind).toBe('hold');
  });
  it('cannot close while the market is closed (holds; the exchange trigger remains)', () => {
    const out = decide(input({ ...noNews, snapshot: snap({ marketOpen: false }), pressureNow: -0.05, prevBreachStreak: 5 }));
    expect(out.action.kind).toBe('hold');
  });
  it('tightens the stop for a credible adverse "major" item and holds the tightening for 2h', () => {
    const major = item({ direction: 'down', bucket: 'major', confidence: 0.8 });
    const out = decide(input({ ...noNews, newItems: [major] }));
    expect(out.action.kind).toBe('set_stop');
    if (out.action.kind !== 'set_stop') return;
    expect(out.action.stopFrac).toBeCloseTo(0.01488, 4); // 1.5 * sigmaDay
    expect(out.action.holdMs).toBe(120 * MIN);
  });
  it('tightens ahead of a high-impact release and does not re-tighten once tight', () => {
    const events: ScheduledEvent[] = [{ tsMs: NOW + 30 * MIN, name: 'FOMC', impact: 'high' }];
    const out = decide(input({ ...noNews, snapshot: snap({}, events) }));
    expect(out.action.kind).toBe('set_stop');
    // 1.5 x sigmaDay is ~148.8 bps; a stop already at 148 bps is as tight as the target, so nothing to do.
    const tight = decide(input({ ...noNews, snapshot: snap({}, events), position: longPos({ stopBps: 148 }) }));
    expect(tight.action.kind).toBe('hold');
  });
  it('re-syncs the stop when volatility moved it by >= 50 bps, but not while a tightening is held', () => {
    const wide = decide(input({ ...noNews, position: longPos({ stopBps: 500 }) }));
    expect(wide.action.kind).toBe('set_stop');
    if (wide.action.kind === 'set_stop') expect(wide.action.stopFrac).toBeCloseTo(0.038829, 5);
    expect(decide(input({ ...noNews, position: longPos({ stopBps: 390 }) })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, position: longPos({ stopBps: 149, tightenedUntilMs: NOW + H }) })).action.kind).toBe('hold');
    expect(decide(input({ ...noNews, position: longPos({ stopBps: 149, tightenedUntilMs: NOW - H }) })).action.kind).toBe('set_stop');
  });
});

describe('short: mirrored exits', () => {
  const noNews = { newItems: [] as NewItem[], pressureNow: 0, position: shortPos() };
  it('closes a short on a bullish shock', () => {
    const shock = item({ direction: 'up', bucket: 'shock', confidence: 0.8, credibility: 0.9 });
    expect(decide(input({ ...noNews, newItems: [shock] })).action).toMatchObject({ kind: 'close', rule: 'shock' });
    const bearShock = item({ direction: 'down', bucket: 'shock', confidence: 0.8, credibility: 0.9 });
    expect(decide(input({ ...noNews, newItems: [bearShock] })).action.kind).toBe('hold');
  });
  it('closes a short on a slow bleed measured from the weekly LOW', () => {
    const out = decide(input({ ...noNews, snapshot: snap({ mark: 13.95 }), weeklyExtreme: 13.5, pressureNow: 0.021, pressure12hAgo: 0.015 }));
    expect(out.action).toMatchObject({ kind: 'close', rule: 'slow_bleed' });
  });
  it('weekend hold needs bearish (negative) pressure for a short', () => {
    const closing = snap({ nextCloseTsMs: NOW + 20 * MIN });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: 0.01 })).action).toMatchObject({ kind: 'close', rule: 'weekend' });
    expect(decide(input({ ...noNews, snapshot: closing, pressureNow: -0.03 })).action.kind).toBe('hold');
  });
});
