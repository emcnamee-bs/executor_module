// src/perp/collectors/perpMarket.ts
import type { Snapshot } from '../types.js';

interface Getter {
  get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
}

const num = (v: unknown): number =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;

/** Perp bid/ask/mark, schedule and funding estimate. Throws when the quote itself is unusable. */
export async function collectPerp(client: Getter, ticker: string, nowMs: number): Promise<Snapshot['perp']> {
  void nowMs;
  const { market } = await client.get<{
    market: {
      bid?: string; ask?: string; price?: string;
      liquidation_mark_price?: { price?: string };
      schedule?: { is_open?: boolean; next_close_ts?: number | null } | null;
    };
  }>(`/margin/markets/${ticker}`);
  const schedule = market.schedule ?? null;
  let bid = num(market.bid);
  let ask = num(market.ask);
  let mark = num(market.liquidation_mark_price?.price ?? market.price);
  if (schedule?.is_open === false) {
    // A closed market may publish no (or a zero) bid/ask. Nothing can trade then, but the snapshot must still be
    // collected so the tick goes on (exits, journaling, the market-closed holds): a positive mark is enough.
    const pos = (x: number): boolean => Number.isFinite(x) && x > 0;
    const liq = num(market.liquidation_mark_price?.price);
    mark = pos(liq) ? liq : num(market.price);
    if (!pos(mark)) throw new Error(`perp market ${ticker}: unusable quote (market closed and no mark)`);
    bid = mark;
    ask = mark;
  } else if (![bid, ask, mark].every(Number.isFinite) || bid <= 0 || ask <= 0) {
    throw new Error(`perp market ${ticker}: unusable quote`);
  }

  let fundingEstimate: number | null = null;
  try {
    const f = await client.get<{ funding_rate?: number }>('/margin/funding_rates/estimate', { ticker });
    fundingEstimate = typeof f.funding_rate === 'number' && Number.isFinite(f.funding_rate) ? f.funding_rate : null;
  } catch {
    fundingEstimate = null;
  }
  const close = schedule?.next_close_ts;
  return {
    bid,
    ask,
    mark,
    // An absent schedule is "unknown", not "closed": the broker rejects an order if the market really is closed.
    marketOpen: schedule?.is_open ?? true,
    nextCloseTsMs: typeof close === 'number' && Number.isFinite(close) ? close * 1000 : null,
    fundingEstimate,
  };
}
