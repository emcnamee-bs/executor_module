// A real PerpEngine driving a real KalshiMarginBroker over a scripted fake margin exchange (final review 9a).
// Only the HTTP client is faked: the order, trailing-stop, poll/classification and reconcile paths are the shipped ones.
import { describe, it, expect } from 'vitest';
import { KalshiMarginBroker } from '../../src/perp/broker/kalshiMarginBroker.js';
import { DEFAULT_CONFIG } from '../../src/perp/config.js';
import { PerpEngine, type Collected } from '../../src/perp/engine/engine.js';
import { listExits, listJournal, loadPosition, loadRiskState, openPerpDb } from '../../src/perp/store/db.js';
import type Database from 'better-sqlite3';
import type { ImpactAssessment } from '../../src/perp/types.js';

const T = 'KXUS500PERP1';
const NOW0 = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const H = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

interface Recorded { method: string; path: string; query?: Record<string, unknown>; body?: unknown }
interface FillRow { fill_id: string; order_id: string; side: 'bid' | 'ask'; count: string; created_time: string; ticker: string; price: string; fees: string; realized_pnl: string }

/** A tiny stateful margin exchange: one subaccount, one ticker. */
function fakeExchange(clock: () => number) {
  const calls: Recorded[] = [];
  const st = {
    pos: null as null | { qty: number; entry: number },
    fills: [] as FillRow[],
    orderReasons: {} as Record<string, string | undefined>,
    orderSeq: 0,
  };
  const handlers: Record<string, (query?: Record<string, unknown>, body?: unknown) => unknown> = {
    [`GET /margin/markets/${T}`]: () => ({
      market: { bid: '13.7500', ask: '13.7600', price: '13.7550', liquidation_mark_price: { price: '13.7550' } },
    }),
    'GET /margin/positions': () => ({
      positions: st.pos === null ? [] : [{
        subaccount: 3, market_ticker: T, position: st.pos.qty.toFixed(2), entry_price: st.pos.entry.toFixed(4),
        unrealized_pnl: '0.0000', fees: '0.0010',
      }],
    }),
    'GET /margin/risk': () => ({
      positions: st.pos === null ? [] : [{ subaccount: 3, market_ticker: T, mark_price: '13.7550', estimated_liquidation_price: '10.8000' }],
    }),
    'GET /margin/balance': () => ({ subaccount_balances: [{ subaccount: 3, account_equity: '3.5000', available_balance: '3.5000' }] }),
    'GET /margin/fills': () => ({ fills: st.fills }),
    'POST /margin/orders': (_q, body) => {
      const b = body as { side: 'bid' | 'ask'; reduce_only: boolean };
      const id = `o${++st.orderSeq}`;
      const price = b.side === 'bid' ? 13.76 : 13.75;
      if (!b.reduce_only) st.pos = { qty: b.side === 'bid' ? 1 : -1, entry: price };
      else st.pos = null;
      st.fills.push({
        fill_id: `f-${id}`, order_id: id, side: b.side, count: '1.00', created_time: iso(clock()), ticker: T,
        price: price.toFixed(4), fees: '0.0010', realized_pnl: '0.0000',
      });
      st.orderReasons[id] = undefined;
      return { order_id: id, fill_count: '1.00', remaining_count: '0.00', average_fill_price: price.toFixed(4), average_fee_paid: '0.0010' };
    },
    [`PUT /margin/isolated/positions/${T}/exit_trigger`]: () => ({ id: 't1', status: 'active' }),
    [`DELETE /margin/isolated/positions/${T}/exit_trigger`]: () => null,
  };
  const run = (method: string) => async (path: string, a?: unknown, b?: unknown) => {
    const isBody = method === 'POST' || method === 'PUT';
    const rec: Recorded = { method, path, body: isBody ? a : undefined, query: (isBody ? b : a) as Record<string, unknown> | undefined };
    calls.push(rec);
    const order = /^\/margin\/orders\/(.+)$/.exec(path);
    if (method === 'GET' && order) {
      if (!(order[1] in st.orderReasons)) throw new Error(`404 order ${order[1]}`);
      const reason = st.orderReasons[order[1]];
      return { order: reason === undefined ? { order_source: 'user' } : { order_source: 'system', order_reason: reason } };
    }
    const h = handlers[`${method} ${path}`];
    if (!h) throw new Error(`unscripted call: ${method} ${path}`);
    return h(rec.query, rec.body);
  };
  /** The exchange closes the position itself (trailing stop or liquidation): position gone, closing fill + system order visible. */
  const exchangeCloses = (reason: 'take_profit_stop_loss' | 'liquidation', price: number) => {
    const side = st.pos !== null && st.pos.qty > 0 ? 'ask' : 'bid';
    const entry = st.pos?.entry ?? 13.76;
    st.pos = null;
    const id = `sys${++st.orderSeq}`;
    st.fills.push({
      fill_id: `f-${id}`, order_id: id, side, count: '1.00', created_time: iso(clock()), ticker: T,
      price: price.toFixed(4), fees: '0.0010', realized_pnl: ((price - entry) * (side === 'ask' ? 1 : -1)).toFixed(4),
    });
    st.orderReasons[id] = reason;
  };
  return { client: { get: run('GET'), post: run('POST'), put: run('PUT'), del: run('DELETE') } as never, calls, st, exchangeCloses };
}

function world() {
  let now = NOW0;
  const clock = () => now;
  const ex = fakeExchange(clock);
  const db = openPerpDb(':memory:');
  const alerts: string[] = [];
  const collect = async (): Promise<Collected> => ({
    perp: { bid: 13.75, ask: 13.76, mark: 13.755, marketOpen: true, nextCloseTsMs: NOW0 + 3 * 24 * H, fundingEstimate: 0.0001 },
    perpFetchedAtMs: now,
    macro: { vix: { value: 16, change1d: 0, asOf: '2026-10-13' } },
    macroFetchedAtMs: now,
    events: [],
    kalshiEvents: [],
  });
  const newBroker = () =>
    new KalshiMarginBroker(ex.client, { env: 'demo', ticker: T, subaccount: 3, triggerMode: 'isolated', slippageFrac: 0.002 }, {
      now: clock, newOrderId: () => `cid-${now}`, delay: async () => undefined,
    });
  const newEngine = (broker: KalshiMarginBroker, database: Database.Database = db) =>
    new PerpEngine({ cfg: DEFAULT_CONFIG, db: database, broker, now: clock, collect, alert: (m) => alerts.push(m) });
  let seq = 0;
  const bullish = (): ImpactAssessment => ({
    itemId: `k-${++seq}`, receivedAtMs: now, publishedAtMs: now - 30_000, direction: 'up', bucket: 'major',
    horizon: 'days', credibility: 0.8, novelty: 'new', alreadyPriced: 'no', confidence: 0.75, rationale: 'test',
  });
  return { ex, db, alerts, newBroker, newEngine, bullish, now: clock, advance: (ms: number) => { now += ms; } };
}

async function openThroughEngine(w: ReturnType<typeof world>) {
  const broker = w.newBroker();
  const engine = w.newEngine(broker);
  await engine.start();
  await engine.tick();
  await engine.onAssessment(w.bullish());
  return { broker, engine };
}

describe('PerpEngine + real KalshiMarginBroker (W9a)', () => {
  it('opens with an IOC buy and a trailing-stop PUT, then records the exchange-side stop-out exactly once as trailing_stop', async () => {
    const w = world();
    const { engine } = await openThroughEngine(w);

    const posts = w.ex.calls.filter((c) => c.method === 'POST').map((c) => c.body as Record<string, unknown>);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ ticker: T, side: 'bid', count: '1.00', time_in_force: 'immediate_or_cancel', reduce_only: false, subaccount: 3 });
    const puts = w.ex.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.body)).toEqual([{ kind: 'trailing', trail_bps: 388 }]);
    expect(loadPosition(w.db)).toMatchObject({ side: 'long', stopBps: 388, entryPrice: 13.76 });

    w.advance(MIN);
    w.ex.exchangeCloses('take_profit_stop_loss', 13.2);
    w.advance(MIN);
    await engine.tick();

    expect(listExits(w.db, 0).map((e) => [e.rule, e.side])).toEqual([['trailing_stop', 'long']]);
    expect(loadPosition(w.db)).toBeNull();
    expect(engine.status().position).toBeNull();
    expect(loadRiskState(w.db).cooldownUntilMs.long).toBe(w.now() + 24 * H);
    expect(loadRiskState(w.db).cooldownUntilMs.short).toBe(w.now() + 24 * H);
    const ev = listJournal(w.db, 'broker_event', 5).map((r) => r.payload as { kind: string; classifiedAs: string });
    expect(ev).toEqual([expect.objectContaining({ kind: 'stopped_out', classifiedAs: 'trailing_stop' })]);
    expect(w.alerts.join('\n')).toMatch(/stopped out long/);
    expect(w.alerts.join('\n')).not.toMatch(/closed outside the bot/);

    // No synthetic fallback later, no second exit.
    for (let i = 0; i < 15; i++) {
      w.advance(MIN);
      await engine.tick();
    }
    expect(listExits(w.db, 0)).toHaveLength(1);
    expect(w.ex.calls.filter((c) => c.method === 'POST')).toHaveLength(1); // cooling down: no re-entry
  });

  it('restart: a new broker over the same db reconciles consistent, watches, and later classifies a liquidation (not the synthetic stop-out)', async () => {
    const w = world();
    await openThroughEngine(w);
    const entryTimeMs = loadPosition(w.db)!.entryTimeMs;

    w.advance(5 * MIN); // the process restarts; the position is still open at the exchange
    const broker2 = w.newBroker();
    const engine2 = w.newEngine(broker2);
    await engine2.start();
    expect(listJournal(w.db, 'reconcile', 5).map((r) => (r.payload as { result: string }).result)).toEqual(['consistent']);
    expect(loadPosition(w.db)?.side).toBe('long');

    w.advance(MIN);
    await engine2.tick(); // still open: nothing to classify
    expect(listExits(w.db, 0)).toHaveLength(0);

    w.ex.exchangeCloses('liquidation', 10.8);
    w.advance(MIN);
    await engine2.tick();

    expect(listExits(w.db, 0).map((e) => [e.rule, e.side])).toEqual([['liquidated', 'long']]);
    expect(loadPosition(w.db)).toBeNull();
    expect(w.alerts.join('\n')).toMatch(/LIQUIDATED long/);
    expect(w.alerts.join('\n')).not.toMatch(/closed outside the bot/);
    const fillsQuery = w.ex.calls.filter((c) => c.path === '/margin/fills').at(-1)!.query;
    expect(fillsQuery).toMatchObject({ min_ts: Math.floor((entryTimeMs - 60_000) / 1000), subaccount: 3 });
    expect(listJournal(w.db, 'awaiting_exit_classification', 5)).toHaveLength(0);
  });
});
