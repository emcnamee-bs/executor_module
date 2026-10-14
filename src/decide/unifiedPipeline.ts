// src/decide/unifiedPipeline.ts
//
// The per-item work of unified mode (unified-decision spec, section 3): gather every reviewable
// position with its own event's ladder and trajectory, make ONE model call, and settle each position
// through settleReview (where the rule can veto the model and vice versa). The ENTRY half of the
// answer is returned for runEntryPipeline to turn into a position through the unchanged sizing tail.
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import type { Rung } from './rung.js';
import type { LoadedProfile } from '../profile/profile.js';
import {
  fetchActiveLadder, fetchLadderForEvent as defaultFetchLadderForEvent, type ActiveLadder, type BandMarket,
} from './kalshi.js';
import { fetchTrajectory as defaultFetchTrajectory, type TrajectoryPoint } from './kalshiHistory.js';
import type { PreparedItem } from './prepare.js';
import { positionAwareDecide, type UnifiedDecision, type UnifiedPositionView } from './unifiedDecide.js';
import { settleReview } from './exitPipeline.js';
import { listOpenPaperPositions, hasExitReview, positionHasSellReview, recordExitReview, type OpenPaperPosition } from '../paper/exits.js';
import type { ExitFillInfo } from '../paper/exitFill.js';
import { checkExitBudget } from '../paper/exitSpend.js';
import { sendAlert } from '../alert.js';

export interface UnifiedStepDeps {
  anthropicClient: Anthropic;
  db: Database.Database;
  profile: LoadedProfile;
  /** The entry path's active-event fetch (feeds the circuit breaker on failure, as classic does). */
  fetchLadder: typeof fetchActiveLadder;
  /** Position events: called WITHOUT a db so a failure never feeds the circuit breaker. */
  fetchLadderForEvent?: typeof defaultFetchLadderForEvent;
  fetchTrajectory?: typeof defaultFetchTrajectory;
  /** EXIT_REVIEW_MODEL; default Sonnet. */
  model?: string;
  exitFeeCents?: number;
  dailyUsdCap?: number;
  now?: () => number;
  onFill?: (info: ExitFillInfo) => void;
  alert?: (message: string) => void;
}

export interface UnifiedStepResult {
  ladder: ActiveLadder | null;
  ladderError: Error | null;
  decision: UnifiedDecision | null;
  failure: string | null;
}

const yesMid = (m: BandMarket): number | null =>
  m.yesAskCents !== null && m.yesBidCents !== null ? (m.yesAskCents + m.yesBidCents) / 2 : (m.yesAskCents ?? m.yesBidCents);

function viewOf(position: OpenPaperPosition, market: BandMarket, trajectory: TrajectoryPoint[]): UnifiedPositionView {
  const mid = yesMid(market);
  const heldMid = mid === null ? null : position.side === 'yes' ? mid : 100 - mid;
  const heldBid = position.side === 'yes' ? market.yesBidCents : market.yesAskCents === null ? null : 100 - market.yesAskCents;
  return {
    id: position.id, marketTicker: position.marketTicker, label: market.label ?? null, side: position.side, contracts: position.contracts,
    remaining: position.remaining, entryPriceCents: position.entryPriceCents, heldBidCents: heldBid, heldMidCents: heldMid,
    unrealisedCents: heldBid === null ? null : (heldBid - position.entryPriceCents) * position.remaining, trajectory,
  };
}

export async function runUnifiedStep(
  item: Item,
  deps: UnifiedStepDeps,
  prepare: () => Promise<PreparedItem>,
  entryAllowed: boolean,
  rung: Rung,
  lowTierRelaxed: boolean
): Promise<UnifiedStepResult | null> {
  const { db, profile: loaded } = deps;
  const now = deps.now ?? Date.now;
  const alert = deps.alert ?? ((m: string) => { void sendAlert(m); });
  const trade = loaded.profile.name;

  const candidates = listOpenPaperPositions(db).filter((p) => !positionHasSellReview(db, p.id) && !hasExitReview(db, item.item_id, p.id));
  if (candidates.length === 0 && !entryAllowed) return null;

  const reviewStartedAt = now();
  const prepared = await prepare();
  if (prepared.gate.kind !== 'pass') return null;

  let ladder: ActiveLadder | null = null;
  let ladderError: Error | null = null;
  if (entryAllowed) {
    try {
      ladder = await deps.fetchLadder(loaded.profile.seriesTicker, db);
    } catch (err) {
      ladderError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const fetchLadderForEvent = deps.fetchLadderForEvent ?? defaultFetchLadderForEvent;
  const fetchTrajectory = deps.fetchTrajectory ?? defaultFetchTrajectory;
  const eventLadders = new Map<string, Promise<ActiveLadder | null>>();
  const ladderFor = (event: string): Promise<ActiveLadder | null> => {
    if (ladder !== null && ladder.eventTicker === event) return Promise.resolve(ladder);
    let p = eventLadders.get(event);
    if (p === undefined) {
      p = fetchLadderForEvent(event).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[unified] ladder fetch for ${event} failed: ${msg}`);
        alert(`[UNIFIED ERROR] ${trade} ladder for ${event} failed: ${msg}`);
        return null;
      });
      eventLadders.set(event, p);
    }
    return p;
  };

  const errorRow = (position: OpenPaperPosition, why: string): void => {
    recordExitReview(db, {
      trade, itemId: item.item_id, positionId: position.id, shift: null, confidence: null, reason: null, midCents: null,
      fairAfterCents: null, lossCents: null, exitCostCents: null, verdict: 'error', verdictReason: why, lagJson: null,
      modelAction: null, decisionMode: 'unified',
    });
  };

  const reviewable: Array<{ position: OpenPaperPosition; market: BandMarket; bands: BandMarket[]; view: UnifiedPositionView }> = [];
  for (const position of candidates) {
    try {
      const eventLadder = await ladderFor(position.eventTicker);
      if (eventLadder === null) { errorRow(position, `could not fetch the ladder for ${position.eventTicker}`); continue; }
      const market = eventLadder.bands.find((b) => b.ticker === position.marketTicker);
      if (market === undefined) {
        recordExitReview(db, {
          trade, itemId: item.item_id, positionId: position.id, shift: null, confidence: null, reason: null, midCents: null,
          fairAfterCents: null, lossCents: null, exitCostCents: null, verdict: 'hold', verdictReason: 'market not open (closed or settled)',
          lagJson: null, modelAction: null, decisionMode: 'unified',
        });
        continue;
      }
      const trajectory = await fetchTrajectory(loaded.profile.seriesTicker, position.marketTicker, position.side, Math.floor(now() / 1000));
      reviewable.push({ position, market, bands: eventLadder.bands, view: viewOf(position, market, trajectory) });
    } catch (err) {
      console.error(`[unified] preparing position ${position.id} (${position.marketTicker}) failed:`, err);
      errorRow(position, `preparing the position failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const canEnter = entryAllowed && ladder !== null;
  if (reviewable.length === 0 && !canEnter) return { ladder, ladderError, decision: null, failure: null };

  const activeBands = canEnter ? ladder!.bands : [];
  const activeTickers = new Set(activeBands.map((b) => b.ticker));
  const markets = [...activeBands, ...reviewable.map((r) => r.market).filter((m) => !activeTickers.has(m.ticker))];

  let decision: UnifiedDecision;
  try {
    decision = await positionAwareDecide(deps.anthropicClient, db, {
      loaded, itemId: item.item_id, articleText: prepared.articleText, excerptSource: prepared.excerptSource,
      tripwireHit: prepared.tripwireHit, sourceTrustTier: item.trust_tier, publishedAt: item.source_publish_ts ?? item.event_time,
      rung, lowTierRelaxed, markets, activeTickers: [...activeTickers], positions: reviewable.map((r) => r.view),
      entryAllowed: canEnter, model: deps.model,
    });
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    for (const r of reviewable) errorRow(r.position, failure);
    alert(`[UNIFIED ERROR] ${trade} item ${item.item_id}: ${failure}`);
    return { ladder, ladderError, decision: null, failure };
  }
  const modelReturnedAt = now();

  for (const r of reviewable) {
    try {
      const call = decision.positions.get(r.position.id)!; // validateUnified guarantees every position has one
      const move = decision.assessment === null ? decision.moves.find((m) => m.market === r.position.marketTicker) : undefined;
      const review =
        decision.assessment !== null
          ? { shift: decision.assessment.shift, confidence: decision.assessment.confidence, reason: decision.assessment.reason }
          : { shift: move?.shift ?? 0, confidence: move?.confidence ?? 0, reason: move === undefined ? 'the model proposed no move for this market' : decision.reasoning };
      settleReview({
        db, trade, item, position: r.position, market: r.market, bands: r.bands, review, reviewStartedAt, modelReturnedAt, now,
        exitFeeCents: deps.exitFeeCents, onFill: deps.onFill, model: call,
      });
    } catch (err) {
      console.error(`[unified] position ${r.position.id} (${r.position.marketTicker}) failed:`, err);
    }
  }
  if (deps.dailyUsdCap !== undefined) checkExitBudget(db, deps.dailyUsdCap, alert, now());
  return { ladder, ladderError, decision, failure: null };
}
