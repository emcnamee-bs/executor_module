// src/perp/broker/paper.ts
import type { Side } from '../types.js';
import type {
  Broker, BrokerBalance, BrokerEvent, BrokerPosition, BrokerQuote, CloseResult, FillResult, OpenParams,
} from './types.js';

export interface PaperConfig {
  startEquityUsd: number;
  /** Fraction of notional charged per fill. */
  takerFeeRate: number;
  maintenanceMargin: { long: number; short: number };
  initialMarginMultiplier: number;
  /** Positive funding rate: true = longs pay shorts (unverified on Kalshi; Phase 0 confirms). */
  fundingLongPays: boolean;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  startEquityUsd: 3.5,
  takerFeeRate: 0.000072,
  maintenanceMargin: { long: 0.0502, short: 0.056 },
  initialMarginMultiplier: 1.3,
  fundingLongPays: true,
};

export interface PaperPos {
  side: Side;
  contracts: number;
  entryPrice: number;
  /** Best mark since entry (highest for a long, lowest for a short). */
  extreme: number;
  stopBps: number;
  entryFeeUsd: number;
}

export interface PaperState {
  cash: number;
  pos: PaperPos | null;
}

/**
 * Simulated broker priced from live quotes. Fills at the touch (buy at the ask, sell at the bid); a stop-out
 * fills at the touch of the poll that first sees the mark through the stop level (so a gap is realistic);
 * a liquidation fills at the mark with no extra penalty (optimistic, noted in the runbook).
 */
export class PaperBroker implements Broker {
  readonly mode = 'paper' as const;
  /** Realized equity: start + realized P&L - fees - funding. */
  private cash: number;
  private pos: PaperPos | null = null;

  constructor(
    private readonly getQuote: () => Promise<BrokerQuote>,
    private readonly cfg: PaperConfig,
    private readonly now: () => number = () => Date.now()
  ) {
    this.cash = cfg.startEquityUsd;
  }

  private dir(side: Side): 1 | -1 {
    return side === 'long' ? 1 : -1;
  }
  private fee(price: number, contracts: number): number {
    return this.cfg.takerFeeRate * price * contracts;
  }
  private unrealized(mark: number): number {
    return this.pos === null ? 0 : (mark - this.pos.entryPrice) * this.pos.contracts * this.dir(this.pos.side);
  }

  quote(): Promise<BrokerQuote> {
    return this.getQuote();
  }

  async balance(): Promise<BrokerBalance> {
    const q = await this.quote();
    const equity = this.cash + this.unrealized(q.mark);
    const used =
      this.pos === null
        ? 0
        : this.cfg.initialMarginMultiplier * this.cfg.maintenanceMargin[this.pos.side] * this.pos.contracts * q.mark;
    return { equityUsd: equity, availableUsd: Math.max(0, equity - used) };
  }

  async position(): Promise<BrokerPosition | null> {
    const pos = this.pos;
    if (pos === null) return null;
    const q = await this.quote();
    const mm = this.cfg.maintenanceMargin[pos.side];
    const c = pos.contracts;
    // Price at which cash + unrealized == maintenance requirement (mm * price * contracts).
    const liqPrice =
      pos.side === 'long'
        ? (pos.entryPrice * c - this.cash) / (c * (1 - mm))
        : (this.cash + pos.entryPrice * c) / (c * (1 + mm));
    return {
      side: pos.side,
      contracts: c,
      entryPrice: pos.entryPrice,
      markPrice: q.mark,
      unrealizedPnlUsd: this.unrealized(q.mark),
      feesUsd: pos.entryFeeUsd,
      liqPrice,
      liqDistance: Math.abs(q.mark - liqPrice) / q.mark,
    };
  }

  async open(p: OpenParams): Promise<FillResult> {
    if (this.pos !== null) throw new Error('paper: a position is already open');
    if (!Number.isInteger(p.contracts) || p.contracts < 1) throw new Error('paper: contracts must be a positive integer');
    const q = await this.quote();
    // Re-check after the await: an overlapping open() may have won while the quote was in flight.
    if (this.pos !== null) throw new Error('paper: a position is already open');
    const price = p.side === 'long' ? q.ask : q.bid;
    const need = this.cfg.initialMarginMultiplier * this.cfg.maintenanceMargin[p.side] * price * p.contracts;
    if (this.cash < need) {
      throw new Error(`paper: insufficient margin: equity ${this.cash.toFixed(2)} < required ${need.toFixed(2)}`);
    }
    const fee = this.fee(price, p.contracts);
    this.cash -= fee;
    this.pos = { side: p.side, contracts: p.contracts, entryPrice: price, extreme: q.mark, stopBps: p.stopBps, entryFeeUsd: fee };
    return { side: p.side, contracts: p.contracts, price, feeUsd: fee, tsMs: this.now() };
  }

  private exitAt(price: number): CloseResult {
    const pos = this.pos;
    if (pos === null) throw new Error('paper: no open position');
    const gross = (price - pos.entryPrice) * pos.contracts * this.dir(pos.side);
    const fee = this.fee(price, pos.contracts);
    this.cash += gross - fee;
    this.pos = null;
    return { side: pos.side, contracts: pos.contracts, price, feeUsd: fee, tsMs: this.now(), pnlUsd: gross - fee - pos.entryFeeUsd };
  }

  async close(): Promise<CloseResult> {
    if (this.pos === null) throw new Error('paper: no open position');
    const q = await this.quote();
    // Re-read after the await: a concurrent poll() may have stopped the position out meanwhile.
    const pos = this.pos;
    if (pos === null) throw new Error('paper: no open position');
    return this.exitAt(pos.side === 'long' ? q.bid : q.ask);
  }

  async setTrailingStop(stopBps: number): Promise<void> {
    if (this.pos === null) throw new Error('paper: no open position');
    this.pos.stopBps = stopBps;
  }

  async poll(): Promise<BrokerEvent[]> {
    const q = await this.quote();
    const pos = this.pos;
    if (pos === null) return [];
    pos.extreme = pos.side === 'long' ? Math.max(pos.extreme, q.mark) : Math.min(pos.extreme, q.mark);

    const equity = this.cash + this.unrealized(q.mark);
    const maintenance = this.cfg.maintenanceMargin[pos.side] * q.mark * pos.contracts;
    if (equity <= maintenance) {
      const r = this.exitAt(q.mark);
      return [{ kind: 'liquidated', rule: 'liquidated', side: r.side, fill: r, pnlUsd: r.pnlUsd }];
    }
    const frac = pos.stopBps / 10_000;
    const hit = pos.side === 'long' ? q.mark <= pos.extreme * (1 - frac) : q.mark >= pos.extreme * (1 + frac);
    if (hit) {
      const r = this.exitAt(pos.side === 'long' ? q.bid : q.ask);
      return [{ kind: 'stopped_out', rule: 'trailing_stop', side: r.side, fill: r, pnlUsd: r.pnlUsd }];
    }
    return [];
  }

  /** No-op: the paper broker classifies every exit of its own simulated position in poll(). */
  watch(_side: Side, _sinceMs: number): void {
    // nothing to do
  }

  /** Serializable state, so a paper position and its cash survive a restart. */
  exportState(): PaperState {
    return { cash: this.cash, pos: this.pos === null ? null : { ...this.pos } };
  }

  importState(s: PaperState): void {
    this.cash = s.cash;
    this.pos = s.pos === null ? null : { ...s.pos };
  }

  /** Applies one funding settlement; returns USD charged (positive = paid, negative = received). */
  applyFunding(rate: number, markPrice: number): number {
    if (this.pos === null) return 0;
    const payerSign = (this.pos.side === 'long') === this.cfg.fundingLongPays ? 1 : -1;
    const charge = payerSign * rate * markPrice * this.pos.contracts;
    this.cash -= charge;
    return charge;
  }
}
