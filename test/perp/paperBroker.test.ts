import { describe, it, expect } from 'vitest';
import { DEFAULT_PAPER_CONFIG, PaperBroker } from '../../src/perp/broker/paper.js';
import type { BrokerQuote } from '../../src/perp/broker/types.js';

function harness(over: Partial<typeof DEFAULT_PAPER_CONFIG> = {}) {
  const state = { q: { bid: 13.75, ask: 13.76, mark: 13.755, tsMs: 1000 } as BrokerQuote };
  const broker = new PaperBroker(async () => state.q, { ...DEFAULT_PAPER_CONFIG, ...over }, () => 1000);
  const setMark = (mark: number) => {
    state.q = { bid: mark - 0.005, ask: mark + 0.005, mark, tsMs: 2000 };
  };
  return { broker, setMark };
}

describe('PaperBroker basics', () => {
  it('opens a long at the ask, pays the taker fee, and reports the position', async () => {
    const { broker } = harness();
    const fill = await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    expect(fill.price).toBe(13.76);
    expect(fill.feeUsd).toBeCloseTo(0.000072 * 13.76, 8);
    const pos = await broker.position();
    expect(pos?.side).toBe('long');
    expect(pos?.entryPrice).toBe(13.76);
    expect(pos?.liqPrice).toBeGreaterThan(10);
    expect(pos?.liqPrice).toBeLessThan(11);
    expect(pos?.liqDistance).toBeGreaterThan(0.15);
    const bal = await broker.balance();
    expect(bal.equityUsd).toBeCloseTo(3.5 - 0.000072 * 13.76 + (13.755 - 13.76), 6);
  });

  it('opens a short at the bid and closes at the ask with realized P&L after both fees', async () => {
    const { broker, setMark } = harness();
    await broker.open({ side: 'short', contracts: 1, stopBps: 388 });
    setMark(13.5); // ask 13.505
    const r = await broker.close();
    expect(r.price).toBe(13.505);
    expect(r.pnlUsd).toBeCloseTo(13.75 - 13.505 - 0.000072 * 13.75 - 0.000072 * 13.505, 6);
    expect(await broker.position()).toBeNull();
  });

  it('refuses a second position, zero contracts, and insufficient margin', async () => {
    const { broker } = harness();
    await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    await expect(broker.open({ side: 'long', contracts: 1, stopBps: 388 })).rejects.toThrow(/already open/);
    const b2 = harness().broker;
    await expect(b2.open({ side: 'long', contracts: 0, stopBps: 388 })).rejects.toThrow(/contracts/);
    const poor = harness({ startEquityUsd: 0.5 }).broker;
    await expect(poor.open({ side: 'long', contracts: 1, stopBps: 388 })).rejects.toThrow(/margin/);
  });

  it('close() without a position throws', async () => {
    await expect(harness().broker.close()).rejects.toThrow(/no open position/);
  });
});

describe('PaperBroker trailing stop and liquidation', () => {
  it('trails a long up and stops out when the mark falls stopBps below the watermark', async () => {
    const { broker, setMark } = harness();
    await broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    setMark(14.0);
    expect(await broker.poll()).toEqual([]);
    setMark(13.46); // stop level 14.0 * (1 - 0.0388) = 13.4568, not yet hit
    expect(await broker.poll()).toEqual([]);
    setMark(13.45);
    const events = await broker.poll();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('stopped_out');
    if (events[0].kind === 'stopped_out') {
      expect(events[0].fill.price).toBeCloseTo(13.445, 6); // sold at the bid
      expect(events[0].pnlUsd).toBeCloseTo(13.445 - 13.76 - 0.000072 * 13.445 - 0.000072 * 13.76, 6);
    }
    expect(await broker.position()).toBeNull();
    expect(await broker.poll()).toEqual([]);
  });

  it('trails a short down and stops out when the mark rises stopBps above the low-water mark', async () => {
    const { broker, setMark } = harness();
    await broker.open({ side: 'short', contracts: 1, stopBps: 388 });
    setMark(13.0);
    expect(await broker.poll()).toEqual([]);
    setMark(13.51); // stop level 13.0 * 1.0388 = 13.5044
    const events = await broker.poll();
    expect(events[0]?.kind).toBe('stopped_out');
    if (events[0]?.kind === 'stopped_out') expect(events[0].fill.price).toBeCloseTo(13.515, 6); // bought at the ask
  });

  it('setTrailingStop changes the trigger distance', async () => {
    const { broker, setMark } = harness();
    await broker.open({ side: 'long', contracts: 1, stopBps: 9999 });
    await broker.setTrailingStop(100);
    setMark(13.5); // 1% below 13.755 -> stop hit
    expect((await broker.poll())[0]?.kind).toBe('stopped_out');
  });

  it('liquidates when equity falls to the maintenance requirement, before a wide stop', async () => {
    const { broker, setMark } = harness();
    await broker.open({ side: 'long', contracts: 1, stopBps: 9999 });
    setMark(10.9);
    expect(await broker.poll()).toEqual([]); // equity ~0.64 > maintenance ~0.55
    setMark(10.5);
    const events = await broker.poll();
    expect(events[0]?.kind).toBe('liquidated');
    const bal = await broker.balance();
    expect(bal.equityUsd).toBeCloseTo(0.238, 2);
  });
});

describe('PaperBroker funding', () => {
  it('charges longs and credits shorts when the rate is positive and longs pay', async () => {
    const a = harness();
    await a.broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    const before = (await a.broker.balance()).equityUsd;
    expect(a.broker.applyFunding(0.0003, 13.76)).toBeCloseTo(0.0003 * 13.76, 8);
    expect((await a.broker.balance()).equityUsd).toBeCloseTo(before - 0.0003 * 13.76, 8);

    const b = harness();
    await b.broker.open({ side: 'short', contracts: 1, stopBps: 388 });
    expect(b.broker.applyFunding(0.0003, 13.76)).toBeCloseTo(-0.0003 * 13.76, 8);
  });
  it('is a no-op when flat', () => {
    expect(harness().broker.applyFunding(0.001, 13.76)).toBe(0);
  });
});

describe('PaperBroker concurrency (quote in flight)', () => {
  /** getQuote that, while `hold` is true, returns a promise the test resolves by hand. */
  function gated() {
    const live: BrokerQuote = { bid: 13.75, ask: 13.76, mark: 13.755, tsMs: 1000 };
    const pending: Array<(q: BrokerQuote) => void> = [];
    const state = { hold: false };
    const getQuote = (): Promise<BrokerQuote> =>
      state.hold ? new Promise<BrokerQuote>((res) => pending.push(res)) : Promise.resolve(live);
    const broker = new PaperBroker(getQuote, { ...DEFAULT_PAPER_CONFIG }, () => 1000);
    return { broker, live, pending, state };
  }

  it('two overlapping open() calls: exactly one succeeds, the fee is charged once', async () => {
    const { broker, live, pending, state } = gated();
    state.hold = true;
    const a = broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    const b = broker.open({ side: 'long', contracts: 1, stopBps: 388 });
    expect(pending).toHaveLength(2); // both passed the guard and are awaiting their quote
    pending[0](live);
    pending[1](live);
    const [ra, rb] = await Promise.allSettled([a, b]);
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('rejected');
    if (rb.status === 'rejected') expect(String(rb.reason)).toMatch(/already open/);
    state.hold = false;
    const bal = await broker.balance();
    expect(bal.equityUsd).toBeCloseTo(3.5 - 0.000072 * 13.76 + (13.755 - 13.76), 8);
    expect((await broker.position())?.feesUsd).toBeCloseTo(0.000072 * 13.76, 8);
  });

  it('close() whose quote is in flight while poll() stops the position out rejects cleanly', async () => {
    const { broker, live, pending, state } = gated();
    await broker.open({ side: 'long', contracts: 1, stopBps: 100 });
    state.hold = true;
    const closing = broker.close(); // awaiting quote #0
    const polling = broker.poll(); // awaiting quote #1
    expect(pending).toHaveLength(2);
    pending[1]({ bid: 13.495, ask: 13.505, mark: 13.5, tsMs: 2000 }); // 1% below 13.755 -> stop fires
    const events = await polling;
    expect(events[0]?.kind).toBe('stopped_out');
    pending[0](live);
    const r = await Promise.allSettled([closing]);
    expect(r[0].status).toBe('rejected');
    if (r[0].status === 'rejected') {
      expect(r[0].reason).toBeInstanceOf(Error);
      expect(String(r[0].reason)).toMatch(/no open position/);
      expect(r[0].reason).not.toBeInstanceOf(TypeError);
    }
  });
});
