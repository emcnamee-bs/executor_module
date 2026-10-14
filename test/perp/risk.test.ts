import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { applyEntry, applyExit, clearHalt, haltRisk, initialRiskState } from '../../src/perp/risk/state.js';
import { evaluateKillSwitch, type ExitRecord } from '../../src/perp/risk/killSwitch.js';

const cfg = DEFAULT_CONFIG;
const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const H = 3_600_000;
const DAY = 24 * H;

describe('risk state (spec 5.5)', () => {
  it('starts open with no cooldowns and unit thresholds', () => {
    const r = initialRiskState();
    expect(r.halted).toBe(false);
    expect(r.cooldownUntilMs).toEqual({ long: 0, short: 0 });
    expect(r.thresholdMult).toEqual({ long: 1, short: 1 });
  });
  it('a news-driven exit cools down only the same side and raises its threshold', () => {
    const r = applyExit(initialRiskState(), { rule: 'shock', side: 'long', atMs: NOW }, cfg);
    expect(r.cooldownUntilMs.long).toBe(NOW + 4 * H);
    expect(r.cooldownUntilMs.short).toBe(0);
    expect(r.thresholdMult.long).toBe(1.2);
    expect(r.thresholdMult.short).toBe(1);
  });
  it('a price stop-out cools down BOTH sides for 24h', () => {
    for (const rule of ['trailing_stop', 'margin_guard', 'liquidated'] as const) {
      const r = applyExit(initialRiskState(), { rule, side: 'short', atMs: NOW }, cfg);
      expect(r.cooldownUntilMs.long).toBe(NOW + 24 * H);
      expect(r.cooldownUntilMs.short).toBe(NOW + 24 * H);
      expect(r.thresholdMult.short).toBe(1.2);
    }
  });
  it('weekend and operator exits change nothing', () => {
    for (const rule of ['weekend', 'operator'] as const) {
      expect(applyExit(initialRiskState(), { rule, side: 'long', atMs: NOW }, cfg)).toEqual(initialRiskState());
    }
  });
  it('a new entry resets that side\'s threshold multiplier', () => {
    const r = applyExit(initialRiskState(), { rule: 'slow_bleed', side: 'long', atMs: NOW }, cfg);
    expect(applyEntry(r, 'long').thresholdMult.long).toBe(1);
  });
  it('halt and clearHalt', () => {
    const h = haltRisk(initialRiskState(), 'two stop-outs');
    expect(h.halted).toBe(true);
    expect(h.haltReason).toBe('two stop-outs');
    expect(clearHalt(h).halted).toBe(false);
  });
});

const exit = (over: Partial<ExitRecord>): ExitRecord => ({ atMs: NOW - H, rule: 'shock', side: 'long', pnlUsd: -0.1, ...over });

describe('evaluateKillSwitch (spec 5.7)', () => {
  const base = { equityPeak: 10, equityNow: 10, nowMs: NOW, cfg };
  it('does not halt on a clean record', () => {
    expect(evaluateKillSwitch({ ...base, exits: [] })).toEqual({ halt: false, reason: null });
  });
  it('halts on two stop-outs in 30 days', () => {
    const exits = [exit({ rule: 'trailing_stop', atMs: NOW - 5 * DAY }), exit({ rule: 'margin_guard', atMs: NOW - 2 * DAY })];
    const r = evaluateKillSwitch({ ...base, exits });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/stop-outs/);
  });
  it('ignores stop-outs older than 30 days and non-stop-out rules', () => {
    const exits = [
      exit({ rule: 'trailing_stop', atMs: NOW - 31 * DAY }),
      exit({ rule: 'trailing_stop', atMs: NOW - 2 * DAY }),
      exit({ rule: 'shock', atMs: NOW - 3 * DAY }),
    ];
    expect(evaluateKillSwitch({ ...base, exits }).halt).toBe(false);
  });
  it('halts when equity is 30% below its peak', () => {
    expect(evaluateKillSwitch({ ...base, exits: [], equityNow: 7.5 }).halt).toBe(false);
    const r = evaluateKillSwitch({ ...base, exits: [], equityNow: 6.9 });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/drawdown/);
  });
  it('halts on three exits within 24 hours', () => {
    const exits = [exit({ atMs: NOW - H }), exit({ atMs: NOW - 5 * H }), exit({ atMs: NOW - 20 * H })];
    const r = evaluateKillSwitch({ ...base, exits });
    expect(r.halt).toBe(true);
    expect(r.reason).toMatch(/24 hours/);
  });
  it('does not divide by zero when the equity peak is 0', () => {
    expect(evaluateKillSwitch({ ...base, exits: [], equityPeak: 0, equityNow: 0 }).halt).toBe(false);
  });
});
