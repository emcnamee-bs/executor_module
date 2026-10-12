// src/backtest/exitReplay.ts
//
// Pure core of the exit-review backtest (spec section 8, step 5). Given a past position, the news items
// the pipeline logged after it was opened, and Kalshi candlesticks for every market of its event, replay
// what the exit review would have done: at each item, rebuild the ladder as quoted at that moment, ask the
// (injected) reviewer for shift + confidence, run evaluateExit, and on the first sell price the fill at the
// held-side bid of that same moment. No I/O here: the CLI supplies the data and the reviewer.
import type { BandMarket } from '../decide/kalshi.js';
import { markAtOrBefore, TRAJECTORY_MINUTES, type Candle, type TrajectoryPoint } from '../decide/kalshiHistory.js';
import { evaluateExit } from '../paper/exitMath.js';

export type CandleMap = Map<string, Candle[]>;

/** The article text a logged model call saw: between <article> tags when present, else the whole user text. */
export function extractArticleText(requestJson: string): string | null {
  let parsed: any;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    return null;
  }
  const raw = parsed?.messages?.[0]?.content ?? parsed?.user;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/<article>\s*([\s\S]*?)\s*<\/article>/);
  const text = (m ? m[1] : raw).trim();
  return text === '' ? null : text;
}

/** The bands saved with a paper position at entry; null when missing, malformed or empty. */
export function parseLadderJson(ladderJson: string): BandMarket[] | null {
  try {
    const v = JSON.parse(ladderJson);
    const bands = v?.bands;
    return Array.isArray(bands) && bands.length > 0 ? (bands as BandMarket[]) : null;
  } catch {
    return null;
  }
}

function quoteAt(candles: Candle[] | undefined, tsSec: number): Candle | null {
  if (candles === undefined) return null;
  let found: Candle | null = null;
  for (const c of candles) {
    if (c.endTs <= tsSec) found = c;
    else break;
  }
  return found;
}

/** The ladder as quoted at `tsSec`: static fields from the saved ladder, bid/ask from the last candle at or before. */
export function bandsAt(ladder: BandMarket[], candles: CandleMap, tsSec: number): BandMarket[] {
  return ladder.map((b) => {
    const q = quoteAt(candles.get(b.ticker), tsSec);
    return {
      ...b,
      status: 'active',
      yesBidCents: q?.yesBidCents ?? null,
      yesAskCents: q?.yesAskCents ?? null,
      yesBidSizeContracts: 1000, // candles carry no depth: assume the touch can absorb a paper-sized order
      yesAskSizeContracts: 1000,
    };
  });
}

export function trajectoryAt(candles: Candle[], side: 'yes' | 'no', tsSec: number): TrajectoryPoint[] {
  return TRAJECTORY_MINUTES.map((m) => ({ minutesAgo: m, markCents: markAtOrBefore(candles, tsSec - m * 60, side) }));
}

export interface ReplayItem {
  itemId: string;
  seenAtSec: number;
  text: string;
}

export interface ReplayPosition {
  id: number;
  side: 'yes' | 'no';
  structure: 'band' | 'threshold' | 'binary';
  marketTicker: string;
  contracts: number;
  entryPriceCents: number;
  createdAtSec: number;
  /** When it settled (unix s), or null while still open. */
  endSec: number | null;
  /** What actually happened: settlement P&L, or the open mark; null when unknown. */
  actualPnlCents: number | null;
  ladder: BandMarket[];
}

export type ReviewFn = (a: {
  item: ReplayItem;
  position: ReplayPosition;
  market: BandMarket;
  bands: BandMarket[];
  trajectory: TrajectoryPoint[];
}) => Promise<{ shift: number; confidence: number; reason: string }>;

export interface ReplayRow {
  itemId: string;
  atSec: number;
  verdict: 'sell' | 'hold' | 'skip';
  reason: string;
  shift: number | null;
  confidence: number | null;
  lossCents: number | null;
}

export interface ReplayResult {
  positionId: number;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
  /** Model calls actually made. */
  reviewed: number;
  sold: { atSec: number; itemId: string; priceCents: number; hypPnlCents: number } | null;
  actualPnlCents: number | null;
  /** hypothetical - actual (positive = selling would have been better); null when the actual is unknown. */
  deltaCents: number | null;
  rows: ReplayRow[];
}

export async function replayPosition(
  position: ReplayPosition,
  items: ReplayItem[],
  candles: CandleMap,
  review: ReviewFn,
  opts: { exitFeeCents?: number; maxItems?: number } = {}
): Promise<ReplayResult> {
  const window = items
    .filter((i) => i.seenAtSec > position.createdAtSec && (position.endSec === null || i.seenAtSec < position.endSec))
    .sort((a, b) => a.seenAtSec - b.seenAtSec)
    .slice(0, opts.maxItems ?? Number.POSITIVE_INFINITY);

  const rows: ReplayRow[] = [];
  let reviewed = 0;
  let sold: ReplayResult['sold'] = null;
  const skip = (item: ReplayItem, reason: string): void => {
    rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'skip', reason, shift: null, confidence: null, lossCents: null });
  };

  for (const item of window) {
    const bands = bandsAt(position.ladder, candles, item.seenAtSec);
    const market = bands.find((b) => b.ticker === position.marketTicker);
    if (market === undefined || (market.yesBidCents === null && market.yesAskCents === null)) {
      skip(item, 'no quote for the held market at that time');
      continue;
    }
    const trajectory = trajectoryAt(candles.get(position.marketTicker) ?? [], position.side, item.seenAtSec);
    let answer;
    try {
      reviewed += 1;
      answer = await review({ item, position, market, bands, trajectory });
    } catch (err) {
      skip(item, `review failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const math = evaluateExit({
      structure: position.structure, side: position.side, contracts: position.contracts, remaining: position.contracts,
      entryPriceCents: position.entryPriceCents, market, bands, shift: answer.shift, confidence: answer.confidence,
      exitFeeCents: opts.exitFeeCents,
    });
    if (!math.sell) {
      rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'hold', reason: math.reason, shift: answer.shift, confidence: answer.confidence, lossCents: math.lossCents });
      continue;
    }
    const bid = position.side === 'yes' ? market.yesBidCents : market.yesAskCents === null ? null : 100 - market.yesAskCents;
    if (bid === null || bid <= 0) {
      rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'skip', reason: 'sell triggered but there was no bid at that time', shift: answer.shift, confidence: answer.confidence, lossCents: math.lossCents });
      continue;
    }
    rows.push({ itemId: item.itemId, atSec: item.seenAtSec, verdict: 'sell', reason: math.reason, shift: answer.shift, confidence: answer.confidence, lossCents: math.lossCents });
    sold = { atSec: item.seenAtSec, itemId: item.itemId, priceCents: bid, hypPnlCents: position.contracts * (bid - position.entryPriceCents) };
    break;
  }

  const hyp = sold !== null ? sold.hypPnlCents : position.actualPnlCents;
  return {
    positionId: position.id, marketTicker: position.marketTicker, side: position.side, contracts: position.contracts,
    entryPriceCents: position.entryPriceCents, reviewed, sold, actualPnlCents: position.actualPnlCents,
    deltaCents: hyp === null || position.actualPnlCents === null ? null : hyp - position.actualPnlCents,
    rows,
  };
}

/** Classifies replay rows so a run of failed reviews or missing quotes is distinguishable from "the model held". */
export function summarizeSkips(rows: ReplayRow[]): { noQuote: number; reviewFailed: number; noBid: number; otherSkip: number; holds: number; sells: number } {
  const s = { noQuote: 0, reviewFailed: 0, noBid: 0, otherSkip: 0, holds: 0, sells: 0 };
  for (const r of rows) {
    if (r.verdict === 'hold') s.holds += 1;
    else if (r.verdict === 'sell') s.sells += 1;
    else if (r.reason.startsWith('no quote')) s.noQuote += 1;
    else if (r.reason.startsWith('review failed:')) s.reviewFailed += 1;
    else if (r.reason.includes('no bid')) s.noBid += 1;
    else s.otherSkip += 1;
  }
  return s;
}

/** `calls` is the model calls made (ReplayResult.reviewed, which counts failed calls too). */
export function reviewReliability(rows: ReplayRow[], calls: number): { failed: number; calls: number; mostlyFailed: boolean; allFailed: boolean } {
  const failed = summarizeSkips(rows).reviewFailed;
  return { failed, calls, mostlyFailed: failed > 0 && failed * 2 >= calls, allFailed: calls > 0 && failed >= calls };
}

/** Up to n distinct skip reasons, in row order. */
export function sampleSkipReasons(rows: ReplayRow[], n: number): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.verdict !== 'skip' || out.includes(r.reason)) continue;
    out.push(r.reason);
    if (out.length >= n) break;
  }
  return out;
}

export function summarizeReplay(results: ReplayResult[]): {
  positions: number; reviewed: number; sells: number; regretSells: number; hypPnlCents: number; actualPnlCents: number; deltaCents: number;
} {
  let reviewed = 0, sells = 0, regretSells = 0, hyp = 0, actual = 0, delta = 0;
  for (const r of results) {
    reviewed += r.reviewed;
    if (r.sold !== null) {
      sells += 1;
      if (r.deltaCents !== null && r.deltaCents < 0) regretSells += 1;
    }
    const h = r.sold !== null ? r.sold.hypPnlCents : r.actualPnlCents;
    if (h !== null) hyp += h;
    if (r.actualPnlCents !== null) actual += r.actualPnlCents;
    if (r.deltaCents !== null) delta += r.deltaCents;
  }
  return { positions: results.length, reviewed, sells, regretSells, hypPnlCents: hyp, actualPnlCents: actual, deltaCents: delta };
}
