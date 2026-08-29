// test/decide/ledger.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as alertModule from '../../src/alert.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  openLedger,
  recordDecision,
  hasDecisionForItem,
  hasOpenPosition,
  totalExposureCents,
  recordPendingDecision,
  resolveDecision,
  recordPendingOrder,
  resolveOrder,
  findPendingOrders,
  markDecisionSettled,
  findOpenUnsettledDecisions,
  isMarketBlocked,
  blockMarket,
  isTradingHalted,
  tripBreaker,
  clearAllTrips,
  recordKalshiError,
  checkFailedOrdersSignal,
  checkDivergencesSignal,
  recordProcessStarting,
  recordProcessStoppedCleanly,
  CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD,
  CIRCUIT_BREAKER_DIVERGENCES_THRESHOLD,
  CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD,
  MAX_NOTIONAL_CENTS_PER_TRADE,
  MAX_TOTAL_EXPOSURE_CENTS,
  type DecisionRecord,
} from '../../src/decide/ledger.js';
import BetterSqlite3 from 'better-sqlite3';
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
    orderStatus: 'resolved',
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
    orderStatus: 'resolved',
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

  // --- pending decision + order flow (slice 4) --------------------------------

  describe('pending decision + order flow (slice 4)', () => {
    it('recordPendingDecision writes a would_trade=0, order_status=pending row and returns its id', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      expect(decisionId).toBeGreaterThan(0);

      const row = db.prepare('SELECT would_trade, order_status FROM decisions WHERE id = ?').get(decisionId) as {
        would_trade: number;
        order_status: string;
      };
      // Even though tradeRecord() defaults wouldTrade: true, a pending row is never a
      // confirmed position yet -- recordPendingDecision forces would_trade to 0
      // regardless of what the input record says, exactly like a genuine 0-fill outcome.
      expect(row.would_trade).toBe(0);
      expect(row.order_status).toBe('pending');
    });

    it('resolveDecision updates an existing pending row in place to the real outcome', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      resolveDecision(db, decisionId, tradeRecord({ contracts: 3, entryPriceCents: 12, notionalCents: 36, wouldTrade: true, orderStatus: 'resolved' }));

      const row = db.prepare('SELECT would_trade, contracts, notional_cents, order_status FROM decisions WHERE id = ?').get(decisionId) as {
        would_trade: number;
        contracts: number;
        notional_cents: number;
        order_status: string;
      };
      expect(row.would_trade).toBe(1);
      expect(row.contracts).toBe(3);
      expect(row.notional_cents).toBe(36);
      expect(row.order_status).toBe('resolved');
    });

    // --- enforce_total_exposure_on_resolve: the UPDATE-path mirror of the cap ---

    it('rejects a resolveDecision that would push total exposure over the $40 cap on the UPDATE path, not just INSERT', () => {
      // A real trade's only INSERT is recordPendingDecision, which always forces
      // would_trade=0 -- so the INSERT-side enforce_total_exposure trigger's WHEN
      // (would_trade = 1) is never true for it. Only resolveDecision's later UPDATE
      // ever sets would_trade=1, so this is the entire live-trade cap-enforcement
      // path this project relies on. Fill EVENT to the $40 cap via three already
      // would_trade=1 rows...
      recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-p', eventTicker: EVENT }));
      recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-q', eventTicker: EVENT }));
      recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-r', eventTicker: EVENT }));
      recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-s', eventTicker: EVENT }));
      expect(totalExposureCents(db, EVENT)).toBe(4000);

      // ...then resolve a pending row (currently would_trade=0, contributing nothing)
      // to a real fill that would push the event over the cap. Without the
      // UPDATE-path trigger, this UPDATE would silently succeed.
      const decisionId = recordPendingDecision(
        db,
        tradeRecord({ storyKey: 's-over', eventTicker: EVENT, orderStatus: 'pending' })
      );
      expect(() =>
        resolveDecision(
          db,
          decisionId,
          tradeRecordOfNotional(1, { storyKey: 's-over', eventTicker: EVENT, wouldTrade: true, orderStatus: 'resolved' })
        )
      ).toThrow(/total exposure cap exceeded/);

      // The rejected UPDATE must not have partially applied -- still would_trade=0.
      const row = db.prepare('SELECT would_trade FROM decisions WHERE id = ?').get(decisionId) as {
        would_trade: number;
      };
      expect(row.would_trade).toBe(0);
    });

    it('allows a resolveDecision to would_trade=1 when it does not breach the cap, excluding the row being updated from its own sum', () => {
      // Three rows at $10 each = $30, leaving exactly $10 of headroom.
      recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-t', eventTicker: EVENT }));
      recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-u', eventTicker: EVENT }));
      recordDecision(db, tradeRecordOfNotional(1000, { storyKey: 's-v', eventTicker: EVENT }));

      const decisionId = recordPendingDecision(
        db,
        tradeRecord({ storyKey: 's-fits', eventTicker: EVENT, orderStatus: 'pending' })
      );
      expect(() =>
        resolveDecision(
          db,
          decisionId,
          tradeRecordOfNotional(1000, { storyKey: 's-fits', eventTicker: EVENT, wouldTrade: true, orderStatus: 'resolved' })
        )
      ).not.toThrow();
      expect(totalExposureCents(db, EVENT)).toBe(4000);
    });

    it('recordPendingOrder writes a pending orders row referencing its decision, and findPendingOrders finds it', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      const orderId = recordPendingOrder(db, {
        decisionId,
        clientOrderId: 'cid-abc',
        marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
        side: 'yes',
        requestedContracts: 83,
        positionBeforeContracts: 0,
      });
      expect(orderId).toBeGreaterThan(0);

      const pending = findPendingOrders(db);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        id: orderId,
        decisionId,
        clientOrderId: 'cid-abc',
        marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
        side: 'yes',
        requestedContracts: 83,
        positionBeforeContracts: 0,
      });
    });

    // --- C1: the orders row must carry the side, for both legs -----------------

    it.each(['yes', 'no'] as const)(
      'round-trips side=%s through recordPendingOrder -> findPendingOrders, so crash recovery can interpret a SIGNED position diff',
      (side) => {
        // Without this column, reconcilePendingOrders has no way to tell a NO fill
        // (which moves Kalshi's signed `position` DOWN) from no fill at all.
        const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending', side }));
        recordPendingOrder(db, {
          decisionId, clientOrderId: `cid-${side}`, marketTicker: 'T', side,
          requestedContracts: 5, positionBeforeContracts: side === 'no' ? -10 : 10,
        });

        const pending = findPendingOrders(db);
        expect(pending).toHaveLength(1);
        expect(pending[0].side).toBe(side);
        expect(pending[0].positionBeforeContracts).toBe(side === 'no' ? -10 : 10);
      }
    );

    it('rejects an orders row with a side outside yes/no at the DB layer', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      expect(() =>
        db
          .prepare(
            `INSERT INTO orders (decision_id, client_order_id, market_ticker, side,
                                 requested_contracts, position_before_contracts, status)
             VALUES (?, 'cid-bad-side', 'T', 'maybe', 1, 0, 'pending')`
          )
          .run(decisionId)
      ).toThrow(/constraint/i);
    });

    it('resolveOrder updates an existing pending order row in place and it no longer appears in findPendingOrders', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      const orderId = recordPendingOrder(db, {
        decisionId, clientOrderId: 'cid-def', marketTicker: 'T', side: 'yes', requestedContracts: 10, positionBeforeContracts: 0,
      });

      resolveOrder(db, orderId, {
        filledContracts: 10, avgFillPriceCents: 12, status: 'filled', kalshiOrderId: 'kalshi-1',
        kalshiOrderStatus: 'executed', errorDetail: null,
      });

      expect(findPendingOrders(db)).toHaveLength(0);
      const row = db.prepare('SELECT filled_contracts, avg_fill_price_cents, status, kalshi_order_id, kalshi_order_status, resolved_at FROM orders WHERE id = ?').get(orderId) as {
        filled_contracts: number; avg_fill_price_cents: number; status: string; kalshi_order_id: string; kalshi_order_status: string | null; resolved_at: string | null;
      };
      expect(row.filled_contracts).toBe(10);
      expect(row.avg_fill_price_cents).toBe(12);
      expect(row.status).toBe('filled');
      expect(row.kalshi_order_id).toBe('kalshi-1');
      // I3: Kalshi's own status word for the order is persisted as an audit trail.
      expect(row.kalshi_order_status).toBe('executed');
      expect(row.resolved_at).not.toBeNull();
    });

    it('persists kalshi_order_status as NULL on a path where no createOrder response was received', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      const orderId = recordPendingOrder(db, {
        decisionId, clientOrderId: 'cid-ambiguous', marketTicker: 'T', side: 'no', requestedContracts: 10, positionBeforeContracts: 0,
      });

      resolveOrder(db, orderId, {
        filledContracts: 0, avgFillPriceCents: null, status: 'unknown', kalshiOrderId: null,
        kalshiOrderStatus: null, errorDetail: 'ECONNRESET',
      });

      const row = db.prepare('SELECT kalshi_order_status FROM orders WHERE id = ?').get(orderId) as {
        kalshi_order_status: string | null;
      };
      expect(row.kalshi_order_status).toBeNull();
    });

    it('client_order_id is UNIQUE across orders', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      recordPendingOrder(db, { decisionId, clientOrderId: 'cid-dup', marketTicker: 'T', side: 'yes', requestedContracts: 1, positionBeforeContracts: 0 });
      expect(() =>
        recordPendingOrder(db, { decisionId, clientOrderId: 'cid-dup', marketTicker: 'T', side: 'yes', requestedContracts: 1, positionBeforeContracts: 0 })
      ).toThrow(/UNIQUE/i);
    });

    // --- resolveDecision notional-consistency regression tests ----------------

    it('rejects a resolveDecision with a would-trade record whose notionalCents does not equal contracts x entryPriceCents', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      expect(() =>
        resolveDecision(db, decisionId, tradeRecord({ contracts: 3, entryPriceCents: 12, notionalCents: 999, wouldTrade: true, orderStatus: 'resolved' }))
      ).toThrow(/notionalCents must equal contracts x entryPriceCents/);
    });

    it('rejects a resolveDecision with a would-trade record that has null entryPriceCents', () => {
      const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      expect(() =>
        resolveDecision(db, decisionId, tradeRecord({ contracts: 10, entryPriceCents: null, notionalCents: 0, wouldTrade: true, orderStatus: 'resolved' }))
      ).toThrow(/must carry an entry price/);
    });
  });

  describe('settlement tracking', () => {
    it('findOpenUnsettledDecisions returns only would_trade=1 rows with settled_at still null', () => {
      const openId = (() => {
        const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
        resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));
        return id;
      })();
      recordDecision(db, skipRecord()); // a skip -- would_trade=0, must not appear

      const open = findOpenUnsettledDecisions(db);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        id: openId,
        marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
        side: 'yes',
        contracts: 10,
      });
    });

    it('markDecisionSettled removes a row from findOpenUnsettledDecisions afterward', () => {
      const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));
      expect(findOpenUnsettledDecisions(db)).toHaveLength(1);

      markDecisionSettled(db, id);

      expect(findOpenUnsettledDecisions(db)).toHaveLength(0);
      const row = db.prepare('SELECT settled_at FROM decisions WHERE id = ?').get(id) as { settled_at: string | null };
      expect(row.settled_at).not.toBeNull();
    });

    it('excludes a would-trade row with a NULL side, which would otherwise be summed with the wrong sign', () => {
      // Nothing enforces non-null side: the schema CHECK and
      // assertNotionalIsConsistent both cover entry_price_cents/event_ticker/notional
      // only. Such a row reaching reconciliation would invert the expected signed
      // count feeding a real-money block decision, so it is filtered out here.
      db.prepare(
        `INSERT INTO decisions
           (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
            magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
            would_trade, reason, order_status)
         VALUES ('null-side-item', NULL, ?, 'KXAPRPOTUS-26AUG28-40.6', NULL, 'reported',
            'up', 0.3, 10, 10, 100, 3, 1, 'row with no side', 'resolved')`
      ).run(EVENT);

      expect(findOpenUnsettledDecisions(db)).toHaveLength(0);
    });

    it('excludes a would-trade row with a NULL market_ticker, which would otherwise group under a null key', () => {
      db.prepare(
        `INSERT INTO decisions
           (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
            magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
            would_trade, reason, order_status)
         VALUES ('null-ticker-item', NULL, ?, NULL, 'yes', 'reported',
            'up', 0.3, 10, 10, 100, 3, 1, 'row with no market_ticker', 'resolved')`
      ).run(EVENT);

      expect(findOpenUnsettledDecisions(db)).toHaveLength(0);
    });

    it('still returns healthy rows alongside a malformed one, rather than failing the whole pass', () => {
      const goodId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
      resolveDecision(db, goodId, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));
      db.prepare(
        `INSERT INTO decisions
           (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
            magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
            would_trade, reason, order_status)
         VALUES ('null-side-item-2', NULL, ?, 'KXAPRPOTUS-26AUG28-40.6', NULL, 'reported',
            'up', 0.3, 10, 10, 100, 3, 1, 'row with no side', 'resolved')`
      ).run(EVENT);

      const open = findOpenUnsettledDecisions(db);
      expect(open.map((row) => row.id)).toEqual([goodId]);
    });
  });

  describe('market_blocks', () => {
    it('isMarketBlocked is false for a market never blocked', () => {
      expect(isMarketBlocked(db, 'KXAPRPOTUS-26AUG28-40.6')).toBe(false);
    });

    it('blockMarket makes isMarketBlocked true, recording the reason and counts', () => {
      blockMarket(db, 'KXAPRPOTUS-26AUG28-40.6', 'reconciliation divergence: expected 10, real 0', 10, 0);

      expect(isMarketBlocked(db, 'KXAPRPOTUS-26AUG28-40.6')).toBe(true);
      const row = db.prepare('SELECT reason, expected_contracts, real_contracts, cleared_at FROM market_blocks WHERE market_ticker = ?')
        .get('KXAPRPOTUS-26AUG28-40.6') as { reason: string; expected_contracts: number; real_contracts: number; cleared_at: string | null };
      expect(row.reason).toMatch(/expected 10, real 0/);
      expect(row.expected_contracts).toBe(10);
      expect(row.real_contracts).toBe(0);
      expect(row.cleared_at).toBeNull();
    });

    it('a cleared block reports isMarketBlocked as false, but blocking the same ticker again reactivates it', () => {
      blockMarket(db, 'T', 'first divergence', 5, 0);
      db.prepare(`UPDATE market_blocks SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE market_ticker = 'T'`).run();
      expect(isMarketBlocked(db, 'T')).toBe(false);

      blockMarket(db, 'T', 'second divergence', 8, 2);

      expect(isMarketBlocked(db, 'T')).toBe(true);
      const row = db.prepare('SELECT reason, cleared_at FROM market_blocks WHERE market_ticker = ?').get('T') as {
        reason: string; cleared_at: string | null;
      };
      expect(row.reason).toBe('second divergence');
      expect(row.cleared_at).toBeNull();
    });
  });

  describe('circuit breakers', () => {
    it('isTradingHalted is false with no trips', () => {
      expect(isTradingHalted(db)).toBe(false);
    });

    it('tripBreaker halts trading, and clearAllTrips un-halts it', () => {
      tripBreaker(db, 'failed-orders', 'test reason');
      expect(isTradingHalted(db)).toBe(true);
      const cleared = clearAllTrips(db);
      expect(cleared).toBe(1);
      expect(isTradingHalted(db)).toBe(false);
    });

    it('does not insert a second trip row for the same signal while it is still open', () => {
      tripBreaker(db, 'failed-orders', 'first reason');
      tripBreaker(db, 'failed-orders', 'second reason');
      const rows = db.prepare('SELECT * FROM circuit_breaker_trips').all();
      expect(rows).toHaveLength(1);
    });

    it('trips a second, distinct signal independently while the first is still open', () => {
      tripBreaker(db, 'failed-orders', 'reason A');
      tripBreaker(db, 'divergences', 'reason B');
      const rows = db.prepare('SELECT signal FROM circuit_breaker_trips ORDER BY signal').all();
      expect(rows).toEqual([{ signal: 'divergences' }, { signal: 'failed-orders' }]);
    });

    it('alerts on a genuinely new trip for ANY signal (including kalshi-errors, which no caller alerts on directly), but never again while that signal stays open', () => {
      const alertSpy = vi.spyOn(alertModule, 'sendAlert').mockResolvedValue(undefined);

      tripBreaker(db, 'kalshi-errors', 'reason A');
      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(alertSpy.mock.calls[0][0]).toContain('kalshi-errors');
      expect(alertSpy.mock.calls[0][0]).toContain('reason A');

      // Re-tripping the SAME still-open signal must not alert again -- this is
      // the exact cross-signal-suppression bug's fix: the dedup that decides
      // whether to alert is now tripBreaker's own per-signal `alreadyOpen`
      // check, not a caller-side snapshot of the GLOBAL isTradingHalted.
      tripBreaker(db, 'kalshi-errors', 'reason A again');
      expect(alertSpy).toHaveBeenCalledTimes(1);

      // A SECOND, distinct signal tripping while the first is still open must
      // still alert on its own -- this is the bug this refactor closes: under
      // the old caller-side isTradingHalted-transition guard, isTradingHalted
      // was already true (from kalshi-errors above) before this call, so a
      // genuine NEW failed-orders trip would have been silently swallowed.
      tripBreaker(db, 'failed-orders', 'reason B');
      expect(alertSpy).toHaveBeenCalledTimes(2);
      expect(alertSpy.mock.calls[1][0]).toContain('failed-orders');
    });

    it('clearAllTrips clears every currently-open row when multiple signals are tripped, and returns 0 when none are open', () => {
      tripBreaker(db, 'failed-orders', 'reason A');
      tripBreaker(db, 'divergences', 'reason B');
      expect(clearAllTrips(db)).toBe(2);
      expect(isTradingHalted(db)).toBe(false);
      expect(clearAllTrips(db)).toBe(0);
    });

    it('recordKalshiError logs a row and trips kalshi-errors at exactly the threshold', () => {
      for (let i = 0; i < CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD - 1; i++) {
        recordKalshiError(db, 'getPositions', `error ${i}`);
      }
      expect(isTradingHalted(db)).toBe(false);
      recordKalshiError(db, 'getPositions', 'the final straw');
      expect(isTradingHalted(db)).toBe(true);
      const trip = db.prepare('SELECT signal FROM circuit_breaker_trips').get() as { signal: string };
      expect(trip.signal).toBe('kalshi-errors');
    });

    it('a kalshi_errors row outside the lookback window does not count toward the threshold', () => {
      for (let i = 0; i < CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD; i++) {
        recordKalshiError(db, 'getPositions', `error ${i}`);
      }
      clearAllTrips(db);
      // Backdate every logged row well outside the 15-minute window.
      db.prepare("UPDATE kalshi_errors SET occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')").run();
      recordKalshiError(db, 'getPositions', 'one fresh error');
      expect(isTradingHalted(db)).toBe(false);
    });

    it('checkFailedOrdersSignal trips failed-orders at exactly the threshold, counting only rejected/unknown/error', () => {
      let coidSeq = 0;
      const makeOrder = () => {
        const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
        return recordPendingOrder(db, {
          decisionId, clientOrderId: `coid-${++coidSeq}`, marketTicker: 'TICK', side: 'yes',
          requestedContracts: 10, positionBeforeContracts: 0,
        });
      };
      const resolveWith = (orderId: number, status: 'unfilled' | 'rejected' | 'unknown') =>
        resolveOrder(db, orderId, {
          filledContracts: 0, avgFillPriceCents: null, status,
          kalshiOrderId: null, kalshiOrderStatus: null, errorDetail: null,
        });

      // Two unfilled orders (normal outcome) never count, however many there are.
      resolveWith(makeOrder(), 'unfilled');
      checkFailedOrdersSignal(db, 'unfilled');
      resolveWith(makeOrder(), 'unfilled');
      checkFailedOrdersSignal(db, 'unfilled');
      expect(isTradingHalted(db)).toBe(false);

      // Now CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD real failures.
      for (let i = 0; i < CIRCUIT_BREAKER_FAILED_ORDERS_THRESHOLD - 1; i++) {
        const id = makeOrder();
        resolveWith(id, 'rejected');
        checkFailedOrdersSignal(db, 'rejected');
      }
      expect(isTradingHalted(db)).toBe(false);
      const lastId = makeOrder();
      resolveWith(lastId, 'unknown');
      checkFailedOrdersSignal(db, 'unknown');
      expect(isTradingHalted(db)).toBe(true);
    });

    it('checkDivergencesSignal trips divergences at exactly the threshold, ignoring blocks outside the window', () => {
      blockMarket(db, 'TICKER-A', 'reason A', 10, 5);
      checkDivergencesSignal(db);
      expect(isTradingHalted(db)).toBe(false);

      blockMarket(db, 'TICKER-B', 'reason B', 8, 2);
      checkDivergencesSignal(db);
      expect(isTradingHalted(db)).toBe(true);
    });

    it('a market_blocks row outside the divergences window does not count', () => {
      blockMarket(db, 'TICKER-A', 'reason A', 10, 5);
      db.prepare("UPDATE market_blocks SET blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours') WHERE market_ticker = 'TICKER-A'").run();
      blockMarket(db, 'TICKER-B', 'reason B', 8, 2);
      checkDivergencesSignal(db);
      expect(isTradingHalted(db)).toBe(false);
    });

    it('a breaker check failure is caught and logged, never propagated', () => {
      const brokenDb = { prepare: () => { throw new Error('simulated DB failure'); } } as unknown as Database.Database;
      expect(() => checkFailedOrdersSignal(brokenDb, 'rejected')).not.toThrow();
      expect(() => checkDivergencesSignal(brokenDb)).not.toThrow();
      expect(() => recordKalshiError(brokenDb, 'getPositions', 'boom')).not.toThrow();
    });
  });

  describe('process lifecycle', () => {
    it('recordProcessStarting returns false on the very first boot (no prior row)', () => {
      expect(recordProcessStarting(db)).toBe(false);
    });

    it('recordProcessStarting returns true when the previous run never called recordProcessStoppedCleanly (an unclean exit)', () => {
      recordProcessStarting(db); // first boot -- returns false, marks 'running'
      // Process "crashes" here -- no recordProcessStoppedCleanly call.
      expect(recordProcessStarting(db)).toBe(true); // next boot detects it
    });

    it('recordProcessStarting returns false again after a clean shutdown', () => {
      recordProcessStarting(db);
      recordProcessStoppedCleanly(db);
      expect(recordProcessStarting(db)).toBe(false);
    });

    it('recordProcessStarting always marks the run "running", so a THIRD unclean exit in a row is still detected', () => {
      recordProcessStarting(db);
      expect(recordProcessStarting(db)).toBe(true); // crash 1 detected
      expect(recordProcessStarting(db)).toBe(true); // crash 2 detected -- still 'running' from crash 1's boot
    });
  });
});

/**
 * The `decisions` table exactly as slices 1-4 created it: every column `SCHEMA` in
 * ledger.ts defines, MINUS `settled_at` (which slice 5 added). This is the real,
 * pre-existing on-disk shape on any machine that ran this system before slice 5 --
 * `CREATE TABLE IF NOT EXISTS` does nothing against it, so without a migration the
 * new column never appears and every reconciliation pass throws forever.
 */
const PRE_SLICE_5_DECISIONS_SCHEMA = `
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  story_key TEXT,
  event_ticker TEXT,
  market_ticker TEXT,
  side TEXT CHECK (side IN ('yes','no') OR side IS NULL),
  rung TEXT NOT NULL CHECK (rung IN ('rumor','reported','corroborated','confirmed')),
  direction TEXT CHECK (direction IN ('up','down') OR direction IS NULL),
  magnitude_pts REAL,
  contracts INTEGER NOT NULL DEFAULT 0 CHECK (contracts >= 0),
  entry_price_cents INTEGER CHECK (entry_price_cents IS NULL OR (entry_price_cents > 0 AND entry_price_cents < 100)),
  notional_cents INTEGER NOT NULL DEFAULT 0 CHECK (notional_cents >= 0 AND (would_trade = 0 OR notional_cents <= ${MAX_NOTIONAL_CENTS_PER_TRADE})),
  edge_cents REAL,
  would_trade INTEGER NOT NULL CHECK (would_trade IN (0,1)),
  reason TEXT NOT NULL,
  order_status TEXT NOT NULL DEFAULT 'resolved' CHECK (order_status IN ('pending','resolved')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (would_trade = 0 OR (
    entry_price_cents IS NOT NULL
    AND event_ticker IS NOT NULL
    AND notional_cents = contracts * entry_price_cents
  ))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_item_id ON decisions(item_id);
CREATE TRIGGER IF NOT EXISTS enforce_total_exposure
BEFORE INSERT ON decisions
WHEN NEW.would_trade = 1
BEGIN
  SELECT RAISE(ABORT, 'total exposure cap exceeded')
  WHERE (SELECT COALESCE(SUM(notional_cents), 0) FROM decisions
         WHERE would_trade = 1 AND event_ticker = NEW.event_ticker)
        + NEW.notional_cents > ${MAX_TOTAL_EXPOSURE_CENTS};
END;
`;

describe('openLedger migration of a pre-slice-5 decisions table', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-migration-test-'));
    dbPath = path.join(dir, 'decisions.db');
    const legacy = new BetterSqlite3(dbPath);
    legacy.exec(PRE_SLICE_5_DECISIONS_SCHEMA);
    // A real would-trade position already on disk from before slice 5 -- it must
    // survive the migration and show up as open-and-unsettled afterward.
    legacy
      .prepare(
        `INSERT INTO decisions
           (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
            magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
            would_trade, reason, order_status)
         VALUES ('legacy-item-1', 'story-legacy', '${EVENT}', 'KXAPRPOTUS-26AUG28-40.6',
            'yes', 'reported', 'up', 0.3, 7, 12, 84, 3, 1, 'legacy would-trade row', 'resolved')`
      )
      .run();
    legacy.close();
    db = openLedger(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the settled_at column to a decisions table that predates it', () => {
    const columns = db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain('settled_at');
  });

  it('leaves a pre-existing would-trade row visible to findOpenUnsettledDecisions instead of throwing "no such column"', () => {
    // Before the migration existed, this threw `no such column: settled_at` on every
    // reconciliation pass, forever, while trading continued unguarded.
    expect(() => findOpenUnsettledDecisions(db)).not.toThrow();
    const open = findOpenUnsettledDecisions(db);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
      side: 'yes',
      contracts: 7,
    });
  });

  it('records and settles a NEW would-trade decision through the normal path on a migrated database', () => {
    const id = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    resolveDecision(db, id, tradeRecord({ wouldTrade: true, orderStatus: 'resolved' }));

    const open = findOpenUnsettledDecisions(db);
    expect(open.map((row) => row.id)).toContain(id);

    markDecisionSettled(db, id);

    expect(findOpenUnsettledDecisions(db).map((row) => row.id)).not.toContain(id);
    const row = db.prepare('SELECT settled_at FROM decisions WHERE id = ?').get(id) as {
      settled_at: string | null;
    };
    expect(row.settled_at).not.toBeNull();
  });

  it('is idempotent: re-opening an already-migrated database does not fail or duplicate the column', () => {
    db.close();
    db = openLedger(dbPath);
    const columns = db.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>;
    expect(columns.filter((c) => c.name === 'settled_at')).toHaveLength(1);
  });
});
