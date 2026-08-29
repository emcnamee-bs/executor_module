// src/decide/kalshi.ts

import type Database from 'better-sqlite3';
import { recordKalshiError } from './ledger.js';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface BandMarket {
  ticker: string;
  floorStrike: number | null;
  capStrike: number | null;
  strikeType: 'less' | 'greater' | 'between';
  status: string;
  /** null when Kalshi reports no resting order on this side (raw price exactly 0.0000). */
  yesAskCents: number | null;
  yesBidCents: number | null;
  yesAskSizeContracts: number;
  yesBidSizeContracts: number;
}

export interface ActiveLadder {
  eventTicker: string;
  strikeDate: string;
  bands: BandMarket[];
}

export interface MarketStatus {
  status: string;
  result: string;
}

interface KalshiEvent {
  event_ticker: string;
  strike_date: string;
}

interface KalshiEventsResponse {
  events: KalshiEvent[];
}

interface KalshiMarket {
  ticker: string;
  floor_strike?: number;
  cap_strike?: number;
  strike_type: 'less' | 'greater' | 'between';
  status: string;
  yes_ask_dollars: string;
  yes_bid_dollars: string;
  yes_ask_size_fp: string;
  yes_bid_size_fp: string;
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
}

interface KalshiSingleMarketResponse {
  market: {
    status: string;
    result: string;
  };
}

/** Kalshi reports "no resting order" as an exact 0.0000, not a missing field. */
function priceCentsOrNull(raw: string): number | null {
  const dollars = parseFloat(raw);
  const cents = Math.round(dollars * 100);
  return cents > 0 ? cents : null;
}

function sizeContracts(raw: string): number {
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

export async function fetchActiveLadder(seriesTicker: string, db?: Database.Database): Promise<ActiveLadder | null> {
  try {
    const eventsUrl = `${KALSHI_API_BASE}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open`;
    const eventsRes = await fetch(eventsUrl);
    if (!eventsRes.ok) {
      throw new Error(`Kalshi events fetch failed: ${eventsRes.status} ${eventsRes.statusText}`);
    }
    const eventsBody = (await eventsRes.json()) as KalshiEventsResponse;
    if (eventsBody.events.length === 0) {
      return null;
    }

    const active = [...eventsBody.events].sort((a, b) => a.strike_date.localeCompare(b.strike_date))[0];

    const marketsUrl = `${KALSHI_API_BASE}/markets?event_ticker=${encodeURIComponent(active.event_ticker)}&status=open`;
    const marketsRes = await fetch(marketsUrl);
    if (!marketsRes.ok) {
      throw new Error(`Kalshi markets fetch failed: ${marketsRes.status} ${marketsRes.statusText}`);
    }
    const marketsBody = (await marketsRes.json()) as KalshiMarketsResponse;

    const bands: BandMarket[] = marketsBody.markets.map((m) => ({
      ticker: m.ticker,
      floorStrike: m.floor_strike ?? null,
      capStrike: m.cap_strike ?? null,
      strikeType: m.strike_type,
      status: m.status,
      yesAskCents: priceCentsOrNull(m.yes_ask_dollars),
      yesBidCents: priceCentsOrNull(m.yes_bid_dollars),
      yesAskSizeContracts: sizeContracts(m.yes_ask_size_fp),
      yesBidSizeContracts: sizeContracts(m.yes_bid_size_fp),
    }));

    return { eventTicker: active.event_ticker, strikeDate: active.strike_date, bands };
  } catch (err) {
    if (db) {
      const message = err instanceof Error ? err.message : String(err);
      recordKalshiError(db, 'fetchActiveLadder', message);
    }
    throw err;
  }
}

/** Ceiling on the market-status fetch. See the signal below for why it exists. */
const MARKET_STATUS_TIMEOUT_MS = 10_000;

export async function fetchMarketStatus(ticker: string, db?: Database.Database): Promise<MarketStatus> {
  try {
    const url = `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}`;
    // Node's fetch has NO default timeout. This call runs inside the 10-minute
    // reconciliation pass, whose overlap guard in main.ts is cleared only in a
    // .finally() -- a permanent hang here (dead socket, stalled TLS handshake) would
    // latch that guard forever, silently no-opping every later tick with zero log
    // output. Timing out turns the hang into an AbortError rejection, which the
    // per-ticker try/catch in reconcileOpenPositions already handles as "retry next
    // pass".
    const res = await fetch(url, { signal: AbortSignal.timeout(MARKET_STATUS_TIMEOUT_MS) });
    if (!res.ok) {
      throw new Error(`Kalshi market status fetch failed for ${ticker}: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as KalshiSingleMarketResponse;
    return { status: body.market.status, result: body.market.result };
  } catch (err) {
    if (db) {
      const message = err instanceof Error ? err.message : String(err);
      recordKalshiError(db, 'fetchMarketStatus', message);
    }
    throw err;
  }
}
