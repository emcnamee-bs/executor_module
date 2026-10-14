// src/perp/collectors/kalshiEvents.ts
const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

/** Yes-price mid of Kalshi event markets, used as market consensus. Markets without both sides, or that fail, are skipped. */
export async function collectKalshiEvents(
  tickers: string[],
  fetchFn: typeof fetch = fetch
): Promise<Array<{ ticker: string; yesProb: number }>> {
  const out: Array<{ ticker: string; yesProb: number }> = [];
  for (const ticker of tickers) {
    try {
      const res = await fetchFn(`${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const { market } = (await res.json()) as { market?: { yes_bid_dollars?: string; yes_ask_dollars?: string } };
      const bid = Number(market?.yes_bid_dollars);
      const ask = Number(market?.yes_ask_dollars);
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) out.push({ ticker, yesProb: (bid + ask) / 2 });
    } catch (err) {
      console.error(`[perp-collectors] Kalshi ${ticker} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}
