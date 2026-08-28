// src/decide/pipeline.ts
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import { computeRung, type Rung } from './rung.js';
import { fetchActiveLadder, type ActiveLadder } from './kalshi.js';
import {
  recordDecision,
  recordPendingDecision,
  resolveDecision,
  recordPendingOrder,
  resolveOrder,
  hasDecisionForItem,
  hasOpenPosition,
  totalExposureCents,
  type DecisionRecord,
} from './ledger.js';
import { evaluateSizing } from './sizing.js';
import { synopsize } from './synopsis.js';
import { verifySynopsis } from './verify.js';
import { decideTrade } from './decide.js';
import { placeOrder, deriveClientOrderId } from '../execute/order.js';
import { positionForTicker, type KalshiClient } from '../execute/kalshiClient.js';

const KALSHI_SERIES_TICKER = 'KXAPRPOTUS';

export interface PipelineDeps {
  anthropicClient: Anthropic;
  db: Database.Database;
  fetchLadder: typeof fetchActiveLadder;
  kalshiClient: KalshiClient;
}

/**
 * `rung` is required, not defaulted: it is computed from `Item` fields alone, before
 * any model call and therefore before every skip point below, so no skip row ever
 * needs a placeholder standing in for "not yet computed".
 */
function skipRecord(
  item: Item,
  reason: string,
  { rung, ...overrides }: Partial<DecisionRecord> & { rung: Rung }
): DecisionRecord {
  return {
    itemId: item.item_id,
    storyKey: item.story_key,
    eventTicker: null,
    marketTicker: null,
    side: null,
    rung,
    direction: null,
    magnitudePts: null,
    contracts: 0,
    entryPriceCents: null,
    notionalCents: 0,
    edgeCents: null,
    wouldTrade: false,
    reason,
    // A skip is always fully resolved the instant it's recorded -- never pending.
    // Every call site below also passes this explicitly (redundant, deliberately),
    // but the default keeps skipRecord's own return type sound on its own terms.
    orderStatus: 'resolved',
    ...overrides,
  };
}

export async function runDecisionPipeline(item: Item, deps: PipelineDeps): Promise<void> {
  const { anthropicClient, db, fetchLadder, kalshiClient } = deps;

  // Redis delivery is at-least-once: a crash or restart mid-item re-delivers the
  // unacked entry. An item that already has a ledger row was fully processed by an
  // earlier delivery, so the correct action is a silent no-op -- re-running would
  // spend three model calls again and either duplicate the decision or trip the
  // unique index on item_id. Not a new skip row: nothing new was decided.
  if (hasDecisionForItem(db, item.item_id)) {
    return;
  }

  // Computed first because it is pure and free -- it reads only `trust_tier`,
  // `story_key` and `corroborations`, all already on the Item, and nothing the
  // synopsis or verify steps produce. Running it here means a guaranteed-skip
  // 'rumor' item never burns a Haiku call and a Sonnet call on a decision that was
  // already fully determined, and every skip record below carries the real rung.
  const rung = computeRung({
    trustTier: item.trust_tier,
    storyKey: item.story_key,
    corroborations: item.corroborations,
  });

  // Hoisted so the catch below can tell whether the pending decision row was
  // already written (i.e. the crash happened at or after `recordPendingOrder` /
  // during `placeOrder`) BEFORE it decides how to record the failure: once that row
  // exists, `item_id`'s unique index means a second recordDecision(...) INSERT for
  // this item would itself throw, so that row must be UPDATEd in place instead.
  let pendingDecisionId: number | null = null;
  let pendingOrderId: number | null = null;
  let pendingRecordForCrash: DecisionRecord | null = null;

  // Everything from here on is wrapped: the Redis consumer acks the entry once this
  // handler returns, so an escaping exception loses the item with no durable trace
  // at all. A recorded skip row is the trace. (This has already happened once in
  // production: a transient truncated-JSON parse error left nothing behind.)
  try {
    if (process.env.EXECUTOR_TRADING_HALTED === 'true') {
      recordDecision(db, skipRecord(item, 'kill switch active', { rung, orderStatus: 'resolved' }));
      return;
    }

    if (rung === 'rumor') {
      recordDecision(db, skipRecord(item, 'rumor rung, stake 0', { rung, orderStatus: 'resolved' }));
      return;
    }

    const synopsis = await synopsize(anthropicClient, item.headline, item.snippet);
    const verification = await verifySynopsis(anthropicClient, item.headline, item.snippet, synopsis);
    if (!verification.supported) {
      recordDecision(
        db,
        skipRecord(item, `synopsis not supported by source: ${verification.note}`, {
          rung,
          orderStatus: 'resolved',
        })
      );
      return;
    }

    const ladder: ActiveLadder | null = await fetchLadder(KALSHI_SERIES_TICKER);
    if (ladder === null) {
      recordDecision(
        db,
        skipRecord(item, 'no active KXAPRPOTUS event found', { rung, orderStatus: 'resolved' })
      );
      return;
    }

    if (item.story_key !== null && hasOpenPosition(db, item.story_key, ladder.eventTicker)) {
      recordDecision(
        db,
        skipRecord(item, 'story already has an open position for the active event', {
          rung,
          eventTicker: ladder.eventTicker,
          orderStatus: 'resolved',
        })
      );
      return;
    }

    const decision = await decideTrade(anthropicClient, item.headline, item.snippet, synopsis, rung);
    if (!decision.shouldTrade) {
      recordDecision(
        db,
        skipRecord(item, decision.reasoning, {
          rung,
          eventTicker: ladder.eventTicker,
          direction: decision.direction,
          magnitudePts: decision.magnitudePts,
          orderStatus: 'resolved',
        })
      );
      return;
    }

    const sizing = evaluateSizing({
      bands: ladder.bands,
      rung,
      direction: decision.direction,
      magnitudePts: decision.magnitudePts,
      currentTotalExposureCents: totalExposureCents(db, ladder.eventTicker),
    });

    if (!sizing.wouldTrade) {
      recordDecision(db, {
        itemId: item.item_id,
        storyKey: item.story_key,
        eventTicker: ladder.eventTicker,
        marketTicker: sizing.marketTicker,
        side: sizing.side,
        rung,
        direction: decision.direction,
        magnitudePts: decision.magnitudePts,
        contracts: sizing.contracts,
        entryPriceCents: sizing.entryPriceCents,
        notionalCents: sizing.notionalCents,
        edgeCents: sizing.edgeCents,
        wouldTrade: sizing.wouldTrade,
        reason: sizing.reason,
        orderStatus: 'resolved',
      });
      return;
    }

    // Pending rows written BEFORE placeOrder is ever called -- this is what makes
    // hasDecisionForItem's dedup cover the entire execution step, and what durably
    // captures position_before_contracts even if the process crashes moments later.
    const pendingRecord: DecisionRecord = {
      itemId: item.item_id,
      storyKey: item.story_key,
      eventTicker: ladder.eventTicker,
      marketTicker: sizing.marketTicker,
      side: sizing.side,
      rung,
      direction: decision.direction,
      magnitudePts: decision.magnitudePts,
      contracts: sizing.contracts,
      entryPriceCents: sizing.entryPriceCents,
      notionalCents: sizing.notionalCents,
      edgeCents: sizing.edgeCents,
      wouldTrade: true,
      reason: sizing.reason,
      orderStatus: 'pending',
    };
    const decisionId = recordPendingDecision(db, pendingRecord);
    pendingDecisionId = decisionId;
    pendingRecordForCrash = pendingRecord;

    const clientOrderId = deriveClientOrderId(item.item_id);
    // Captured ONCE, here, before any order call -- stored durably in the orders row
    // (for reconcilePendingOrders to use if this process crashes moments later) and
    // passed into placeOrder directly, so there is exactly one read at exactly one
    // moment, never re-derived.
    const positionBeforeContracts = positionForTicker(await kalshiClient.getPositions(), sizing.marketTicker!);
    const orderId = recordPendingOrder(db, {
      decisionId,
      clientOrderId,
      marketTicker: sizing.marketTicker!,
      requestedContracts: sizing.contracts,
      positionBeforeContracts,
    });
    pendingOrderId = orderId;

    const placed = await placeOrder(
      {
        itemId: item.item_id,
        eventTicker: ladder.eventTicker,
        marketTicker: sizing.marketTicker!,
        side: sizing.side!,
        contracts: sizing.contracts,
        entryPriceCents: sizing.entryPriceCents!,
        notionalCents: sizing.notionalCents,
        positionBeforeContracts,
      },
      { client: kalshiClient, db }
    );

    resolveOrder(db, orderId, {
      filledContracts: placed.filledContracts,
      avgFillPriceCents: placed.avgFillPriceCents,
      status: placed.status,
      kalshiOrderId: placed.kalshiOrderId,
      errorDetail: placed.errorDetail,
    });

    const actualNotionalCents =
      placed.filledContracts > 0 ? placed.filledContracts * (placed.avgFillPriceCents ?? 0) : 0;
    resolveDecision(db, decisionId, {
      ...pendingRecord,
      contracts: placed.filledContracts,
      entryPriceCents: placed.filledContracts > 0 ? placed.avgFillPriceCents : null,
      notionalCents: actualNotionalCents,
      wouldTrade: placed.filledContracts > 0,
      reason: placed.errorDetail ?? `order ${placed.status}: ${placed.filledContracts}/${sizing.contracts} contracts filled`,
      orderStatus: 'resolved',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (pendingDecisionId !== null && pendingRecordForCrash !== null) {
      // A pending decision row for this item already exists (recordPendingDecision
      // ran before the exception, e.g. placeOrder threw per its own documented
      // uncaught-exception case). item_id's unique index means a second
      // recordDecision INSERT here would itself throw, so this path updates that
      // row in place instead -- but ONLY when the associated `orders` row is STILL
      // 'pending'. If it has already reached a terminal status, that means
      // resolveOrder already durably recorded a REAL fill outcome (e.g.
      // resolveDecision's own UPDATE below is what threw, after placeOrder and
      // resolveOrder both already succeeded) -- rewriting the decision row to
      // would_trade=false at that point would silently UNDER-report an actual
      // fill. That is not the safe direction: totalExposureCents sums would_trade=1
      // rows, so under-reporting a real fill undercounts real exposure and permits
      // MORE real risk than intended, not less. Worse, the orders row is no longer
      // 'pending', so Task 5's reconcilePendingOrders will never revisit it and fix
      // the mistake later. So: rethrow instead, letting main.ts's own backstop log
      // it loudly rather than this silently papering over an already-resolved order.
      const orderRow = pendingOrderId !== null
        ? (db.prepare('SELECT status FROM orders WHERE id = ?').get(pendingOrderId) as
            | { status: string }
            | undefined)
        : undefined;
      if (orderRow !== undefined && orderRow.status !== 'pending') {
        throw err;
      }
      // The orders row is still pending (or was never reached at all) -- the true
      // fill outcome is genuinely unknown, so it is safe to update the decision row
      // in place. Its order_status stays 'pending' rather than 'resolved': this
      // update only makes the interim state legible, it does not claim to be the
      // final answer -- Task 5's reconcilePendingOrders is what determines and
      // records the real outcome for both rows together at next boot.
      resolveDecision(db, pendingDecisionId, {
        ...pendingRecordForCrash,
        wouldTrade: false,
        reason: `pipeline error: ${message}`,
        orderStatus: 'pending',
      });
      return;
    }
    // If THIS insert throws too (a genuinely malformed record, or the DB itself),
    // let it propagate: main.ts's catch is the final backstop and will log it.
    recordDecision(db, skipRecord(item, `pipeline error: ${message}`, { rung, orderStatus: 'resolved' }));
  }
}
