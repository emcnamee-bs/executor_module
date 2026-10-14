// src/perp/broker/types.ts
import type { Side } from '../types.js';

export interface BrokerQuote {
  bid: number;
  ask: number;
  mark: number;
  tsMs: number;
}

export interface FillResult {
  side: Side;
  contracts: number;
  price: number;
  feeUsd: number;
  tsMs: number;
}

export interface CloseResult extends FillResult {
  /** Realized P&L of the whole trade after all fees. */
  pnlUsd: number;
}

export interface BrokerPosition {
  side: Side;
  contracts: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnlUsd: number;
  /** Fees accumulated over the life of the open position. */
  feesUsd: number;
  liqPrice: number | null;
  /** |mark - liqPrice| / mark, or null when unknown. */
  liqDistance: number | null;
}

export interface BrokerBalance {
  equityUsd: number;
  availableUsd: number;
}

export interface OpenParams {
  side: Side;
  contracts: number;
  /** Exchange-side trailing stop distance in basis points of the watermark. */
  stopBps: number;
}

export type BrokerEvent =
  | { kind: 'stopped_out'; rule: 'trailing_stop'; side: Side; fill: FillResult; pnlUsd: number }
  | { kind: 'liquidated'; rule: 'liquidated'; side: Side; fill: FillResult; pnlUsd: number }
  | { kind: 'closed_externally'; side: Side; pnlUsd: number | null };

export interface Broker {
  readonly mode: 'paper' | 'demo' | 'prod';
  quote(): Promise<BrokerQuote>;
  position(): Promise<BrokerPosition | null>;
  balance(): Promise<BrokerBalance>;
  /** Opens the position AND sets the trailing stop. If the stop cannot be set the position is closed again and an error is thrown. */
  open(p: OpenParams): Promise<FillResult>;
  close(): Promise<CloseResult>;
  setTrailingStop(stopBps: number): Promise<void>;
  /** Detects stop-outs, liquidations and external closes since the last call. */
  poll(): Promise<BrokerEvent[]>;
}
