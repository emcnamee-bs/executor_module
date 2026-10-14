// src/perp/broker/kalshiMarginBroker.ts
import { randomUUID } from 'node:crypto';
import type { Side } from '../types.js';
import type { KalshiMarginClient } from './kalshiMarginClient.js';
import type {
  Broker, BrokerBalance, BrokerEvent, BrokerPosition, BrokerQuote, CloseResult, FillResult, OpenParams,
} from './types.js';

type Client = Pick<KalshiMarginClient, 'get' | 'post' | 'put' | 'del'>;

export class OrderNotFilledError extends Error {}
export class StopNotSetError extends Error {}

export interface KalshiMarginBrokerConfig {
  env: 'prod' | 'demo';
  ticker: string;
  /** null = primary subaccount (parameter omitted). */
  subaccount: number | null;
  triggerMode: 'isolated' | 'cross';
  /** IOC limit price padding, e.g. 0.002 = 20 bps through the touch. */
  slippageFrac: number;
}

/** Number from a Kalshi fixed-point string; NaN for missing or empty values. */
const num = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;

interface FillDto {
  order_id: string;
  side: 'bid' | 'ask';
  count: string;
  created_time: string;
  ticker: string;
  price: string;
  fees: string;
  realized_pnl: string;
}

export class KalshiMarginBroker implements Broker {
  readonly mode: 'demo' | 'prod';
  private expected: { side: Side; openedAtMs: number } | null = null;
  private readonly now: () => number;
  private readonly newOrderId: () => string;

  constructor(
    private readonly client: Client,
    private readonly cfg: KalshiMarginBrokerConfig,
    opts: { now?: () => number; newOrderId?: () => string } = {}
  ) {
    this.mode = cfg.env;
    this.now = opts.now ?? (() => Date.now());
    this.newOrderId = opts.newOrderId ?? (() => randomUUID());
  }

  private get subQuery(): { subaccount?: number } {
    return this.cfg.subaccount === null ? {} : { subaccount: this.cfg.subaccount };
  }

  async quote(): Promise<BrokerQuote> {
    const { market } = await this.client.get<{
      market: { bid?: string; ask?: string; price?: string; liquidation_mark_price?: { price?: string } };
    }>(`/margin/markets/${this.cfg.ticker}`);
    const bid = num(market.bid);
    const ask = num(market.ask);
    // Assumption to verify in Phase 0: stops and liquidation are evaluated on the liquidation mark price.
    const mark = num(market.liquidation_mark_price?.price ?? market.price);
    if (![bid, ask, mark].every(Number.isFinite) || bid <= 0 || ask <= 0) {
      throw new Error(`kalshi: unusable quote for ${this.cfg.ticker}`);
    }
    return { bid, ask, mark, tsMs: this.now() };
  }

  async balance(): Promise<BrokerBalance> {
    const r = await this.client.get<{ subaccount_balances: Array<{ subaccount: number; account_equity?: string; available_balance?: string }> }>('/margin/balance');
    const sub = this.cfg.subaccount ?? 0;
    const row = r.subaccount_balances.find((b) => b.subaccount === sub);
    if (row === undefined) throw new Error(`kalshi: no margin balance row for subaccount ${sub}`);
    return { equityUsd: num(row.account_equity), availableUsd: num(row.available_balance) };
  }

  async position(): Promise<BrokerPosition | null> {
    const { positions } = await this.client.get<{
      positions: Array<{ market_ticker: string; position: string; entry_price: string; unrealized_pnl: string; fees: string }>;
    }>('/margin/positions', { ticker: this.cfg.ticker, ...this.subQuery });
    const p = positions.find((x) => x.market_ticker === this.cfg.ticker && num(x.position) !== 0 && Number.isFinite(num(x.position)));
    if (p === undefined) return null;
    const qty = num(p.position);

    const risk = await this.client.get<{
      positions: Array<{ subaccount: number; market_ticker: string; mark_price?: string; estimated_liquidation_price?: string | null }>;
    }>('/margin/risk');
    const r = risk.positions.find(
      (x) => x.market_ticker === this.cfg.ticker && (this.cfg.subaccount === null || x.subaccount === this.cfg.subaccount)
    );
    const mark = num(r?.mark_price);
    const liqPrice = num(r?.estimated_liquidation_price);
    const haveLiq = Number.isFinite(liqPrice) && Number.isFinite(mark) && mark > 0;
    return {
      side: qty > 0 ? 'long' : 'short',
      contracts: Math.abs(qty),
      entryPrice: num(p.entry_price),
      markPrice: mark,
      unrealizedPnlUsd: num(p.unrealized_pnl),
      feesUsd: num(p.fees),
      liqPrice: haveLiq ? liqPrice : null,
      liqDistance: haveLiq ? Math.abs(mark - liqPrice) / mark : null,
    };
  }

  private async placeIoc(side: 'bid' | 'ask', count: number, price: number, reduceOnly: boolean) {
    const res = await this.client.post<{
      order_id: string;
      fill_count: string;
      average_fill_price?: string;
      average_fee_paid?: string;
    }>('/margin/orders', {
      ticker: this.cfg.ticker,
      client_order_id: this.newOrderId(),
      side,
      count: count.toFixed(2),
      price: price.toFixed(4),
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      reduce_only: reduceOnly,
      ...this.subQuery,
    });
    const fillCount = num(res.fill_count);
    const feePerContract = num(res.average_fee_paid);
    return {
      fillCount: Number.isFinite(fillCount) ? fillCount : 0,
      avgPrice: num(res.average_fill_price),
      feeUsd: Number.isFinite(feePerContract) ? feePerContract * (Number.isFinite(fillCount) ? fillCount : 0) : 0,
    };
  }

  async open(p: OpenParams): Promise<FillResult> {
    if ((await this.position()) !== null) throw new Error('kalshi: a position is already open');
    const q = await this.quote();
    const buy = p.side === 'long';
    const limit = buy ? q.ask * (1 + this.cfg.slippageFrac) : q.bid * (1 - this.cfg.slippageFrac);
    const res = await this.placeIoc(buy ? 'bid' : 'ask', p.contracts, limit, false);
    if (res.fillCount <= 0) throw new OrderNotFilledError(`kalshi: ${p.side} order for ${p.contracts} contract(s) did not fill`);
    if (res.fillCount < p.contracts) {
      // A partial fill cannot be left unprotected or half-sized: flatten what filled.
      const flat = await this.closeBestEffort();
      throw new OrderNotFilledError(
        `kalshi: partial fill ${res.fillCount} of ${p.contracts}; ${flat ? 'flattened' : 'FLATTEN FAILED, position may still be open'}`
      );
    }
    try {
      await this.setTrailingStop(p.stopBps);
    } catch (err) {
      const flat = await this.closeBestEffort();
      throw new StopNotSetError(
        `kalshi: trailing stop could not be set (${err instanceof Error ? err.message : String(err)}); ` +
          (flat ? 'position closed' : 'CLOSE FAILED, position may be open WITHOUT a stop')
      );
    }
    this.expected = { side: p.side, openedAtMs: this.now() };
    return { side: p.side, contracts: res.fillCount, price: res.avgPrice, feeUsd: res.feeUsd, tsMs: this.now() };
  }

  /** True only if the position was actually flattened. */
  private async closeBestEffort(): Promise<boolean> {
    try {
      await this.close();
      return true;
    } catch (err) {
      console.error('[kalshi-broker] best-effort close failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async close(): Promise<CloseResult> {
    const pos = await this.position();
    if (pos === null) throw new Error('kalshi: no open position');
    const q = await this.quote();
    const sell = pos.side === 'long';
    const limit = sell ? q.bid * (1 - this.cfg.slippageFrac) : q.ask * (1 + this.cfg.slippageFrac);
    const res = await this.placeIoc(sell ? 'ask' : 'bid', pos.contracts, limit, true);
    if (res.fillCount < pos.contracts) throw new OrderNotFilledError(`kalshi: close filled ${res.fillCount} of ${pos.contracts}`);
    const dir = pos.side === 'long' ? 1 : -1;
    const pnlUsd = (res.avgPrice - pos.entryPrice) * pos.contracts * dir - pos.feesUsd - res.feeUsd;
    this.expected = null;
    await this.cancelTrigger();
    return { side: pos.side, contracts: pos.contracts, price: res.avgPrice, feeUsd: res.feeUsd, tsMs: this.now(), pnlUsd };
  }

  private triggerPath(): string {
    return `/margin/${this.cfg.triggerMode}/positions/${this.cfg.ticker}/exit_trigger`;
  }
  private triggerQuery(): { subaccount: number } | undefined {
    return this.cfg.triggerMode === 'cross' && this.cfg.subaccount !== null ? { subaccount: this.cfg.subaccount } : undefined;
  }

  async setTrailingStop(stopBps: number): Promise<void> {
    const trail_bps = Math.min(9999, Math.max(1, Math.round(stopBps)));
    await this.client.put(this.triggerPath(), { kind: 'trailing', trail_bps }, this.triggerQuery());
  }

  private async cancelTrigger(): Promise<void> {
    try {
      await this.client.del(this.triggerPath(), this.triggerQuery());
    } catch {
      // The trigger may already be gone with the position; nothing to do.
    }
  }

  async poll(): Promise<BrokerEvent[]> {
    const exp = this.expected;
    if (exp === null) return [];
    if ((await this.position()) !== null) return [];
    this.expected = null;

    const { fills } = await this.client.get<{ fills: FillDto[] }>('/margin/fills', {
      min_ts: Math.floor((exp.openedAtMs - 60_000) / 1000),
      limit: 100,
      ...this.subQuery,
    });
    const mine = fills
      .filter((f) => f.ticker === this.cfg.ticker)
      .sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
    const openSide = exp.side === 'long' ? 'bid' : 'ask';
    const closing = mine.filter((f) => f.side !== openSide);
    if (closing.length === 0) return [{ kind: 'closed_externally', side: exp.side, pnlUsd: null }];

    const count = closing.reduce((s, f) => s + num(f.count), 0);
    const price = closing.reduce((s, f) => s + num(f.price) * num(f.count), 0) / count;
    const pnlUsd = closing.reduce((s, f) => s + num(f.realized_pnl), 0) - mine.reduce((s, f) => s + num(f.fees), 0);
    const last = closing[closing.length - 1];
    const fill: FillResult = {
      side: exp.side,
      contracts: count,
      price,
      feeUsd: closing.reduce((s, f) => s + num(f.fees), 0),
      tsMs: Date.parse(last.created_time),
    };
    let reason: string | undefined;
    try {
      const r = await this.client.get<{ order: { order_reason?: string } }>(`/margin/orders/${last.order_id}`);
      reason = r.order.order_reason;
    } catch {
      reason = undefined;
    }
    if (reason === 'liquidation') return [{ kind: 'liquidated', rule: 'liquidated', side: exp.side, fill, pnlUsd }];
    if (reason === 'take_profit_stop_loss') return [{ kind: 'stopped_out', rule: 'trailing_stop', side: exp.side, fill, pnlUsd }];
    return [{ kind: 'closed_externally', side: exp.side, pnlUsd }];
  }
}
