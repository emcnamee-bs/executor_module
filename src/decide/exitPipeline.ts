// src/decide/exitPipeline.ts
//
// The exit review for ONE incoming item (spec sections 2 and 3). Called from runDecisionPipeline
// in parallel with the entry path, after the shared item preparation. For every open paper
// position that has not been reviewed against this item and has no sell trigger yet:
//   fetch its own event's ladder -> price trajectory -> model (shift, confidence) -> evaluateExit
//   -> audit row -> on sell, an immediate simulated fill at the touch.
// One position's failure never blocks the others; a model error never sells.
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import type { LoadedProfile } from '../profile/profile.js';
import { fetchLadderForEvent as defaultFetchLadder, type ActiveLadder, type BandMarket } from './kalshi.js';
import { fetchTrajectory as defaultFetchTrajectory } from './kalshiHistory.js';
import { reviewForExit, type ExitReviewResult } from './exitReview.js';
import type { PreparedItem } from './prepare.js';
import { evaluateExit, type ExitMathResult } from '../paper/exitMath.js';
import {
  listOpenPaperPositions, hasExitReview, positionHasSellReview, recordExitReview, updateReviewLag, type OpenPaperPosition,
} from '../paper/exits.js';
import { attemptExitFill, logExitFill, type ExitFillInfo } from '../paper/exitFill.js';
import { checkExitBudget } from '../paper/exitSpend.js';
import { sendAlert } from '../alert.js';

export interface ExitReviewDeps {
  anthropicClient: Anthropic;
  db: Database.Database;
  profile: LoadedProfile;
  fetchLadderForEvent?: typeof defaultFetchLadder;
  fetchTrajectory?: typeof defaultFetchTrajectory;
  /** EXIT_REVIEW_MODEL; default Sonnet. */
  model?: string;
  /** EXIT_FEE_CENTS; default 0 (P&L is gross of fees). */
  exitFeeCents?: number;
  /** EXIT_DAILY_USD_CAP: alert-only, never stops reviews. */
  dailyUsdCap?: number;
  now?: () => number;
  /** Called after any fill (the lateness job hooks in here). */
  onFill?: (info: ExitFillInfo) => void;
  alert?: (message: string) => void;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export interface SettleInput {
  db: Database.Database;
  trade: string;
  item: Item;
  position: OpenPaperPosition;
  /** The held market as quoted now. */
  market: BandMarket;
  /** Its whole event, for the fair-value curve. */
  bands: BandMarket[];
  review: ExitReviewResult;
  reviewStartedAt: number;
  modelReturnedAt: number;
  now: () => number;
  exitFeeCents?: number;
  onFill?: (info: ExitFillInfo) => void;
  /** Unified mode only: the model's own recommendation for this position. Absent = classic (the rule alone decides). */
  model?: { action: 'hold' | 'sell'; reason: string };
}

/** Both must agree in unified mode (spec section 3): a sell needs the model's `sell` AND the rule's. */
export function verdictFor(math: ExitMathResult, model: SettleInput['model']): { sell: boolean; reason: string } {
  if (model === undefined) return { sell: math.sell, reason: math.reason };
  if (math.sell && model.action === 'sell') return { sell: true, reason: `model: sell (${model.reason}); rule: ${math.reason}` };
  if (math.sell) return { sell: false, reason: `the rule says sell (${math.reason}) but the model recommended hold (${model.reason})` };
  if (model.action === 'sell') return { sell: false, reason: `the model recommended sell (${model.reason}) but the rule vetoed it: ${math.reason}` };
  return { sell: false, reason: `model: hold (${model.reason}); rule: ${math.reason}` };
}

/**
 * Everything after the model has spoken about ONE position: the rule's arithmetic, the audit row, and on a
 * sell the immediate simulated fill. Shared by the classic exit review and the unified step so there is one
 * implementation of "what happens when a position is judged".
 */
export function settleReview(input: SettleInput): void {
  const { db, trade, item, position, market, review } = input;
  const math = evaluateExit({
    structure: position.structure as 'band' | 'threshold' | 'binary' | 'multi',
    side: position.side, contracts: position.contracts, remaining: position.remaining,
    entryPriceCents: position.entryPriceCents, market, bands: input.bands,
    shift: review.shift, confidence: review.confidence, exitFeeCents: input.exitFeeCents,
  });
  const verdict = verdictFor(math, input.model);
  const lag = {
    sourcePublishTs: item.source_publish_ts, eventTime: item.event_time, firstSeenTs: item.first_seen_ts, emittedTs: item.emitted_ts,
    reviewStartedAt: iso(input.reviewStartedAt), modelReturnedAt: iso(input.modelReturnedAt), firstSellAttemptAt: null as string | null,
    fillAt: null as string | null, outcome: null as string | null,
  };
  const reviewId = recordExitReview(db, {
    trade, itemId: item.item_id, positionId: position.id, shift: review.shift, confidence: review.confidence,
    reason: review.reason, midCents: math.midCents, fairAfterCents: math.fairAfterCents, lossCents: math.lossCents,
    exitCostCents: math.exitCostCents, verdict: verdict.sell ? 'sell' : 'hold', verdictReason: verdict.reason, lagJson: JSON.stringify(lag),
    modelAction: input.model?.action ?? null, decisionMode: input.model === undefined ? null : 'unified',
  });
  if (!verdict.sell) return;

  console.log(`[EXIT TRIGGER] trade=${trade} market=${position.marketTicker} side=${position.side} item=${item.item_id} :: ${verdict.reason}`);
  lag.firstSellAttemptAt = iso(input.now());
  const attempt = attemptExitFill(db, { position, reviewId, market });
  lag.fillAt = attempt.filledAt;
  lag.outcome = attempt.outcome;
  updateReviewLag(db, reviewId, JSON.stringify(lag));
  logExitFill(position, attempt);
  if (attempt.contracts > 0 && attempt.exitId !== null && attempt.priceCents !== null && attempt.filledAt !== null) {
    input.onFill?.({
      positionId: position.id, reviewId, exitId: attempt.exitId, contracts: attempt.contracts,
      priceCents: attempt.priceCents, remaining: attempt.remaining, filledAt: attempt.filledAt,
    });
  }
}

export async function runExitReview(item: Item, deps: ExitReviewDeps, prepare: () => Promise<PreparedItem>): Promise<void> {
  const { db, profile: loaded } = deps;
  const now = deps.now ?? Date.now;
  const alert = deps.alert ?? ((m: string) => { void sendAlert(m); });
  const trade = loaded.profile.name;

  const candidates = listOpenPaperPositions(db).filter(
    (p) => !positionHasSellReview(db, p.id) && !hasExitReview(db, item.item_id, p.id)
  );
  if (candidates.length === 0) return;

  const reviewStartedAt = now();
  const prepared = await prepare();
  if (prepared.gate.kind !== 'pass') return;

  const fetchLadder = deps.fetchLadderForEvent ?? defaultFetchLadder;
  const fetchTrajectory = deps.fetchTrajectory ?? defaultFetchTrajectory;
  const ladders = new Map<string, Promise<ActiveLadder | null>>();
  const ladderFor = (event: string): Promise<ActiveLadder | null> => {
    let p = ladders.get(event);
    if (p === undefined) {
      // No db argument: a failing exit-path Kalshi call must never feed the circuit breaker.
      p = fetchLadder(event).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[exit-review] ladder fetch for ${event} failed: ${msg}`);
        // One alert per failed event per item (this memoized promise), not one per position on it.
        alert(`[EXIT-REVIEW ERROR] ${trade} ladder for ${event} failed: ${msg}`);
        return null;
      });
      ladders.set(event, p);
    }
    return p;
  };

  const reviewOne = async (position: OpenPaperPosition): Promise<void> => {
    const errorRow = (why: string, silent = false): void => {
      recordExitReview(db, {
        trade, itemId: item.item_id, positionId: position.id, shift: null, confidence: null, reason: null, midCents: null,
        fairAfterCents: null, lossCents: null, exitCostCents: null, verdict: 'error', verdictReason: why, lagJson: null,
      });
      if (!silent) alert(`[EXIT-REVIEW ERROR] ${trade} ${position.marketTicker}: ${why}`);
    };

    const ladder = await ladderFor(position.eventTicker);
    // Silent: ladderFor already sent the one alert for this event.
    if (ladder === null) return errorRow(`could not fetch the ladder for ${position.eventTicker}`, true);
    const market = ladder.bands.find((b) => b.ticker === position.marketTicker);
    if (market === undefined) {
      recordExitReview(db, {
        trade, itemId: item.item_id, positionId: position.id, shift: null, confidence: null, reason: null, midCents: null,
        fairAfterCents: null, lossCents: null, exitCostCents: null, verdict: 'hold',
        verdictReason: 'market not open (closed or settled)', lagJson: null,
      });
      return;
    }

    const trajectory = await fetchTrajectory(loaded.profile.seriesTicker, position.marketTicker, position.side, Math.floor(now() / 1000));
    let review;
    try {
      review = await reviewForExit(deps.anthropicClient, db, {
        loaded, itemId: item.item_id, articleText: prepared.articleText, excerptSource: prepared.excerptSource,
        tripwireHit: prepared.tripwireHit, sourceTrustTier: item.trust_tier, publishedAt: item.source_publish_ts ?? item.event_time,
        position: {
          marketTicker: position.marketTicker, side: position.side, contracts: position.contracts,
          remaining: position.remaining, entryPriceCents: position.entryPriceCents,
        },
        market, trajectory, model: deps.model, outcomeGroup: loaded.profile.outcomeGroup,
      });
    } catch (err) {
      return errorRow(err instanceof Error ? err.message : String(err));
    }
    settleReview({
      db, trade, item, position, market, bands: ladder.bands, review, reviewStartedAt, modelReturnedAt: now(), now,
      exitFeeCents: deps.exitFeeCents, onFill: deps.onFill,
    });
  };

  for (const position of candidates) {
    try {
      await reviewOne(position);
    } catch (err) {
      console.error(`[exit-review] position ${position.id} (${position.marketTicker}) failed:`, err);
    }
  }
  if (deps.dailyUsdCap !== undefined) checkExitBudget(db, deps.dailyUsdCap, alert, now());
}
