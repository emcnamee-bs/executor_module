// src/decide/kalshiHistory.ts
//
// Best-effort price history from Kalshi's public candlestick endpoint. Used (a) to show the exit
// model how the held side moved over the last hour and (b) after a fill, to measure lateness.
// Never throws and never writes kalshi_errors: history is advisory and must not feed the breaker.

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const CANDLES_TIMEOUT_MS = 10_000;

export interface Candle {
  /** End of the one-minute period, unix seconds. */
  endTs: number;
  yesBidCents: number | null;
  yesAskCents: number | null;
}

export interface TrajectoryPoint {
  minutesAgo: number;
  /** Held-side value in that side's own cents, null when unknown. */
  markCents: number | null;
}

export const TRAJECTORY_MINUTES = [5, 15, 60] as const;

function closeCents(v: unknown): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null;
}

interface RawCandle {
  end_period_ts?: number;
  yes_bid?: { close_dollars?: string };
  yes_ask?: { close_dollars?: string };
}

export async function fetchCandles(
  seriesTicker: string,
  marketTicker: string,
  startTs: number,
  endTs: number,
  fetchImpl: typeof fetch = fetch
): Promise<Candle[]> {
  const url =
    `${KALSHI_API_BASE}/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(marketTicker)}` +
    `/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(CANDLES_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[kalshi-history] candlesticks ${marketTicker}: HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { candlesticks?: RawCandle[] };
    return (body.candlesticks ?? [])
      .filter((c): c is RawCandle & { end_period_ts: number } => typeof c.end_period_ts === 'number')
      .map((c) => ({ endTs: c.end_period_ts, yesBidCents: closeCents(c.yes_bid?.close_dollars), yesAskCents: closeCents(c.yes_ask?.close_dollars) }))
      .sort((a, b) => a.endTs - b.endTs);
  } catch (err) {
    console.warn(`[kalshi-history] candlesticks ${marketTicker} failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Value of a held position at this candle's close: YES at the yes bid, NO at 100 - yes ask. */
export function heldSideMark(candle: Candle, side: 'yes' | 'no'): number | null {
  if (side === 'yes') return candle.yesBidCents;
  return candle.yesAskCents === null ? null : 100 - candle.yesAskCents;
}

/** Held-side mark of the last candle that ended at or before `ts` (candles must be sorted by endTs). */
export function markAtOrBefore(candles: Candle[], ts: number, side: 'yes' | 'no'): number | null {
  let found: Candle | null = null;
  for (const c of candles) {
    if (c.endTs <= ts) found = c;
    else break;
  }
  return found === null ? null : heldSideMark(found, side);
}

export async function fetchTrajectory(
  seriesTicker: string,
  marketTicker: string,
  side: 'yes' | 'no',
  nowTs: number,
  fetchImpl: typeof fetch = fetch
): Promise<TrajectoryPoint[]> {
  const longest = Math.max(...TRAJECTORY_MINUTES);
  const candles = await fetchCandles(seriesTicker, marketTicker, nowTs - (longest + 5) * 60, nowTs, fetchImpl);
  return TRAJECTORY_MINUTES.map((m) => ({ minutesAgo: m, markCents: markAtOrBefore(candles, nowTs - m * 60, side) }));
}
