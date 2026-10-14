import { describe, it, expect, vi } from 'vitest';
import {
  KalshiMarginBroker, OrderNotFilledError, StopNotSetError, type KalshiMarginBrokerConfig,
} from '../../src/perp/broker/kalshiMarginBroker.js';
import { MarginApiError } from '../../src/perp/broker/kalshiMarginClient.js';

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

function mk(handlers: Record<string, Handler>, over: Partial<KalshiMarginBrokerConfig> = {}, opts: { maxPollAttempts?: number } = {}) {
  const f = fakeClient(handlers);
  const broker = new KalshiMarginBroker(f.client, { ...cfg, ...over }, { now: () => 5000, newOrderId: () => 'cid-1', delay: async () => {}, ...opts });
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

const TRIG = `PUT /margin/isolated/positions/${T}/exit_trigger`;
const posReads = (calls: Recorded[]) => calls.filter((c) => c.method === 'GET' && c.path === '/margin/positions').length;
const finiteNumbers = (o: object) => Object.values(o).every((v) => typeof v !== 'number' || Number.isFinite(v));

describe('open: unknown order outcome (R10)', () => {
  const base = (extra: Record<string, Handler> = {}) => ({
    [`GET /margin/markets/${T}`]: () => market,
    [TRIG]: () => ({ id: 't1', status: 'active' }),
    ...extra,
  });
  // first positions read = the pre-open check (flat); later reads see the long position
  const flatThenLong = () => { let n = 0; return () => (n++ === 0 ? noPos : longPosition); };

  it('a POST timeout with a position on the exchange is treated as filled: stop is set, result built from the position', async () => {
    const { broker, calls } = mk(base({
      'POST /margin/orders': () => { throw new Error('timeout'); },
      'GET /margin/positions': flatThenLong(),
      'GET /margin/risk': () => risk,
    }));
    const fill = await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(fill).toEqual({ side: 'long', contracts: 1, price: 13.76, feeUsd: 0.001, tsMs: 5000 });
  });

  it('a POST failure with no position ever appearing throws OrderNotFilledError(positionMayBeOpen false)', async () => {
    const { broker, calls } = mk(base({
      'POST /margin/orders': () => { throw new Error('timeout'); },
      'GET /margin/positions': () => noPos,
    }));
    const e = await broker.open({ side: 'long', contracts: 1, stopBps: 388 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OrderNotFilledError);
    expect((e as OrderNotFilledError).positionMayBeOpen).toBe(false);
    expect(posReads(calls)).toBe(1 + 3);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a POST failure whose position reads also fail reports positionMayBeOpen true', async () => {
    let n = 0;
    const { broker } = mk(base({
      'POST /margin/orders': () => { throw new Error('timeout'); },
      'GET /margin/positions': () => { if (n++ === 0) return noPos; throw new Error('down'); },
    }));
    const e = await broker.open({ side: 'long', contracts: 1, stopBps: 388 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OrderNotFilledError);
    expect((e as OrderNotFilledError).positionMayBeOpen).toBe(true);
  });

  it.each([400, 409])('a definitive %i rejection is rethrown as-is and positions are not re-read', async (status) => {
    const rejection = new MarginApiError('rejected', status, 'x', null);
    const { broker, calls } = mk(base({
      'POST /margin/orders': () => { throw rejection; },
      'GET /margin/positions': () => noPos,
    }));
    await expect(broker.open({ side: 'long', contracts: 1, stopBps: 388 })).rejects.toBe(rejection);
    expect(posReads(calls)).toBe(1);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('a 500 MarginApiError is an unknown outcome: the position is re-read and protected', async () => {
    const { broker, calls } = mk(base({
      'POST /margin/orders': () => { throw new MarginApiError('boom', 500, 'x', null); },
      'GET /margin/positions': flatThenLong(),
      'GET /margin/risk': () => risk,
    }));
    await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('an unknown outcome whose stop is rejected flattens and throws StopNotSetError', async () => {
    let n = 0;
    const { broker, calls } = mk(base({
      'POST /margin/orders': () => { if (n++ === 0) throw new Error('timeout'); return filled('13.4000'); },
      [TRIG]: () => { throw new Error('409 conflict'); },
      'GET /margin/positions': flatThenLong(),
      'GET /margin/risk': () => risk,
      [`DELETE /margin/isolated/positions/${T}/exit_trigger`]: () => null,
    }));
    const e = await broker.open({ side: 'long', contracts: 1, stopBps: 388 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StopNotSetError);
    expect((e as StopNotSetError).positionMayBeOpen).toBe(false);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it("an unparseable fill_count with a position present is protected, not reported as 'no fill'", async () => {
    const { broker, calls } = mk(base({
      'POST /margin/orders': () => ({ order_id: 'o1', fill_count: 'garbage' }),
      'GET /margin/positions': flatThenLong(),
      'GET /margin/risk': () => risk,
    }));
    const fill = await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    expect(fill.contracts).toBe(1);
  });

  it('a NaN average price and fee fall back to the position entry price and fees; nothing is NaN', async () => {
    const { broker } = mk(base({
      'POST /margin/orders': () => ({ order_id: 'o1', fill_count: '1.00', remaining_count: '0.00' }),
      'GET /margin/positions': flatThenLong(),
      'GET /margin/risk': () => risk,
    }));
    const fill = await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    expect(fill.price).toBe(13.76);
    expect(fill.feeUsd).toBe(0.001);
    expect(finiteNumbers(fill)).toBe(true);
  });
});

describe('close: unknown order outcome and flatten failures (R10)', () => {
  const closeBase = (extra: Record<string, Handler> = {}) => ({
    [`GET /margin/markets/${T}`]: () => market,
    [`DELETE /margin/isolated/positions/${T}/exit_trigger`]: () => null,
    ...extra,
  });

  it('a close POST failure with the position gone is a close at a position-derived price, no NaN', async () => {
    let n = 0;
    const { broker } = mk(closeBase({
      'POST /margin/orders': () => { throw new Error('timeout'); },
      'GET /margin/positions': () => (n++ === 0 ? longPosition : noPos),
      'GET /margin/risk': () => risk,
    }));
    const r = await broker.close();
    expect(r.price).toBe(13.75);
    expect(finiteNumbers(r)).toBe(true);
  });

  it('a close POST failure with the position still there throws positionMayBeOpen true', async () => {
    const { broker } = mk(closeBase({
      'POST /margin/orders': () => { throw new Error('timeout'); },
      'GET /margin/positions': () => longPosition,
      'GET /margin/risk': () => risk,
    }));
    const e = await broker.close().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OrderNotFilledError);
    expect((e as OrderNotFilledError).positionMayBeOpen).toBe(true);
  });

  it('a NaN close fill price is never reported: it falls back to a position-derived price', async () => {
    const { broker } = mk(closeBase({
      'GET /margin/positions': () => longPosition,
      'GET /margin/risk': () => risk,
      'POST /margin/orders': () => ({ order_id: 'o1', fill_count: '1.00', remaining_count: '0.00' }),
    }));
    const r = await broker.close();
    expect(finiteNumbers(r)).toBe(true);
  });

  it('closeBestEffort retries: a lagging positions endpoint does not fail the flatten', async () => {
    let posN = 0;
    let orders = 0;
    const { broker } = mk({
      [`GET /margin/markets/${T}`]: () => market,
      [TRIG]: () => { throw new Error('409 conflict'); },
      'POST /margin/orders': () => { orders++; return filled(orders === 1 ? '13.7580' : '13.4000'); },
      // reads: 1 pre-open (flat), 2 first close attempt (still lagging, flat), 3 second attempt sees it
      'GET /margin/positions': () => (posN++ < 2 ? noPos : longPosition),
      'GET /margin/risk': () => risk,
      [`DELETE /margin/isolated/positions/${T}/exit_trigger`]: () => null,
    });
    const e = await broker.open({ side: 'long', contracts: 1, stopBps: 388 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StopNotSetError);
    expect((e as StopNotSetError).positionMayBeOpen).toBe(false);
    expect(orders).toBe(2);
  });

  it('stop rejected AND every close attempt fails: positionMayBeOpen true, and poll() later reports how the naked position ended', async () => {
    let pos: unknown = noPos;
    let posN = 0;
    let orderN = 0;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { broker } = mk({
        [`GET /margin/markets/${T}`]: () => market,
        [TRIG]: () => { throw new Error('409 conflict'); },
        'POST /margin/orders': () => { if (orderN++ === 0) return filled('13.7580'); throw new Error('500 down'); },
        'GET /margin/positions': () => (posN++ === 0 ? noPos : pos),
        'GET /margin/risk': () => risk,
        'GET /margin/fills': () => ({
          fills: [
            { fill_id: 'f1', order_id: 'o1', side: 'bid', count: '1.00', created_time: '2026-10-14T15:00:00Z', ticker: T, price: '13.7600', fees: '0.0010', realized_pnl: '0.0000' },
            { fill_id: 'f2', order_id: 'o9', side: 'ask', count: '1.00', created_time: '2026-10-14T16:00:00Z', ticker: T, price: '10.0000', fees: '0.0010', realized_pnl: '-3.7600' },
          ],
        }),
        'GET /margin/orders/o9': () => ({ order: { order_source: 'system', order_reason: 'liquidation' } }),
      });
      pos = longPosition;
      const e = await broker.open({ side: 'long', contracts: 1, stopBps: 388 }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StopNotSetError);
      expect((e as StopNotSetError).positionMayBeOpen).toBe(true);
      expect((e as Error).message).toMatch(/CLOSE FAILED/);
      pos = noPos;
      const events = await broker.poll();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'liquidated', side: 'long' });
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('poll: retry until classified (R11)', () => {
  const closingFills = {
    fills: [
      { fill_id: 'f1', order_id: 'o1', side: 'bid', count: '1.00', created_time: '2026-10-14T15:00:00Z', ticker: T, price: '13.7600', fees: '0.0010', realized_pnl: '0.0000' },
      { fill_id: 'f2', order_id: 'o2', side: 'ask', count: '1.00', created_time: '2026-10-14T16:00:00Z', ticker: T, price: '13.2000', fees: '0.0010', realized_pnl: '-0.5600' },
    ],
  };
  const openedFills = { fills: [closingFills.fills[0]] };
  const liquidationOrder = () => ({ order: { order_source: 'system', order_reason: 'liquidation' } });
  async function setup(h: { fills: Handler; order?: Handler }, maxPollAttempts?: number) {
    const { broker } = mk({
      'GET /margin/positions': () => noPos,
      [`GET /margin/markets/${T}`]: () => market,
      'POST /margin/orders': () => filled('13.7580'),
      [TRIG]: () => ({}),
      'GET /margin/fills': h.fills,
      'GET /margin/orders/o2': h.order ?? liquidationOrder,
    }, {}, { maxPollAttempts });
    await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    return broker;
  }

  it('a failed fills fetch returns [] and keeps expected; the next poll emits exactly one event', async () => {
    let n = 0;
    const broker = await setup({ fills: () => { if (n++ === 0) throw new Error('net'); return closingFills; } });
    expect(await broker.poll()).toEqual([]);
    const events = await broker.poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'liquidated' });
    expect(await broker.poll()).toEqual([]);
  });

  it('no closing fills yet returns [], then the event appears once the fills do', async () => {
    let n = 0;
    const broker = await setup({ fills: () => (n++ === 0 ? openedFills : closingFills) });
    expect(await broker.poll()).toEqual([]);
    expect((await broker.poll())[0]).toMatchObject({ kind: 'liquidated' });
  });

  it('fills that never appear fall back to closed_externally after maxPollAttempts', async () => {
    const broker = await setup({ fills: () => openedFills }, 3);
    expect(await broker.poll()).toEqual([]);
    expect(await broker.poll()).toEqual([]);
    expect(await broker.poll()).toEqual([{ kind: 'closed_externally', side: 'long', pnlUsd: null }]);
    expect(await broker.poll()).toEqual([]);
  });

  it('a failed order lookup retries and is then classified, not reported as closed_externally', async () => {
    let n = 0;
    const broker = await setup({ fills: () => closingFills, order: () => { if (n++ === 0) throw new Error('404'); return liquidationOrder(); } });
    expect(await broker.poll()).toEqual([]);
    expect((await broker.poll())[0]).toMatchObject({ kind: 'liquidated', rule: 'liquidated' });
  });

  it('an order lookup that keeps failing falls back to closed_externally with the pnl from the fills', async () => {
    const broker = await setup({ fills: () => closingFills, order: () => { throw new Error('404'); } }, 2);
    expect(await broker.poll()).toEqual([]);
    const ev = (await broker.poll())[0] as { kind: string; pnlUsd: number };
    expect(ev.kind).toBe('closed_externally');
    expect(ev.pnlUsd).toBeCloseTo(-0.56 - 0.002, 6);
  });
});

describe('serialisation (R9)', () => {
  it('two concurrent open() calls place exactly one order', async () => {
    let pos: unknown = noPos;
    const { broker, calls } = mk({
      'GET /margin/positions': () => pos,
      'GET /margin/risk': () => risk,
      [`GET /margin/markets/${T}`]: () => market,
      'POST /margin/orders': () => { pos = longPosition; return filled('13.7580'); },
      [TRIG]: () => ({}),
    });
    const params = { side: 'long' as const, contracts: 1, stopBps: 388 };
    const results = await Promise.allSettled([broker.open(params), broker.open(params)]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it("a poll racing the bot's own close() emits no spurious event", async () => {
    let pos: unknown = noPos;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let postStarted!: () => void;
    const started = new Promise<void>((r) => { postStarted = r; });
    let orders = 0;
    const { broker } = mk({
      'GET /margin/positions': () => pos,
      'GET /margin/risk': () => risk,
      [`GET /margin/markets/${T}`]: () => market,
      'POST /margin/orders': async () => {
        if (orders++ === 0) { pos = longPosition; return filled('13.7580'); }
        pos = noPos; // the exchange position is already gone while close() is still in flight
        postStarted();
        await gate;
        return filled('13.4000');
      },
      [TRIG]: () => ({}),
      [`DELETE /margin/isolated/positions/${T}/exit_trigger`]: () => null,
      'GET /margin/fills': () => ({
        fills: [
          { fill_id: 'f1', order_id: 'o1', side: 'bid', count: '1.00', created_time: '2026-10-14T15:00:00Z', ticker: T, price: '13.7600', fees: '0.0010', realized_pnl: '0.0000' },
          { fill_id: 'f2', order_id: 'o2', side: 'ask', count: '1.00', created_time: '2026-10-14T16:00:00Z', ticker: T, price: '13.4000', fees: '0.0010', realized_pnl: '-0.3600' },
        ],
      }),
      'GET /margin/orders/o2': () => ({ order: { order_source: 'user' } }),
    });
    await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    const closeP = broker.close();
    await started;
    const pollP = broker.poll();
    release();
    const [, events] = await Promise.all([closeP, pollP]);
    expect(events).toEqual([]);
  });
});

describe('watch: classify a position this instance did not open (W5)', () => {
  const exitFills = {
    fills: [
      { fill_id: 'f2', order_id: 'o7', side: 'ask', count: '1.00', created_time: '2026-10-14T16:00:00Z', ticker: T, price: '13.2000', fees: '0.0010', realized_pnl: '-0.5600' },
    ],
  };
  function restarted(reason: string) {
    let pos: unknown = longPosition;
    const f = mk({
      'GET /margin/positions': () => pos,
      'GET /margin/risk': () => risk,
      'GET /margin/fills': () => exitFills,
      'GET /margin/orders/o7': () => ({ order: { order_source: 'system', order_reason: reason } }),
    });
    return { ...f, vanish: () => { pos = noPos; } };
  }

  it.each([
    ['take_profit_stop_loss', 'stopped_out'],
    ['liquidation', 'liquidated'],
  ])('after watch(), a vanished position with a %s order is classified as %s', async (reason, kind) => {
    const r = restarted(reason);
    r.broker.watch('long', 1_000_000);
    expect(await r.broker.poll()).toEqual([]); // still open
    r.vanish();
    const events = await r.broker.poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind, side: 'long' });
    expect((events[0] as { pnlUsd: number }).pnlUsd).toBeCloseTo(-0.56 - 0.001, 6);
    const fillsCall = r.calls.find((c) => c.path === '/margin/fills')!;
    expect(fillsCall.query).toMatchObject({ min_ts: Math.floor((1_000_000 - 60_000) / 1000) });
    expect(await r.broker.poll()).toEqual([]); // reported once
  });

  it('without watch(), the same vanished position is never classified (poll returns [] forever)', async () => {
    const r = restarted('liquidation');
    r.vanish();
    for (let i = 0; i < 10; i++) expect(await r.broker.poll()).toEqual([]);
    expect(r.calls.some((c) => c.path === '/margin/fills')).toBe(false);
  });

  it('watch() never overwrites a pending expectation from the broker\'s own open', async () => {
    let pos: unknown = noPos;
    const { broker, calls } = mk({
      'GET /margin/positions': () => pos,
      'GET /margin/risk': () => risk,
      [`GET /margin/markets/${T}`]: () => market,
      'POST /margin/orders': () => { pos = longPosition; return filled('13.7580'); },
      [TRIG]: () => ({}),
      'GET /margin/fills': () => exitFills,
      'GET /margin/orders/o7': () => ({ order: { order_source: 'system', order_reason: 'take_profit_stop_loss' } }),
    });
    await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    broker.watch('short', 1_000_000);
    pos = noPos;
    const events = await broker.poll();
    expect(events[0]).toMatchObject({ kind: 'stopped_out', side: 'long' });
    expect(calls.find((c) => c.path === '/margin/fills')!.query).toMatchObject({ min_ts: Math.floor((5000 - 60_000) / 1000) });
  });
});
