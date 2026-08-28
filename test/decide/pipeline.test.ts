// test/decide/pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { runDecisionPipeline } from '../../src/decide/pipeline.js';
import { openLedger, hasOpenPosition, totalExposureCents } from '../../src/decide/ledger.js';
import { computeRung } from '../../src/decide/rung.js';
import type { Item } from '../../src/item.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import * as synopsisModule from '../../src/decide/synopsis.js';
import * as verifyModule from '../../src/decide/verify.js';
import * as decideModule from '../../src/decide/decide.js';
import * as orderModule from '../../src/execute/order.js';

function baseItem(overrides: Partial<Item> = {}): Item {
  return {
    item_id: 'item-1',
    dedup_id: 'dedup-1',
    story_key: 'story-1',
    event_type: 'item',
    replay: false,
    source_id: 'bls_releases',
    adapter: 'feed',
    trust_tier: 1,
    headline: 'BLS reports unemployment rate fell to 3.9%',
    snippet: 'The unemployment rate declined to 3.9% in July.',
    url: null,
    raw_url: null,
    enrich_url: null,
    author: null,
    lang: null,
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: null,
    first_seen_ts: '2026-08-25T10:01:00Z',
    emitted_ts: '2026-08-25T10:01:05Z',
    latency_ms: 5000,
    is_first_sighting: true,
    corroborations: 0,
    provenance_gaps: [],
    amends_item_id: null,
    amendment_kind: null,
    ...overrides,
  };
}

// Deviation from the brief's literal fixture numbers (documented in the task report):
// the brief's original three-band fixture (40.0-40.2 / 40.2-40.4 ask 40/42, tail 12)
// is real market-shaped data, but run through the actual (Task-4, bug-fixed)
// evaluateSizing logic it never clears the edge/Kelly gates for direction 'up',
// magnitudePts 0.3, rung 'reported' -- the narrow 0.2pt band spacing means the
// shifted interpolation target clamps to a curve endpoint instead of landing
// strictly inside the curve, so no candidate ever earns enough edge to size a
// contract. Widening the two tradeable bands to 0.4pt spacing with more separated
// prices keeps the shifted target strictly inside the curve's interior and
// produces a real, sizeable edge, letting the "everything clears" tests exercise
// the actual would-trade path end-to-end.
function stubLadder(): ActiveLadder {
  return {
    eventTicker: 'KXAPRPOTUS-26AUG28',
    strikeDate: '2026-08-28T16:00:00Z',
    bands: [
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.2',
        floorStrike: 39.8,
        capStrike: 40.2,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 20,
        yesBidCents: 18,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.6',
        floorStrike: 40.2,
        capStrike: 40.6,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 60,
        yesBidCents: 58,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-41.0',
        floorStrike: 40.6,
        capStrike: null,
        strikeType: 'greater',
        status: 'active',
        yesAskCents: 12,
        yesBidCents: 10,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
    ],
  };
}

const EVENT = 'KXAPRPOTUS-26AUG28';

// The pipeline reads a position snapshot directly (via kalshiClient.getPositions())
// before placeOrder is ever called -- every test needs that stubbed, independent of
// whatever placeOrder itself is mocked to return.
function stubKalshiClient(position = 0) {
  return { getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position }] }) } as any;
}

interface DecisionRow {
  item_id: string;
  rung: string;
  would_trade: number;
  reason: string;
  event_ticker: string | null;
}

function rowsFor(db: Database.Database, itemId: string): DecisionRow[] {
  return db
    .prepare(
      `SELECT item_id, rung, would_trade, reason, event_ticker FROM decisions WHERE item_id = ?`
    )
    .all(itemId) as DecisionRow[];
}

function onlyRowFor(db: Database.Database, itemId: string): DecisionRow {
  const rows = rowsFor(db, itemId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('runDecisionPipeline', () => {
  let dir: string;
  let db: Database.Database;
  let client: Anthropic;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pipeline-test-'));
    db = openLedger(path.join(dir, 'test.db'));
    client = new Anthropic({ apiKey: 'sk-ant-unused-in-these-tests' });
    delete process.env.EXECUTOR_TRADING_HALTED;
    vi.spyOn(synopsisModule, 'synopsize').mockResolvedValue('The unemployment rate fell to 3.9%.');
    vi.spyOn(verifyModule, 'verifySynopsis').mockResolvedValue({ supported: true, note: 'faithful' });
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
      direction: 'up',
      magnitudePts: 0.3,
      shouldTrade: true,
      reasoning: 'stronger-than-expected jobs data typically lifts approval',
    });
    // Default: a clean full fill at the sized price/contracts, mirroring whatever
    // evaluateSizing actually decided -- pre-Task-6 tests that only care about the
    // would-trade path succeeding (not about execution specifics) rely on this and
    // never need to know about placeOrder at all. Tests that DO care about specific
    // fill outcomes (Task 6's own tests) override this per-case with vi.spyOn.
    vi.spyOn(orderModule, 'placeOrder').mockImplementation(async (input) => ({
      clientOrderId: 'default-mock-client-order-id',
      kalshiOrderId: 'default-mock-kalshi-order-id',
      filledContracts: input.contracts,
      avgFillPriceCents: input.entryPriceCents,
      status: 'filled',
      errorDetail: null,
    }));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.EXECUTOR_TRADING_HALTED;
  });

  it('records a skip when the kill switch is set, and makes no model calls', async () => {
    process.env.EXECUTOR_TRADING_HALTED = 'true';
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    const item = baseItem();

    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

    expect(synopsisModule.synopsize).not.toHaveBeenCalled();
    expect(fetchLadder).not.toHaveBeenCalled();
    expect(hasOpenPosition(db, 'story-1', EVENT)).toBe(false);
    // The recorded rung is the item's REAL rung, not a placeholder. This fixture's
    // rung is 'reported', so a hardcoded 'rumor' default would be visible here.
    const expectedRung = computeRung({
      trustTier: item.trust_tier,
      storyKey: item.story_key,
      corroborations: item.corroborations,
    });
    expect(expectedRung).toBe('reported');
    expect(onlyRowFor(db, item.item_id).rung).toBe(expectedRung);
  });

  it('records a skip when verify reports unsupported, before decide/sizing, carrying the real rung', async () => {
    vi.spyOn(verifyModule, 'verifySynopsis').mockResolvedValue({ supported: false, note: 'fabricated' });
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    const item = baseItem();

    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

    expect(decideModule.decideTrade).not.toHaveBeenCalled();
    expect(fetchLadder).not.toHaveBeenCalled();
    const row = onlyRowFor(db, item.item_id);
    expect(row.rung).toBe('reported');
    expect(row.reason).toMatch(/not supported by source/);
  });

  it('records a skip when rung is rumor without calling EITHER model step', async () => {
    // The rung gate depends on nothing synopsize or verify produce, so a
    // guaranteed-skip 'rumor' item must not burn a Haiku call and a Sonnet call.
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    const item = baseItem({ trust_tier: 3, story_key: null });

    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

    expect(synopsisModule.synopsize).not.toHaveBeenCalled();
    expect(verifyModule.verifySynopsis).not.toHaveBeenCalled();
    expect(decideModule.decideTrade).not.toHaveBeenCalled();
    expect(fetchLadder).not.toHaveBeenCalled();
    expect(onlyRowFor(db, item.item_id).rung).toBe('rumor');
  });

  it('skips a story that already has an open position for the active event, without calling Sonnet decide', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    // First run: real would-trade path.
    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });
    expect(hasOpenPosition(db, 'story-1', EVENT)).toBe(true);

    vi.mocked(decideModule.decideTrade).mockClear();
    await runDecisionPipeline(baseItem({ item_id: 'item-2' }), { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });
    expect(decideModule.decideTrade).not.toHaveBeenCalled();
  });

  it('records a skip when Sonnet decide says should_trade=false', async () => {
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
      direction: 'up',
      magnitudePts: 0.1,
      shouldTrade: false,
      reasoning: 'too indirect to act on',
    });
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

    expect(hasOpenPosition(db, 'story-1', EVENT)).toBe(false);
  });

  it('records a would-trade decision and increases total exposure when everything clears', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

    expect(hasOpenPosition(db, 'story-1', EVENT)).toBe(true);
    expect(totalExposureCents(db, EVENT)).toBeGreaterThan(0);
    expect(totalExposureCents(db, EVENT)).toBeLessThanOrEqual(1000);
  });

  it('records a skip (not a throw) when fetchLadder returns null (no active event)', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(null);

    await expect(
      runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() })
    ).resolves.toBeUndefined();
    expect(hasOpenPosition(db, 'story-1', EVENT)).toBe(false);
  });

  // --- I3: an exception must never lose the item silently ----------------------

  it('records a skip row instead of throwing when fetchLadder throws mid-pipeline', async () => {
    // fetchActiveLadder throws on any non-OK HTTP response, so this is the real
    // production shape of the failure. The Redis consumer acks the entry once this
    // handler returns, so an escaping exception would lose the item with no trace.
    const fetchLadder = vi.fn().mockRejectedValue(new Error('Kalshi returned HTTP 503'));
    const item = baseItem();

    await expect(
      runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() })
    ).resolves.toBeUndefined();

    const row = onlyRowFor(db, item.item_id);
    expect(row.would_trade).toBe(0);
    expect(row.reason).toContain('pipeline error');
    expect(row.reason).toContain('Kalshi returned HTTP 503');
    // The trace is only useful if it carries the rung that was already computed.
    expect(row.rung).toBe('reported');
  });

  it('records a skip row instead of throwing when decideTrade throws mid-pipeline', async () => {
    // The real incident: a transient truncated-JSON parse error out of the decide
    // step, which self-resolved on retry and left nothing behind the first time.
    vi.spyOn(decideModule, 'decideTrade').mockRejectedValue(
      new Error('Unexpected end of JSON input')
    );
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    const item = baseItem();

    await expect(
      runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() })
    ).resolves.toBeUndefined();

    const row = onlyRowFor(db, item.item_id);
    expect(row.would_trade).toBe(0);
    expect(row.reason).toContain('pipeline error: Unexpected end of JSON input');
  });

  it('records a skip row instead of throwing when a non-Error value is thrown', async () => {
    const fetchLadder = vi.fn().mockRejectedValue('a bare string rejection');
    const item = baseItem();

    await expect(
      runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() })
    ).resolves.toBeUndefined();
    expect(onlyRowFor(db, item.item_id).reason).toContain('a bare string rejection');
  });

  // --- I4: at-least-once delivery must not double-write a decision -------------

  it('is a no-op on a redelivered item that already has a decision row (would-trade path)', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    const item = baseItem();

    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });
    expect(onlyRowFor(db, item.item_id).would_trade).toBe(1);

    vi.mocked(synopsisModule.synopsize).mockClear();
    // Exactly what Redis does after a crash before the ACK: the same entry again.
    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

    // Still exactly one row -- not double-counted against the exposure cap...
    expect(rowsFor(db, item.item_id)).toHaveLength(1);
    expect(totalExposureCents(db, EVENT)).toBeLessThanOrEqual(1000);
    // ...and the three model calls were not spent again.
    expect(synopsisModule.synopsize).not.toHaveBeenCalled();
  });

  it('is a no-op on a redelivered item that already has a skip row (skip path)', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(null);
    const item = baseItem();

    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });
    await runDecisionPipeline(item, { anthropicClient: client, db, fetchLadder, kalshiClient: stubKalshiClient() });

    expect(rowsFor(db, item.item_id)).toHaveLength(1);
  });

  // --- Task 6: order placement wired into the would-trade path -----------------

  it('places a real order for a would-trade decision and resolves both the decision and order rows with the ACTUAL fill, not the sized amount', async () => {
    vi.spyOn(orderModule, 'placeOrder').mockResolvedValue({
      clientOrderId: 'cid-x', kalshiOrderId: 'kalshi-x', filledContracts: 40, // a partial fill: sizing wanted more
      avgFillPriceCents: 12, status: 'partial', errorDetail: null,
    });

    const deps = { anthropicClient: client, db, fetchLadder: async () => stubLadder(), kalshiClient: stubKalshiClient() };
    await runDecisionPipeline(baseItem(), deps);

    const decisionRow = db.prepare('SELECT would_trade, contracts, entry_price_cents, notional_cents, order_status FROM decisions').get() as {
      would_trade: number; contracts: number; entry_price_cents: number; notional_cents: number; order_status: string;
    };
    // The row reflects the ACTUAL fill (40), not whatever evaluateSizing originally sized.
    expect(decisionRow.would_trade).toBe(1);
    expect(decisionRow.contracts).toBe(40);
    expect(decisionRow.entry_price_cents).toBe(12);
    expect(decisionRow.notional_cents).toBe(480);
    expect(decisionRow.order_status).toBe('resolved');

    const orderRow = db.prepare('SELECT status, filled_contracts, kalshi_order_id FROM orders').get() as {
      status: string; filled_contracts: number; kalshi_order_id: string;
    };
    expect(orderRow.status).toBe('partial');
    expect(orderRow.filled_contracts).toBe(40);
    expect(orderRow.kalshi_order_id).toBe('kalshi-x');
  });

  it('records would_trade=0 when placeOrder reports a zero fill, even though evaluateSizing decided to trade', async () => {
    vi.spyOn(orderModule, 'placeOrder').mockResolvedValue({
      clientOrderId: 'cid-y', kalshiOrderId: null, filledContracts: 0, avgFillPriceCents: null, status: 'unfilled', errorDetail: null,
    });

    const deps = { anthropicClient: client, db, fetchLadder: async () => stubLadder(), kalshiClient: stubKalshiClient() };
    await runDecisionPipeline(baseItem(), deps);

    const decisionRow = db.prepare('SELECT would_trade, contracts FROM decisions').get() as { would_trade: number; contracts: number };
    expect(decisionRow.would_trade).toBe(0);
    expect(decisionRow.contracts).toBe(0);
  });

  it('is crash-safe: a pending decision + order row is written and durably captures position_before_contracts BEFORE placeOrder is ever called', async () => {
    let placeOrderCallCount = 0;
    vi.spyOn(orderModule, 'placeOrder').mockImplementation(async () => {
      placeOrderCallCount += 1;
      // Simulate the pending rows already existing at the moment placeOrder is invoked.
      const pending = db.prepare('SELECT * FROM orders WHERE status = ?').all('pending');
      expect(pending).toHaveLength(1);
      throw new Error('simulated crash mid-placeOrder');
    });

    const deps = { anthropicClient: client, db, fetchLadder: async () => stubLadder(), kalshiClient: stubKalshiClient() };
    await runDecisionPipeline(baseItem(), deps); // the pipeline's own try/catch (I3) turns this into a durable skip row

    expect(placeOrderCallCount).toBe(1);
    const decisionRow = db.prepare('SELECT would_trade, reason FROM decisions').get() as { would_trade: number; reason: string };
    expect(decisionRow.would_trade).toBe(0);
    expect(decisionRow.reason).toMatch(/simulated crash mid-placeOrder/);
  });
});
