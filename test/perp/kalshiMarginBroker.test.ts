import { describe, it, expect, vi } from 'vitest';
import {
  KalshiMarginBroker, OrderNotFilledError, StopNotSetError, type KalshiMarginBrokerConfig,
} from '../../src/perp/broker/kalshiMarginBroker.js';

type Handler = (query?: Record<string, unknown>, body?: unknown) => unknown;
interface Recorded { method: string; path: string; query?: Record<string, unknown>; body?: unknown }

function fakeClient(handlers: Record<string, Handler>) {
  const calls: Recorded[] = [];
  const run = (method: string) => async (path: string, a?: unknown, b?: unknown) => {
    const isBody = method === 'POST' || method === 'PUT';
    const rec: Recorded = { method, path, body: isBody ? a : undefined, query: (isBody ? b : a) as Record<string, unknown> | undefined };
    calls.push(rec);
    const h = handlers[`${method} ${path}`];
    if (!h) throw new Error(`unscripted call: ${method} ${path}`);
    return h(rec.query, rec.body);
  };
  return { client: { get: run('GET'), post: run('POST'), put: run('PUT'), del: run('DELETE') } as never, calls };
}

const cfg: KalshiMarginBrokerConfig = { env: 'demo', ticker: 'KXUS500PERP1', subaccount: 3, triggerMode: 'isolated', slippageFrac: 0.002 };
const T = 'KXUS500PERP1';
const market = { market: { bid: '13.7568', ask: '13.7576', price: '13.7576', liquidation_mark_price: { price: '13.7571', ts_ms: 1 } } };
const noPos = { positions: [] };
const longPosition = { positions: [{ subaccount: 3, market_ticker: T, position: '1.00', entry_price: '13.7600', unrealized_pnl: '-0.0100', fees: '0.0010', is_portfolio: false }] };
const risk = { total_position_notional: '13.76', total_maintenance_margin: '0.69', positions: [{ subaccount: 3, market_ticker: T, position: '1.00', mark_price: '13.7500', position_notional: '13.75', estimated_liquidation_price: '10.8000', is_portfolio: false }] };
const filled = (price: string, fee = '0.0010') => ({ order_id: 'o1', fill_count: '1.00', remaining_count: '0.00', average_fill_price: price, average_fee_paid: fee });

function mk(handlers: Record<string, Handler>, over: Partial<KalshiMarginBrokerConfig> = {}) {
  const f = fakeClient(handlers);
  const broker = new KalshiMarginBroker(f.client, { ...cfg, ...over }, { now: () => 5000, newOrderId: () => 'cid-1' });
  return { broker, calls: f.calls };
}

describe('quote / balance / position', () => {
  it('quote parses string prices and prefers the liquidation mark', async () => {
    const { broker } = mk({ [`GET /margin/markets/${T}`]: () => market });
    expect(await broker.quote()).toEqual({ bid: 13.7568, ask: 13.7576, mark: 13.7571, tsMs: 5000 });
  });
  it('quote rejects an unusable market', async () => {
    const { broker } = mk({ [`GET /margin/markets/${T}`]: () => ({ market: { bid: '', ask: '0.0000', price: '13.7' } }) });
    await expect(broker.quote()).rejects.toThrow(/unusable quote/);
  });
  it('balance picks the configured subaccount', async () => {
    const bal = { subaccount_balances: [{ subaccount: 0, account_equity: '99' }, { subaccount: 3, account_equity: '3.50', available_balance: '2.10' }] };
    const { broker } = mk({ 'GET /margin/balance': () => bal });
    expect(await broker.balance()).toEqual({ equityUsd: 3.5, availableUsd: 2.1 });
  });
  it('position maps size sign to side and uses the risk endpoint for liquidation', async () => {
    const { broker } = mk({ 'GET /margin/positions': () => longPosition, 'GET /margin/risk': () => risk });
    const p = await broker.position();
    expect(p).toMatchObject({ side: 'long', contracts: 1, entryPrice: 13.76, markPrice: 13.75, feesUsd: 0.001, liqPrice: 10.8 });
    expect(p?.liqDistance).toBeCloseTo((13.75 - 10.8) / 13.75, 6);
  });
  it('position is null when flat and short when the size is negative', async () => {
    expect(await mk({ 'GET /margin/positions': () => noPos }).broker.position()).toBeNull();
    const short = { positions: [{ ...longPosition.positions[0], position: '-1.00' }] };
    const { broker } = mk({ 'GET /margin/positions': () => short, 'GET /margin/risk': () => ({ ...risk, positions: [] }) });
    const p = await broker.position();
    expect(p?.side).toBe('short');
    expect(p?.liqPrice).toBeNull();
    expect(p?.liqDistance).toBeNull();
  });
});

describe('open', () => {
  const base = (extra: Record<string, Handler> = {}) => ({
    'GET /margin/positions': () => noPos,
    [`GET /margin/markets/${T}`]: () => market,
    'POST /margin/orders': () => filled('13.7580'),
    [`PUT /margin/isolated/positions/${T}/exit_trigger`]: () => ({ id: 't1', status: 'active' }),
    ...extra,
  });

  it('places an IOC buy at ask*(1+slip), then sets the trailing stop', async () => {
    const { broker, calls } = mk(base());
    const fill = await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    const order = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(order).toMatchObject({
      ticker: T, side: 'bid', count: '1.00', time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross', reduce_only: false, subaccount: 3, client_order_id: 'cid-1',
    });
    expect(order.price).toBe((13.7576 * 1.002).toFixed(4));
    const trig = calls.find((c) => c.method === 'PUT')!;
    expect(trig.body).toEqual({ kind: 'trailing', trail_bps: 388 });
    expect(fill).toMatchObject({ side: 'long', contracts: 1, price: 13.758, feeUsd: 0.001 });
  });

  it('a short sells at bid*(1-slip)', async () => {
    const { broker, calls } = mk(base());
    await broker.open({ side: 'short', contracts: 1, stopBps: 388 });
    const order = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(order.side).toBe('ask');
    expect(order.price).toBe((13.7568 * 0.998).toFixed(4));
  });

  it('refuses to open when a position already exists', async () => {
    const { broker } = mk(base({ 'GET /margin/positions': () => longPosition, 'GET /margin/risk': () => risk }));
    await expect(broker.open({ side: 'long', contracts: 1, stopBps: 388 })).rejects.toThrow(/already open/);
  });

  it('a zero fill throws OrderNotFilledError and sets no stop (review focus 2)', async () => {
    const { broker, calls } = mk(base({ 'POST /margin/orders': () => ({ order_id: 'o1', fill_count: '0.00', remaining_count: '0.00' }) }));
    await expect(broker.open({ side: 'long', contracts: 1, stopBps: 388 })).rejects.toBeInstanceOf(OrderNotFilledError);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('if the stop is rejected it closes the position and throws StopNotSetError (review focus 1)', async () => {
    let posCalls = 0;
    const { broker, calls } = mk(base({
      [`PUT /margin/isolated/positions/${T}/exit_trigger`]: () => { throw new Error('409 conflict'); },
      'GET /margin/positions': () => (posCalls++ === 0 ? noPos : longPosition),
      'GET /margin/risk': () => risk,
    }));
    await expect(broker.open({ side: 'long', contracts: 1, stopBps: 388 })).rejects.toBeInstanceOf(StopNotSetError);
    const orders = calls.filter((c) => c.method === 'POST').map((c) => c.body as Record<string, unknown>);
    expect(orders).toHaveLength(2);
    expect(orders[1]).toMatchObject({ side: 'ask', reduce_only: true });
  });

  it('a partial fill is flattened and reported as not filled', async () => {
    let posCalls = 0;
    const { broker, calls } = mk(base({
      'POST /margin/orders': () => ({ order_id: 'o1', fill_count: '1.00', remaining_count: '1.00', average_fill_price: '13.7580', average_fee_paid: '0.0010' }),
      'GET /margin/positions': () => (posCalls++ === 0 ? noPos : longPosition),
      'GET /margin/risk': () => risk,
    }));
    await expect(broker.open({ side: 'long', contracts: 2, stopBps: 388 })).rejects.toBeInstanceOf(OrderNotFilledError);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const orders = calls.filter((c) => c.method === 'POST').map((c) => c.body as Record<string, unknown>);
    expect(orders).toHaveLength(2);
    expect(orders[1]).toMatchObject({ side: 'ask', reduce_only: true });
  });

  it('if the stop is rejected AND the close fails, the error says the position may be unprotected', async () => {
    let posCalls = 0;
    let orderCalls = 0;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { broker } = mk(base({
        [`PUT /margin/isolated/positions/${T}/exit_trigger`]: () => { throw new Error('409 conflict'); },
        'POST /margin/orders': () => {
          if (orderCalls++ === 0) return filled('13.7580');
          throw new Error('500 down');
        },
        'GET /margin/positions': () => (posCalls++ === 0 ? noPos : longPosition),
        'GET /margin/risk': () => risk,
      }));
      const e = await broker.open({ side: 'long', contracts: 1, stopBps: 388 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StopNotSetError);
      expect((e as Error).message).toMatch(/CLOSE FAILED/);
      expect((e as Error).message).not.toMatch(/position closed/);
    } finally {
      err.mockRestore();
    }
  });
});

describe('close, setTrailingStop', () => {
  it('closes reduce-only, computes P&L after all fees, and cancels the trigger', async () => {
    const { broker, calls } = mk({
      'GET /margin/positions': () => longPosition,
      'GET /margin/risk': () => risk,
      [`GET /margin/markets/${T}`]: () => market,
      'POST /margin/orders': () => filled('13.4000', '0.0010'),
      [`DELETE /margin/isolated/positions/${T}/exit_trigger`]: () => null,
    });
    const r = await broker.close();
    const order = calls.find((c) => c.method === 'POST')!.body as Record<string, unknown>;
    expect(order).toMatchObject({ side: 'ask', reduce_only: true, count: '1.00' });
    expect(r.pnlUsd).toBeCloseTo(13.4 - 13.76 - 0.001 - 0.001, 6);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('setTrailingStop clamps to 1..9999 bps and uses the cross path with a subaccount when configured', async () => {
    const iso = mk({ [`PUT /margin/isolated/positions/${T}/exit_trigger`]: () => ({}) });
    await iso.broker.setTrailingStop(0);
    await iso.broker.setTrailingStop(20000);
    expect(iso.calls.map((c) => (c.body as { trail_bps: number }).trail_bps)).toEqual([1, 9999]);

    const cross = mk({ [`PUT /margin/cross/positions/${T}/exit_trigger`]: () => ({}) }, { triggerMode: 'cross' });
    await cross.broker.setTrailingStop(388.4);
    expect(cross.calls[0].query).toEqual({ subaccount: 3 });
    expect((cross.calls[0].body as { trail_bps: number }).trail_bps).toBe(388);
  });
});

describe('poll (review focus 3)', () => {
  const fills = (orderId: string) => ({
    fills: [
      { fill_id: 'f1', order_id: 'o1', side: 'bid', count: '1.00', created_time: '2026-10-14T15:00:00Z', ticker: T, price: '13.7600', entry_price: '13.7600', fees: '0.0010', realized_pnl: '0.0000' },
      { fill_id: 'f2', order_id: orderId, side: 'ask', count: '1.00', created_time: '2026-10-14T16:00:00Z', ticker: T, price: '13.2000', entry_price: '13.7600', fees: '0.0010', realized_pnl: '-0.5600' },
    ],
  });
  async function opened(orderReason: string | undefined, orderId = 'o2') {
    let pos: unknown = noPos;
    const { broker } = mk({
      'GET /margin/positions': () => pos,
      [`GET /margin/markets/${T}`]: () => market,
      'POST /margin/orders': () => filled('13.7580'),
      [`PUT /margin/isolated/positions/${T}/exit_trigger`]: () => ({}),
      'GET /margin/fills': () => fills(orderId),
      [`GET /margin/orders/${orderId}`]: () => ({ order: orderReason === undefined ? { order_source: 'user' } : { order_source: 'system', order_reason: orderReason } }),
    });
    await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    pos = noPos;
    return broker;
  }

  it('returns nothing while no position was opened or it is still open', async () => {
    expect(await mk({}).broker.poll()).toEqual([]);
  });
  it('classifies a take_profit_stop_loss system order as a trailing-stop exit', async () => {
    const events = await (await opened('take_profit_stop_loss')).poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'stopped_out', rule: 'trailing_stop', side: 'long' });
    expect((events[0] as { pnlUsd: number }).pnlUsd).toBeCloseTo(-0.56 - 0.002, 6);
  });
  it('classifies a liquidation system order as liquidated', async () => {
    expect((await (await opened('liquidation')).poll())[0]).toMatchObject({ kind: 'liquidated', rule: 'liquidated' });
  });
  it('classifies a user order as closed_externally, and reports each loss only once', async () => {
    const broker = await opened(undefined);
    expect((await broker.poll())[0]).toMatchObject({ kind: 'closed_externally', side: 'long' });
    expect(await broker.poll()).toEqual([]);
  });
});
