import { describe, it, expect } from 'vitest';
import { deriveClientOrderId, buildOrderBody } from '../../src/execute/order.js';

describe('deriveClientOrderId', () => {
  it('is deterministic: the same itemId always produces the same id', () => {
    expect(deriveClientOrderId('item-123')).toBe(deriveClientOrderId('item-123'));
  });

  it('is UUID-shaped (matches Kalshi\'s expected client_order_id format)', () => {
    expect(deriveClientOrderId('item-123')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('differs for different itemIds', () => {
    expect(deriveClientOrderId('item-1')).not.toBe(deriveClientOrderId('item-2'));
  });
});

describe('buildOrderBody', () => {
  it('builds a YES order as a bid at entryPriceCents', () => {
    const body = buildOrderBody({
      itemId: 'item-1', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'yes', contracts: 83, entryPriceCents: 12,
    });
    expect(body).toEqual({
      ticker: 'KXAPRPOTUS-26AUG28-40.6',
      side: 'bid',
      count: '83',
      price: '0.1200',
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      client_order_id: deriveClientOrderId('item-1'),
    });
  });

  it('builds a NO order as an ask at the YES-equivalent price (100 - entryPriceCents)', () => {
    const body = buildOrderBody({
      itemId: 'item-2', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'no', contracts: 5, entryPriceCents: 42,
    });
    expect(body.side).toBe('ask');
    expect(body.price).toBe('0.5800'); // (100 - 42) / 100
    expect(body.count).toBe('5');
  });

  it('always sets IOC time_in_force and taker_at_cross self-trade prevention', () => {
    const body = buildOrderBody({ itemId: 'i', marketTicker: 'T', side: 'yes', contracts: 1, entryPriceCents: 50 });
    expect(body.time_in_force).toBe('immediate_or_cancel');
    expect(body.self_trade_prevention_type).toBe('taker_at_cross');
  });
});
