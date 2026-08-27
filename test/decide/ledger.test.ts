// test/decide/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openLedger,
  recordDecision,
  hasOpenPosition,
  totalExposureCents,
  type DecisionRecord,
} from '../../src/decide/ledger.js';
import type Database from 'better-sqlite3';

function skipRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: 'item-1',
    storyKey: null,
    eventTicker: null,
    marketTicker: null,
    side: null,
    rung: 'rumor',
    direction: null,
    magnitudePts: null,
    contracts: 0,
    entryPriceCents: null,
    notionalCents: 0,
    edgeCents: null,
    wouldTrade: false,
    reason: 'rumor rung, stake 0',
    ...overrides,
  };
}

function tradeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: 'item-2',
    storyKey: 'story-1',
    eventTicker: 'KXAPRPOTUS-26AUG28',
    marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
    side: 'yes',
    rung: 'reported',
    direction: 'up',
    magnitudePts: 0.3,
    contracts: 10,
    entryPriceCents: 10,
    notionalCents: 100,
    edgeCents: 3,
    wouldTrade: true,
    reason: '10 contracts, 3c edge',
    ...overrides,
  };
}

describe('ledger', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a skip decision', () => {
    expect(() => recordDecision(db, skipRecord())).not.toThrow();
  });

  it('records a would-trade decision within the per-trade cap', () => {
    expect(() => recordDecision(db, tradeRecord())).not.toThrow();
  });

  it('rejects a would-trade decision over the $10 per-trade cap at the database layer', () => {
    expect(() => recordDecision(db, tradeRecord({ notionalCents: 1001 }))).toThrow();
  });

  it('allows a skip decision with notionalCents 0 regardless of other fields', () => {
    expect(() => recordDecision(db, skipRecord({ notionalCents: 0 }))).not.toThrow();
  });

  it('reports no open position for a story never recorded', () => {
    expect(hasOpenPosition(db, 'story-unknown', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('reports an open position after a would-trade decision for that story+event', () => {
    recordDecision(db, tradeRecord({ storyKey: 'story-2', eventTicker: 'KXAPRPOTUS-26AUG28' }));
    expect(hasOpenPosition(db, 'story-2', 'KXAPRPOTUS-26AUG28')).toBe(true);
  });

  it('does not treat a skip decision as an open position', () => {
    recordDecision(db, skipRecord({ storyKey: 'story-3', eventTicker: 'KXAPRPOTUS-26AUG28' }));
    expect(hasOpenPosition(db, 'story-3', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('scopes open-position checks to the given event_ticker, not all-time', () => {
    recordDecision(
      db,
      tradeRecord({ storyKey: 'story-4', eventTicker: 'KXAPRPOTUS-26AUG21' })
    );
    expect(hasOpenPosition(db, 'story-4', 'KXAPRPOTUS-26AUG21')).toBe(true);
    expect(hasOpenPosition(db, 'story-4', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('sums total exposure across would-trade rows only', () => {
    recordDecision(db, tradeRecord({ storyKey: 's-a', notionalCents: 500 }));
    recordDecision(db, tradeRecord({ storyKey: 's-b', notionalCents: 300 }));
    recordDecision(db, skipRecord({ storyKey: 's-c' }));
    expect(totalExposureCents(db)).toBe(800);
  });

  it('rejects a would-trade insert that would push total exposure over the $40 cap', () => {
    recordDecision(db, tradeRecord({ storyKey: 's-x', notionalCents: 1000 }));
    recordDecision(db, tradeRecord({ storyKey: 's-y', notionalCents: 1000 }));
    recordDecision(db, tradeRecord({ storyKey: 's-z', notionalCents: 1000 }));
    recordDecision(db, tradeRecord({ storyKey: 's-w', notionalCents: 1000 }));
    // total is now exactly 4000 (the cap) -- one more cent of would-trade notional must reject
    expect(() =>
      recordDecision(db, tradeRecord({ storyKey: 's-over', notionalCents: 1 }))
    ).toThrow();
  });
});
