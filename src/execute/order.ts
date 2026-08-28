import { createHash } from 'node:crypto';
import type { CreateOrderBody } from './kalshiClient.js';

/** Deterministic, UUID-shaped client_order_id from item_id alone -- never decision content, so a crash-and-redeliver that recomputes a different decision still submits the SAME id, letting Kalshi's own dedup and this project's reconciliation both work correctly. */
export function deriveClientOrderId(itemId: string): string {
  const hash = createHash('md5').update(itemId).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface OrderRequest {
  itemId: string;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
}

/**
 * Kalshi's book is expressed on the YES leg: buy YES -> side "bid" at the YES
 * price; buy NO -> side "ask" at the YES-equivalent price (100 - NO price).
 * Always an IOC order at the sized entry price -- see Global Constraints.
 */
export function buildOrderBody(order: OrderRequest): CreateOrderBody {
  const isYes = order.side === 'yes';
  const yesPriceCents = isYes ? order.entryPriceCents : 100 - order.entryPriceCents;
  return {
    ticker: order.marketTicker,
    side: isYes ? 'bid' : 'ask',
    count: String(order.contracts),
    price: (yesPriceCents / 100).toFixed(4),
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross',
    client_order_id: deriveClientOrderId(order.itemId),
  };
}
