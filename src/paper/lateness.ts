// src/paper/lateness.ts
//
// How late was an exit (spec section 5)? A SWEEP, never part of the sell: it finds fills that have no
// late_json yet, waits until the candle covering the fill can exist, fetches Kalshi candlesticks and
// records price at publication / at review start / at the fill, a late flag and the cents lost to lateness.
import type Database from 'better-sqlite3';
import { fetchCandles as defaultFetchCandles, markAtOrBefore, type Candle } from '../decide/kalshiHistory.js';
import { EXIT_LOSS_FRACTION } from './exitMath.js';

/** Wait this long after a fill before measuring, so the one-minute candle covering it exists. */
export const LATENESS_SETTLE_DELAY_MS = 90_000;
/** With no history after this long, record "source none" instead of retrying forever. */
export const LATENESS_GIVE_UP_MS = 10 * 60_000;

export interface LagStamps {
  sourcePublishTs: string | null;
  eventTime: string | null;
  firstSeenTs: string | null;
  emittedTs: string | null;
  reviewStartedAt: string | null;
  modelReturnedAt: string | null;
  firstSellAttemptAt: string | null;
  fillAt: string | null;
}

export interface LatenessInput {
  side: 'yes' | 'no';
  entryPriceCents: number;
  contracts: number;
  fillPriceCents: number;
  filledAt: string;
  lag: Partial<LagStamps>;
}

export interface LatenessResult {
  source: 'candles' | 'none';
  publishedAt: string | null;
  markAtPublication: number | null;
  markAtReviewStart: number | null;
  fillPriceCents: number;
  late: boolean | null;
  centsLostToLateness: number | null;
  lagMs: {
    publishToFirstSeen: number | null;
    firstSeenToEmitted: number | null;
    emittedToReviewStart: number | null;
    reviewStartToModelReturned: number | null;
    modelReturnedToSellAttempt: number | null;
    sellAttemptToFill: number | null;
    publishToFill: number | null;
  };
  measuredAt: string;
}

const ms = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
const diff = (from: number | null, to: number | null): number | null => (from === null || to === null ? null : to - from);

/** When the news was published: source publish time, else the event time, else when we first saw it. */
export function publicationMs(lag: Partial<LagStamps>): number | null {
  return ms(lag.sourcePublishTs) ?? ms(lag.eventTime) ?? ms(lag.firstSeenTs);
}

export function computeLateness(input: LatenessInput, candles: Candle[], nowMs: number): LatenessResult {
  const pub = publicationMs(input.lag);
  const start = ms(input.lag.reviewStartedAt);
  const fill = ms(input.filledAt);
  const have = candles.length > 0;
  const markPub = have && pub !== null ? markAtOrBefore(candles, Math.floor(pub / 1000), input.side) : null;
  const markStart = have && start !== null ? markAtOrBefore(candles, Math.floor(start / 1000), input.side) : null;
  const late = markPub !== null && markStart !== null ? markPub - markStart > EXIT_LOSS_FRACTION * input.entryPriceCents : null;
  const lost = markPub !== null ? Math.max(0, (markPub - input.fillPriceCents) * input.contracts) : null;
  const lag = input.lag;
  return {
    source: have ? 'candles' : 'none',
    publishedAt: pub === null ? null : new Date(pub).toISOString(),
    markAtPublication: markPub,
    markAtReviewStart: markStart,
    fillPriceCents: input.fillPriceCents,
    late,
    centsLostToLateness: lost,
    lagMs: {
      publishToFirstSeen: diff(pub, ms(lag.firstSeenTs)),
      firstSeenToEmitted: diff(ms(lag.firstSeenTs), ms(lag.emittedTs)),
      emittedToReviewStart: diff(ms(lag.emittedTs), start),
      reviewStartToModelReturned: diff(start, ms(lag.modelReturnedAt)),
      modelReturnedToSellAttempt: diff(ms(lag.modelReturnedAt), ms(lag.firstSellAttemptAt)),
      sellAttemptToFill: diff(ms(lag.firstSellAttemptAt), fill),
      publishToFill: diff(pub, fill),
    },
    measuredAt: new Date(nowMs).toISOString(),
  };
}

interface SweepRow {
  id: number;
  contracts: number;
  fillPrice: number;
  filledAt: string;
  side: 'yes' | 'no';
  market: string;
  entry: number;
  lagJson: string | null;
  trade: string;
}

function parseLag(raw: string | null): Partial<LagStamps> {
  if (raw === null) return {};
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Partial<LagStamps>) : {};
  } catch {
    return {};
  }
}

/** Measures up to `limit` unmeasured fills. Returns the number of rows written. Never throws. */
export async function sweepLateness(
  db: Database.Database,
  seriesTicker: string,
  deps: { fetchCandles?: typeof defaultFetchCandles; now?: () => number; limit?: number } = {}
): Promise<number> {
  const now = (deps.now ?? Date.now)();
  const fetchCandles = deps.fetchCandles ?? defaultFetchCandles;
  let rows: SweepRow[];
  try {
    rows = db
      .prepare(
        `SELECT e.id, e.contracts, e.price_cents AS fillPrice, e.filled_at AS filledAt, p.side, p.market_ticker AS market,
                p.entry_price_cents AS entry, r.lag_json AS lagJson, p.trade AS trade
           FROM paper_exits e
           JOIN paper_positions p ON p.id = e.position_id
           JOIN paper_exit_reviews r ON r.id = e.review_id
          WHERE e.status IN ('filled', 'partial') AND e.late_json IS NULL AND e.filled_at IS NOT NULL AND e.filled_at <= ?
          ORDER BY e.id LIMIT ?`
      )
      .all(new Date(now - LATENESS_SETTLE_DELAY_MS).toISOString(), deps.limit ?? 20) as SweepRow[];
  } catch (err) {
    console.error('[exit-lateness] sweep query failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }

  let written = 0;
  for (const row of rows) {
    try {
      const lag = parseLag(row.lagJson);
      const fillMs = Date.parse(row.filledAt);
      const pub = publicationMs(lag);
      const startTs = Math.floor(((pub ?? fillMs - 15 * 60_000) - 2 * 60_000) / 1000);
      const endTs = Math.floor(fillMs / 1000) + 120;
      const candles = await fetchCandles(seriesTicker, row.market, startTs, endTs);
      if (candles.length === 0 && now - fillMs < LATENESS_GIVE_UP_MS) continue; // history may simply not be there yet
      const result = computeLateness(
        { side: row.side, entryPriceCents: row.entry, contracts: row.contracts, fillPriceCents: row.fillPrice, filledAt: row.filledAt, lag },
        candles,
        now
      );
      db.prepare(`UPDATE paper_exits SET late = ?, late_json = ? WHERE id = ?`).run(
        result.late === null ? null : result.late ? 1 : 0,
        JSON.stringify(result),
        row.id
      );
      written += 1;
      const seconds = result.lagMs.publishToFill === null ? '?' : (result.lagMs.publishToFill / 1000).toFixed(0);
      if (result.late === true) {
        console.warn(
          `[EXIT LATE] trade=${row.trade} market=${row.market} side=${row.side} published=${result.publishedAt} ` +
            `mark ${result.markAtPublication}c -> ${result.markAtReviewStart}c at review start, sold ${row.contracts} @${row.fillPrice}c, ` +
            `lost ${result.centsLostToLateness}c to lateness, publish-to-fill ${seconds}s`
        );
      } else {
        console.log(`[EXIT LAG] trade=${row.trade} market=${row.market} late=${result.late} source=${result.source} publish-to-fill ${seconds}s`);
      }
    } catch (err) {
      console.error(`[exit-lateness] measuring exit ${row.id} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return written;
}
