import { describe, it, expect } from 'vitest';
import { createBroker, resolveMode } from '../../src/perp/startup.js';
import { PaperBroker } from '../../src/perp/broker/paper.js';

const T = 'KXUS500PERP';
const demoEnv = { PERP_MODE: 'demo', PERP_SUBACCOUNT: '3', KALSHI_DEMO_API_KEY_ID: 'k', KALSHI_DEMO_PRIVATE_KEY_PATH: '/p' };

describe('resolveMode', () => {
  it('defaults to paper and ignores live/subaccount settings', () => {
    expect(resolveMode({}, T)).toEqual({ mode: 'paper', subaccount: null, marketTicker: T });
    expect(resolveMode({ PERP_LIVE: `${T}:3`, PERP_SUBACCOUNT: '3' }, T).mode).toBe('paper');
  });
  it('rejects an unknown mode', () => {
    expect(() => resolveMode({ PERP_MODE: 'real' }, T)).toThrow(/PERP_MODE/);
  });
  it('demo needs a subaccount 1-63 and demo credentials, and defaults the demo ticker to <ticker>1', () => {
    expect(resolveMode(demoEnv, T)).toEqual({ mode: 'demo', subaccount: 3, marketTicker: 'KXUS500PERP1' });
    expect(resolveMode({ ...demoEnv, PERP_DEMO_TICKER: 'OTHER' }, T).marketTicker).toBe('OTHER');
    for (const sub of [undefined, '0', '64', 'x', '1.5', '-1']) {
      expect(() => resolveMode({ ...demoEnv, PERP_SUBACCOUNT: sub }, T)).toThrow(/PERP_SUBACCOUNT/);
    }
    expect(() => resolveMode({ ...demoEnv, KALSHI_DEMO_API_KEY_ID: '' }, T)).toThrow(/KALSHI_DEMO_API_KEY_ID/);
  });
  it('live needs PERP_LIVE=<ticker>:<subaccount> exactly', () => {
    const live = { PERP_MODE: 'live', PERP_SUBACCOUNT: '3' };
    expect(() => resolveMode(live, T)).toThrow(/PERP_LIVE/);
    expect(() => resolveMode({ ...live, PERP_LIVE: 'KXUS500PERP:4' }, T)).toThrow(/PERP_LIVE/);
    expect(() => resolveMode({ ...live, PERP_LIVE: 'true' }, T)).toThrow(/PERP_LIVE/);
    expect(resolveMode({ ...live, PERP_LIVE: `${T}:3` }, T)).toEqual({ mode: 'live', subaccount: 3, marketTicker: T });
    expect(() => resolveMode({ ...live, PERP_SUBACCOUNT: '0', PERP_LIVE: `${T}:0` }, T)).toThrow(/PERP_SUBACCOUNT/);
  });
});

describe('createBroker', () => {
  const client = { get: async () => ({}), post: async () => ({}), put: async () => ({}), del: async () => ({}) } as never;
  it('paper: a PaperBroker with the configured starting equity', async () => {
    const quoteClient = { get: async () => ({ market: { bid: '13.75', ask: '13.76', price: '13.755' } }) } as never;
    const { broker, paper } = createBroker(resolveMode({}, T), { env: { PERP_PAPER_EQUITY_USD: '4.25' }, ticker: T, prodClient: quoteClient, demoClient: null, now: () => 1 });
    expect(broker.mode).toBe('paper');
    expect(paper).toBeInstanceOf(PaperBroker);
    expect((await broker.balance()).equityUsd).toBe(4.25);
  });
  it('paper: rejects a non-positive equity', () => {
    expect(() => createBroker(resolveMode({}, T), { env: { PERP_PAPER_EQUITY_USD: '0' }, ticker: T, prodClient: client, demoClient: null, now: () => 1 })).toThrow(/PERP_PAPER_EQUITY_USD/);
  });
  it('demo: a Kalshi broker on the demo client; refuses without one', () => {
    const { broker, paper } = createBroker(resolveMode(demoEnv, T), { env: demoEnv, ticker: T, prodClient: client, demoClient: client, now: () => 1 });
    expect(broker.mode).toBe('demo');
    expect(paper).toBeNull();
    expect(() => createBroker(resolveMode(demoEnv, T), { env: demoEnv, ticker: T, prodClient: client, demoClient: null, now: () => 1 })).toThrow(/demo client/);
  });
  it('live: a prod Kalshi broker', () => {
    const env = { PERP_MODE: 'live', PERP_SUBACCOUNT: '3', PERP_LIVE: `${T}:3` };
    expect(createBroker(resolveMode(env, T), { env, ticker: T, prodClient: client, demoClient: null, now: () => 1 }).broker.mode).toBe('prod');
  });
  it('rejects a bad trigger mode or slippage', () => {
    const env = { ...demoEnv, PERP_TRIGGER_MODE: 'weird' };
    expect(() => createBroker(resolveMode(env, T), { env, ticker: T, prodClient: client, demoClient: client, now: () => 1 })).toThrow(/PERP_TRIGGER_MODE/);
    const env2 = { ...demoEnv, PERP_SLIPPAGE_FRAC: '2' };
    expect(() => createBroker(resolveMode(env2, T), { env: env2, ticker: T, prodClient: client, demoClient: client, now: () => 1 })).toThrow(/PERP_SLIPPAGE_FRAC/);
  });
});
