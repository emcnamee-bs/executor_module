import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  appendJournal, equityPeak, getState, listAssessments, listExits, listJournal, loadPosition, loadRiskState,
  markSeries, openPerpDb, recordAssessment, recordEquity, recordExit, saveRiskState, savePosition, saveSnapshot,
  setState, snapshotNear,
} from '../../src/perp/store/db.js';
import { haltRisk, initialRiskState } from '../../src/perp/risk/state.js';
import type { ImpactAssessment, PositionState, Snapshot } from '../../src/perp/types.js';

let db: Database.Database;
beforeEach(() => {
  db = openPerpDb(':memory:');
});

const T = Date.UTC(2026, 9, 14, 15, 0, 0);
const snap = (tsMs: number, mark: number): Snapshot => ({
  tsMs,
  perp: { bid: mark - 0.005, ask: mark + 0.005, mark, marketOpen: true, nextCloseTsMs: null, fundingEstimate: 0 },
  returns: { d1: null, d5: null },
  realizedWeeklySigma: null,
  macro: {},
  events: [],
  kalshiEvents: [],
  freshness: { perpAgeMs: 0, macroAgeMs: null },
});
const assess = (id: string, receivedAtMs: number): ImpactAssessment => ({
  itemId: id, receivedAtMs, publishedAtMs: receivedAtMs - 1000, direction: 'up', bucket: 'minor', horizon: 'days',
  credibility: 0.5, novelty: 'new', alreadyPriced: 'no', confidence: 0.5, rationale: 'r',
});

describe('journal and state', () => {
  it('appends and lists the journal newest first, by kind', () => {
    appendJournal(db, { tsMs: T, kind: 'decision', payload: { a: 1 } });
    appendJournal(db, { tsMs: T + 1, kind: 'decision', payload: { a: 2 } });
    appendJournal(db, { tsMs: T + 2, kind: 'other', payload: {} });
    expect(listJournal(db, 'decision', 10).map((r) => r.payload)).toEqual([{ a: 2 }, { a: 1 }]);
    expect(listJournal(db, 'decision', 1)).toHaveLength(1);
  });
  it('round-trips state values and returns null for a missing key', () => {
    expect(getState(db, 'x')).toBeNull();
    setState(db, 'x', { n: 5 });
    setState(db, 'x', { n: 6 });
    expect(getState(db, 'x')).toEqual({ n: 6 });
  });
});

describe('risk state and position', () => {
  it('defaults to the initial risk state and round-trips a saved one', () => {
    expect(loadRiskState(db)).toEqual(initialRiskState());
    const r = haltRisk(initialRiskState(), 'why');
    saveRiskState(db, r);
    expect(loadRiskState(db)).toEqual(r);
  });
  it('saves, loads and clears the position', () => {
    expect(loadPosition(db)).toBeNull();
    const p: PositionState = { side: 'short', contracts: 1, entryPrice: 13.7, entryTimeMs: T, extreme: 13.6, leverage: 4, stopBps: 388, tightenedUntilMs: null };
    savePosition(db, p);
    expect(loadPosition(db)).toEqual(p);
    savePosition(db, null);
    expect(loadPosition(db)).toBeNull();
  });
});

describe('exits, assessments, snapshots, equity', () => {
  it('lists exits since a time', () => {
    recordExit(db, { atMs: T - 1000, rule: 'shock', side: 'long', pnlUsd: -0.2 });
    recordExit(db, { atMs: T + 1000, rule: 'trailing_stop', side: 'short', pnlUsd: -0.4 });
    expect(listExits(db, T)).toEqual([{ atMs: T + 1000, rule: 'trailing_stop', side: 'short', pnlUsd: -0.4 }]);
  });
  it('rejects a duplicate assessment id and lists by receive time', () => {
    expect(recordAssessment(db, assess('a', T))).toBe(true);
    expect(recordAssessment(db, assess('a', T + 5))).toBe(false);
    recordAssessment(db, assess('b', T - 5000));
    expect(listAssessments(db, T - 10_000).map((a) => a.itemId)).toEqual(['b', 'a']);
    expect(listAssessments(db, T).map((a) => a.itemId)).toEqual(['a']);
  });
  it('finds the snapshot nearest a time within a gap, and lists marks', () => {
    saveSnapshot(db, snap(T, 13.7));
    saveSnapshot(db, snap(T + 60_000, 13.8));
    expect(snapshotNear(db, T + 50_000, 30_000)?.perp.mark).toBe(13.8);
    expect(snapshotNear(db, T + 500_000, 30_000)).toBeNull();
    expect(markSeries(db, T)).toEqual([{ tsMs: T, mark: 13.7 }, { tsMs: T + 60_000, mark: 13.8 }]);
  });
  it('tracks the equity peak', () => {
    expect(equityPeak(db)).toBe(0);
    recordEquity(db, T, 5);
    recordEquity(db, T + 1, 6.5);
    recordEquity(db, T + 2, 4);
    expect(equityPeak(db)).toBe(6.5);
  });
});
