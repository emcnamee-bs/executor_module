// test/decide/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openLedger,
  recordDecision,
  hasDecisionForItem,
  hasOpenPosition,
  totalExposureCents,
  type DecisionRecord,
} from '../../src/decide/ledger.js';
import type Database from 'better-sqlite3';

const EVENT = 'KXAPRPOTUS-26AUG28';

/**
 * item_id carries a UNIQUE index now (the at-least-once-delivery backstop), so
 * fixtures must not collide unless a test is deliberately testing that.
 */
let itemSeq = 0;
function nextItemId(): string {
  return `item-${++itemSeq}`;
}

function skipRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: nextItemId(),
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
    itemId: nextItemId(),
    storyKey: 'story-1',
    eventTicker: EVENT,
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

/**
 * A would-trade record with exactly the notional asked for, kept internally
 * consistent (1c per contract, so contracts x price == notional for any value) so
 * that it reaches the DB-layer cap checks instead of tripping recordDecision's
 * construction-time notional check first.
 */
function tradeRecordOfNotional(
  notionalCents: number,
  overrides: Partial<DecisionRecord> = {}
): DecisionRecord {
  return tradeRecord({ contracts: notionalCents, entryPriceCents: 1, notionalCents, ...overrides });
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
    // 1001 contracts at 1c: internally consistent, so the construction-time notional
    // check passes it through and the DB CHECK is what rejects it.
    expect(() => recordDecision(db, tradeRecordOfNotional(1001))).toThrow(
      /per-trade|constraint|CHECK/i
    );
  });

  it('allows a skip decision with notionalCents 0 regardless of other fields', () => {
    expect(() => recordDecision(db, skipRecord({ notionalCents: 0 }))).not.toThrow();
  });

  it('exempts a skip decision from the per-trade notional CHECK constraint even when notionalCents is far above the cap', () => {
    expect(() => recordDecision(db, skipRecord({ notionalCents: 5000 }))).not.toThrow();
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
    recordDecision(db, tradeRecordOfNotional(500, { storyKey: 's-a' }));
    recordDecision(db, tradeRecordOfNotional(300, { storyKey: 's-b' }));
    recordDecision(db, skipRecord({ storyKey: 's-c', eventTicker: EVENT }));
    expect(totalExposureCents(db, EVENT)).toBe(800);
  });

  it('rejects a would-trade insert that would push total exposure over the $40 cap', () => {
    recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-x' }));
    recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-y' }));
    recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-z' }));
    recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-w' }));
    // total is now exactly 4000 (the cap) -- one more cent of would-trade notional must reject
    expect(() => recordDecision(db, tradeRecordOfNotional(1, { storyKey: 's-over' }))).toThrow(
      /total exposure cap exceeded/
    );
  });

  // --- I5: exposure is scoped to one event, not summed for all time -------------

  it('scopes the exposure sum to the given event_ticker', () => {
    recordDecision(db, tradeRecordOfNotional(700, { eventTicker: 'KXAPRPOTUS-26AUG21' }));
    recordDecision(db, tradeRecordOfNotional(200, { eventTicker: EVENT }));
    expect(totalExposureCents(db, 'KXAPRPOTUS-26AUG21')).toBe(700);
    expect(totalExposureCents(db, EVENT)).toBe(200);
    expect(totalExposureCents(db, 'KXAPRPOTUS-26SEP04')).toBe(0);
  });

  it('lets two different events each hold $35 of exposure without sharing one global pool', () => {
    // The bug this closes: with an all-time sum, a resolved week's positions kept
    // consuming the next week's cap, so the engine went permanently silent after
    // roughly 20 lifetime trades. $35 on event A plus $35 on event B is $70 all-time
    // and must still be allowed -- they are separate markets with separate caps.
    for (let i = 0; i < 4; i++) {
      recordDecision(db, tradeRecordOfNotional(875, { eventTicker: 'EVENT-A' }));
    }
    for (let i = 0; i < 4; i++) {
      recordDecision(db, tradeRecordOfNotional(875, { eventTicker: 'EVENT-B' }));
    }
    expect(totalExposureCents(db, 'EVENT-A')).toBe(3500);
    expect(totalExposureCents(db, 'EVENT-B')).toBe(3500);
  });

  it('still enforces the shared $40 ceiling between rows on the SAME event_ticker', () => {
    for (let i = 0; i < 4; i++) {
      recordDecision(db, tradeRecordOfNotional(1000, { eventTicker: 'EVENT-A' }));
    }
    // A different event is unaffected...
    expect(() =>
      recordDecision(db, tradeRecordOfNotional(1000, { eventTicker: 'EVENT-B' }))
    ).not.toThrow();
    // ...but EVENT-A is full.
    expect(() =>
      recordDecision(db, tradeRecordOfNotional(1, { eventTicker: 'EVENT-A' }))
    ).toThrow(/total exposure cap exceeded/);
  });

  // --- I2: notional_cents must equal contracts x entry_price_cents -------------

  it('rejects a would-trade record whose notionalCents does not equal contracts x entryPriceCents', () => {
    // The reviewer's row: a real $50 position reporting zero exposure. Nothing else
    // in the ledger ties notional_cents to the position it claims to describe, so the
    // "redundant" cap layer would otherwise trust the exact number it exists to check.
    expect(() =>
      recordDecision(
        db,
        tradeRecord({ contracts: 100, entryPriceCents: 50, notionalCents: 0 })
      )
    ).toThrow(/notionalCents must equal contracts x entryPriceCents/);
  });

  it('rejects a would-trade record with a null entryPriceCents', () => {
    expect(() =>
      recordDecision(db, tradeRecord({ contracts: 10, entryPriceCents: null, notionalCents: 0 }))
    ).toThrow(/must carry an entry price/);
  });

  it('accepts a would-trade record whose notional is exactly contracts x entryPriceCents', () => {
    expect(() =>
      recordDecision(db, tradeRecord({ contracts: 20, entryPriceCents: 45, notionalCents: 900 }))
    ).not.toThrow();
  });

  it('leaves skip rows exempt: notional consistency is only asserted for would-trade rows', () => {
    expect(() =>
      recordDecision(db, skipRecord({ contracts: 0, entryPriceCents: null, notionalCents: 0 }))
    ).not.toThrow();
  });

  it('enforces notional consistency at the DB layer too, for an INSERT that bypasses recordDecision', () => {
    // Defense in depth: the TS check catches this before any I/O, but a future code
    // path preparing its own INSERT must not be able to write an inconsistent row.
    const insert = db.prepare(
      `INSERT INTO decisions
        (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
         magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
         would_trade, reason)
       VALUES ('bypass-1', NULL, '${EVENT}', 'M', 'yes', 'reported', 'up',
         0.3, 100, 50, 0, 3, 1, 'raw insert')`
    );
    expect(() => insert.run()).toThrow(/constraint/i);
  });

  it('rejects a would-trade record with a null eventTicker, which would otherwise bypass the per-event exposure trigger', () => {
    // SQL three-valued logic: `event_ticker = NEW.event_ticker` is never true when
    // NEW.event_ticker is NULL, so the enforce_total_exposure trigger's sum matches
    // nothing and the cap never binds. Found by the final-review re-reviewer:
    // five such rows inserted $50 of exposure with the cap never firing once.
    expect(() =>
      recordDecision(db, tradeRecordOfNotional(500, { eventTicker: null }))
    ).toThrow(/constraint/i);
  });

  // --- I4: one decision row per item_id ---------------------------------------

  it('reports no decision for an item never recorded', () => {
    expect(hasDecisionForItem(db, 'item-never-seen')).toBe(false);
  });

  it('reports a decision for an item after any row (skip or would-trade) is written', () => {
    recordDecision(db, skipRecord({ itemId: 'item-seen-skip' }));
    recordDecision(db, tradeRecord({ itemId: 'item-seen-trade' }));
    expect(hasDecisionForItem(db, 'item-seen-skip')).toBe(true);
    expect(hasDecisionForItem(db, 'item-seen-trade')).toBe(true);
  });

  it('makes a second row for the same item_id impossible at the DB layer', () => {
    recordDecision(db, skipRecord({ itemId: 'item-dup' }));
    expect(() => recordDecision(db, skipRecord({ itemId: 'item-dup' }))).toThrow(/UNIQUE/i);
  });
});
