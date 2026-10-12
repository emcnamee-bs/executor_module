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
import { fetchLadderForEvent as defaultFetchLadder, type ActiveLadder } from './kalshi.js';
import { fetchTrajectory as defaultFetchTrajectory } from './kalshiHistory.js';
import { reviewForExit } from './exitReview.js';
import type { PreparedItem } from './prepare.js';
import { evaluateExit } from '../paper/exitMath.js';
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
        market, trajectory, model: deps.model,
      });
    } catch (err) {
      return errorRow(err instanceof Error ? err.message : String(err));
    }
    const modelReturnedAt = now();

    const math = evaluateExit({
      structure: position.structure as 'band' | 'threshold' | 'binary',
      side: position.side, contracts: position.contracts, remaining: position.remaining,
      entryPriceCents: position.entryPriceCents, market, bands: ladder.bands,
      shift: review.shift, confidence: review.confidence, exitFeeCents: deps.exitFeeCents,
    });
    const lag = {
      sourcePublishTs: item.source_publish_ts, eventTime: item.event_time, firstSeenTs: item.first_seen_ts, emittedTs: item.emitted_ts,
      reviewStartedAt: iso(reviewStartedAt), modelReturnedAt: iso(modelReturnedAt), firstSellAttemptAt: null as string | null,
      fillAt: null as string | null, outcome: null as string | null,
    };
    const reviewId = recordExitReview(db, {
      trade, itemId: item.item_id, positionId: position.id, shift: review.shift, confidence: review.confidence,
      reason: review.reason, midCents: math.midCents, fairAfterCents: math.fairAfterCents, lossCents: math.lossCents,
      exitCostCents: math.exitCostCents, verdict: math.sell ? 'sell' : 'hold', verdictReason: math.reason, lagJson: JSON.stringify(lag),
    });
    if (!math.sell) return;

    console.log(`[EXIT TRIGGER] trade=${trade} market=${position.marketTicker} side=${position.side} item=${item.item_id} :: ${math.reason}`);
    lag.firstSellAttemptAt = iso(now());
    const attempt = attemptExitFill(db, { position, reviewId, market });
    lag.fillAt = attempt.filledAt;
    lag.outcome = attempt.outcome;
    updateReviewLag(db, reviewId, JSON.stringify(lag));
    logExitFill(position, attempt);
    if (attempt.contracts > 0 && attempt.exitId !== null && attempt.priceCents !== null && attempt.filledAt !== null) {
      deps.onFill?.({
        positionId: position.id, reviewId, exitId: attempt.exitId, contracts: attempt.contracts,
        priceCents: attempt.priceCents, remaining: attempt.remaining, filledAt: attempt.filledAt,
      });
    }
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
