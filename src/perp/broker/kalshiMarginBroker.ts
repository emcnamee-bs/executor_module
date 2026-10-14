// src/perp/broker/kalshiMarginBroker.ts
import { randomUUID } from 'node:crypto';
import type { Side } from '../types.js';
import { MarginApiError, type KalshiMarginClient } from './kalshiMarginClient.js';
import type {
  Broker, BrokerBalance, BrokerEvent, BrokerPosition, BrokerQuote, CloseResult, FillResult, OpenParams,
} from './types.js';

type Client = Pick<KalshiMarginClient, 'get' | 'post' | 'put' | 'del'>;

/**
 * The order was not (or not completely) filled. `positionMayBeOpen` is true whenever a close/flatten did not
 * definitely succeed or the outcome of the order could not be established: the caller must not assume it is flat.
 */
export class OrderNotFilledError extends Error {
  constructor(message: string, readonly positionMayBeOpen: boolean = false) {
    super(message);
    this.name = 'OrderNotFilledError';
  }
}

/** The trailing stop could not be set. `positionMayBeOpen` is true when the follow-up close did not definitely succeed. */
export class StopNotSetError extends Error {
  constructor(message: string, readonly positionMayBeOpen: boolean = false) {
    super(message);
    this.name = 'StopNotSetError';
  }
}

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

const fin = (x: number): boolean => Number.isFinite(x);
/** First finite value, else NaN. */
const firstFinite = (...xs: number[]): number => xs.find(fin) ?? NaN;

/** US500 taker fee fraction of notional (global constraints). Only used to estimate a fee the exchange response did not give us. */
const ESTIMATED_TAKER_FEE_FRAC = 0.000072;

const RECONCILE_ATTEMPTS = 3;
const defaultDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const RECONCILE_DELAY_MS = 300;

/** A definitive rejection: the exchange answered 4xx, so the order was not accepted. Anything else is an unknown outcome. */
const isDefinitiveRejection = (err: unknown): boolean =>
  err instanceof MarginApiError && err.status >= 400 && err.status < 500;

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

type OrderOutcome =
  /** avgPrice and feeUsd may be NaN when the response lacked them. */
  | { known: true; fillCount: number; avgPrice: number; feeUsd: number }
  /** The POST threw (timeout, network, 5xx, bad body) or fill_count was unparseable: the order may have filled. */
  | { known: false };

interface Expected {
  side: Side;
  openedAtMs: number;
  /** Failed attempts to obtain the exit fills / order reason so far. */
  attempts: number;
}

/** Perp bid/ask/mark from the margin market endpoint; throws when the quote is unusable. */
export async function fetchMarginQuote(client: Pick<KalshiMarginClient, 'get'>, ticker: string, nowMs: number): Promise<BrokerQuote> {
  const { market } = await client.get<{
    market: { bid?: string; ask?: string; price?: string; liquidation_mark_price?: { price?: string } };
  }>(`/margin/markets/${ticker}`);
  const bid = num(market.bid);
  const ask = num(market.ask);
  // Assumption to verify in Phase 0: stops and liquidation are evaluated on the liquidation mark price.
  const mark = num(market.liquidation_mark_price?.price ?? market.price);
  if (![bid, ask, mark].every(Number.isFinite) || bid <= 0 || ask <= 0) {
    throw new Error(`kalshi: unusable quote for ${ticker}`);
  }
  return { bid, ask, mark, tsMs: nowMs };
}

export class KalshiMarginBroker implements Broker {
  readonly mode: 'demo' | 'prod';
  private expected: Expected | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly newOrderId: () => string;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly maxPollAttempts: number;

  constructor(
    private readonly client: Client,
    private readonly cfg: KalshiMarginBrokerConfig,
    opts: {
      now?: () => number;
      newOrderId?: () => string;
      delay?: (ms: number) => Promise<void>;
      maxPollAttempts?: number;
    } = {}
  ) {
    this.mode = cfg.env;
    this.now = opts.now ?? (() => Date.now());
    this.newOrderId = opts.newOrderId ?? (() => randomUUID());
    this.delay = opts.delay ?? defaultDelay;
    this.maxPollAttempts = Math.max(1, opts.maxPollAttempts ?? 5);
  }

  /** Serialises open/close/poll/setTrailingStop. A rejection never blocks later calls. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private get subQuery(): { subaccount?: number } {
    return this.cfg.subaccount === null ? {} : { subaccount: this.cfg.subaccount };
  }

  async quote(): Promise<BrokerQuote> {
    return fetchMarginQuote(this.client, this.cfg.ticker, this.now());
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

  /**
   * Places one IOC order. Throws only for a definitive rejection (4xx). Any other failure of the POST, or an
   * unparseable fill_count, is an UNKNOWN outcome (the order may have filled) and is returned as `known: false`.
   */
  private async placeIoc(side: 'bid' | 'ask', count: number, price: number, reduceOnly: boolean): Promise<OrderOutcome> {
    let res: { order_id?: string; fill_count?: string; average_fill_price?: string; average_fee_paid?: string } | null;
    try {
      res = await this.client.post<{
        order_id?: string;
        fill_count?: string;
        average_fill_price?: string;
        average_fee_paid?: string;
      } | null>('/margin/orders', {
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
    } catch (err) {
      if (isDefinitiveRejection(err)) throw err;
      return { known: false };
    }
    const fillCount = num(res?.fill_count);
    if (!fin(fillCount)) return { known: false };
    const feePerContract = num(res?.average_fee_paid);
    return {
      known: true,
      fillCount,
      avgPrice: num(res?.average_fill_price),
      feeUsd: fin(feePerContract) ? feePerContract * fillCount : NaN,
    };
  }

  /** Re-reads the position (bounded retries) after an unknown order outcome. */
  private async findPosition(): Promise<{ pos: BrokerPosition | null; readFailed: boolean }> {
    let readFailed = false;
    for (let i = 0; i < RECONCILE_ATTEMPTS; i++) {
      if (i > 0) await this.delay(RECONCILE_DELAY_MS);
      try {
        const pos = await this.position();
        if (pos !== null) return { pos, readFailed };
      } catch {
        readFailed = true;
      }
    }
    return { pos: null, readFailed };
  }

  /** After an unknown close outcome: did the position go away? 'unknown' = it could never be read. */
  private async confirmFlat(): Promise<'flat' | 'open' | 'unknown'> {
    let state: 'open' | 'unknown' = 'unknown';
    for (let i = 0; i < RECONCILE_ATTEMPTS; i++) {
      if (i > 0) await this.delay(RECONCILE_DELAY_MS);
      try {
        if ((await this.position()) === null) return 'flat';
        state = 'open';
      } catch {
        // keep the previous state
      }
    }
    return state;
  }

  open(p: OpenParams): Promise<FillResult> {
    return this.locked(() => this.openInner(p));
  }

  private async openInner(p: OpenParams): Promise<FillResult> {
    if ((await this.position()) !== null) throw new Error('kalshi: a position is already open');
    const q = await this.quote();
    const buy = p.side === 'long';
    const limit = buy ? q.ask * (1 + this.cfg.slippageFrac) : q.bid * (1 - this.cfg.slippageFrac);
    const res = await this.placeIoc(buy ? 'bid' : 'ask', p.contracts, limit, false);

    let pos: BrokerPosition | null = null;
    let fillCount: number;
    if (!res.known) {
      // Unknown outcome: the exchange may have filled. Establish the truth from the position, never assume "no fill".
      const found = await this.findPosition();
      if (found.pos === null) {
        throw new OrderNotFilledError(
          `kalshi: ${p.side} order outcome unknown and no position found` + (found.readFailed ? ' (position reads failed)' : ''),
          found.readFailed
        );
      }
      if (found.pos.side !== p.side) {
        throw new OrderNotFilledError(`kalshi: unexpected ${found.pos.side} position after a ${p.side} order; position may be open`, true);
      }
      pos = found.pos;
      fillCount = pos.contracts;
    } else {
      fillCount = res.fillCount;
      if (fillCount <= 0) throw new OrderNotFilledError(`kalshi: ${p.side} order for ${p.contracts} contract(s) did not fill`, false);
      if (!fin(res.avgPrice) || !fin(res.feeUsd)) pos = (await this.findPosition()).pos;
    }

    if (fillCount < p.contracts) {
      // A partial fill cannot be left unprotected or half-sized: flatten what filled.
      const flat = await this.closeBestEffort(p.side);
      throw new OrderNotFilledError(
        `kalshi: partial fill ${fillCount} of ${p.contracts}; ${flat ? 'flattened' : 'FLATTEN FAILED, position may still be open'}`,
        !flat
      );
    }
    try {
      await this.setTrailingStopInner(p.stopBps);
    } catch (err) {
      const flat = await this.closeBestEffort(p.side);
      throw new StopNotSetError(
        `kalshi: trailing stop could not be set (${err instanceof Error ? err.message : String(err)}); ` +
          (flat ? 'position closed' : 'CLOSE FAILED, position may be open WITHOUT a stop'),
        !flat
      );
    }
    this.expected = { side: p.side, openedAtMs: this.now(), attempts: 0 };

    // Never emit NaN: fall back to the position, then (last resort) to the limit price and the taker fee estimate.
    const price = res.known ? firstFinite(res.avgPrice, pos?.entryPrice ?? NaN, limit) : firstFinite(pos?.entryPrice ?? NaN, limit);
    const feeUsd = res.known
      ? firstFinite(res.feeUsd, pos?.feesUsd ?? NaN, price * fillCount * ESTIMATED_TAKER_FEE_FRAC)
      : firstFinite(pos?.feesUsd ?? NaN, price * fillCount * ESTIMATED_TAKER_FEE_FRAC);
    return { side: p.side, contracts: fillCount, price, feeUsd, tsMs: this.now() };
  }

  /**
   * Flattens (up to 3 attempts, with a delay between). True only if the position was actually flattened.
   * When it definitively fails, the position is still ours: keep watching it so poll() reports how it ends.
   */
  private async closeBestEffort(side: Side): Promise<boolean> {
    let last = '';
    for (let i = 0; i < RECONCILE_ATTEMPTS; i++) {
      if (i > 0) await this.delay(RECONCILE_DELAY_MS);
      try {
        await this.closeInner();
        return true;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
    }
    console.error('[kalshi-broker] best-effort close failed:', last);
    this.expected = { side, openedAtMs: this.now(), attempts: 0 };
    return false;
  }

  close(): Promise<CloseResult> {
    return this.locked(() => this.closeInner());
  }

  private async closeInner(): Promise<CloseResult> {
    const pos = await this.position();
    if (pos === null) throw new Error('kalshi: no open position');
    const q = await this.quote();
    const sell = pos.side === 'long';
    const limit = sell ? q.bid * (1 - this.cfg.slippageFrac) : q.ask * (1 + this.cfg.slippageFrac);
    const res = await this.placeIoc(sell ? 'ask' : 'bid', pos.contracts, limit, true);
    const dir = pos.side === 'long' ? 1 : -1;
    const entryFees = fin(pos.feesUsd) ? pos.feesUsd : 0;

    let price: number;
    let feeUsd: number;
    let pnlUsd: number;
    if (!res.known) {
      const state = await this.confirmFlat();
      if (state !== 'flat') {
        throw new OrderNotFilledError(
          `kalshi: close order outcome unknown and the position ${state === 'open' ? 'is still open' : 'could not be read'}; position may be open`,
          true
        );
      }
      // The order response was lost, so the real exit price and fee are unknown. Approximation: exit at the
      // position's mark price (else the quote mid), taker fee estimated, P&L from the position's unrealized P&L.
      price = firstFinite(pos.markPrice, (q.bid + q.ask) / 2);
      feeUsd = price * pos.contracts * ESTIMATED_TAKER_FEE_FRAC;
      pnlUsd = firstFinite(pos.unrealizedPnlUsd - entryFees - feeUsd, (price - pos.entryPrice) * pos.contracts * dir - entryFees - feeUsd);
    } else {
      if (res.fillCount < pos.contracts) {
        throw new OrderNotFilledError(`kalshi: close filled ${res.fillCount} of ${pos.contracts}; position may be open`, true);
      }
      price = firstFinite(res.avgPrice, pos.markPrice, (q.bid + q.ask) / 2);
      feeUsd = fin(res.feeUsd) ? res.feeUsd : price * pos.contracts * ESTIMATED_TAKER_FEE_FRAC;
      pnlUsd = (price - pos.entryPrice) * pos.contracts * dir - entryFees - feeUsd;
      if (!fin(pnlUsd)) pnlUsd = pos.unrealizedPnlUsd - entryFees - feeUsd;
    }
    this.expected = null;
    await this.cancelTrigger();
    if (!fin(pnlUsd)) throw new Error('kalshi: position closed but its P&L could not be computed (non-numeric position data)');
    return { side: pos.side, contracts: pos.contracts, price, feeUsd, tsMs: this.now(), pnlUsd };
  }

  private triggerPath(): string {
    return `/margin/${this.cfg.triggerMode}/positions/${this.cfg.ticker}/exit_trigger`;
  }
  private triggerQuery(): { subaccount: number } | undefined {
    return this.cfg.triggerMode === 'cross' && this.cfg.subaccount !== null ? { subaccount: this.cfg.subaccount } : undefined;
  }

  setTrailingStop(stopBps: number): Promise<void> {
    return this.locked(() => this.setTrailingStopInner(stopBps));
  }

  private async setTrailingStopInner(stopBps: number): Promise<void> {
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

  poll(): Promise<BrokerEvent[]> {
    return this.locked(() => this.pollInner());
  }

  /** Classify the exit of a position this instance did not open (restart, adoption). A pending expectation wins. */
  watch(side: Side, sinceMs: number): void {
    if (this.expected === null) this.expected = { side, openedAtMs: sinceMs, attempts: 0 };
  }

  private async pollInner(): Promise<BrokerEvent[]> {
    const exp = this.expected;
    if (exp === null) return [];
    if ((await this.position()) !== null) return [];

    // `expected` is cleared only once the classification is complete. Until then a failure means "ask again next
    // poll"; after maxPollAttempts failures we give up and report a closed_externally event.
    const retry = (pnlUsd: number | null): BrokerEvent[] => {
      exp.attempts += 1;
      if (exp.attempts < this.maxPollAttempts) return [];
      this.expected = null;
      return [{ kind: 'closed_externally', side: exp.side, pnlUsd }];
    };

    let mine: FillDto[];
    try {
      const { fills } = await this.client.get<{ fills: FillDto[] }>('/margin/fills', {
        min_ts: Math.floor((exp.openedAtMs - 60_000) / 1000),
        limit: 100,
        ...this.subQuery,
      });
      mine = fills
        .filter((f) => f.ticker === this.cfg.ticker)
        .sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
    } catch {
      return retry(null);
    }
    const openSide = exp.side === 'long' ? 'bid' : 'ask';
    const closing = mine.filter((f) => f.side !== openSide);
    if (closing.length === 0) return retry(null);

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
      return retry(fin(pnlUsd) ? pnlUsd : null);
    }
    this.expected = null;
    if (reason === 'liquidation') return [{ kind: 'liquidated', rule: 'liquidated', side: exp.side, fill, pnlUsd }];
    if (reason === 'take_profit_stop_loss') return [{ kind: 'stopped_out', rule: 'trailing_stop', side: exp.side, fill, pnlUsd }];
    return [{ kind: 'closed_externally', side: exp.side, pnlUsd }];
  }
}
