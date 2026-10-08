// src/decide/pipeline.ts
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { OllamaClient } from './ollamaClient.js';
import type { Item } from '../item.js';
import { computeRungDetailed, type Rung } from './rung.js';
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
  isTradingHalted,
  checkFailedOrdersSignal,
  recentTradeCount,
  MAX_TRADES_PER_WINDOW,
  RATE_LIMIT_WINDOW_MINUTES,
  type DecisionRecord,
} from './ledger.js';
import { evaluateSizing, evaluateBinarySizing, type SizingResult } from './sizing.js';
import { runGate } from './gate.js';
import { triageItem } from './triage.js';
import { decideTrade } from './decide.js';
import { placeOrder, deriveClientOrderId } from '../execute/order.js';
import { positionForTicker, type KalshiClient } from '../execute/kalshiClient.js';
import { fetchArticle, articleToText, snippetArticle } from '../fetch/excerpt.js';
import { detectInjection, MAX_SOURCE_CHARS } from '../guard/untrusted.js';
import { recordPaperPosition, hasPaperPosition, paperExposureCents, PAPER_CAPS } from '../paper/paper.js';
import type { LoadedProfile } from '../profile/profile.js';

export interface PipelineDeps {
  anthropicClient: Anthropic;
  ollamaClient: OllamaClient;
  db: Database.Database;
  fetchLadder: typeof fetchActiveLadder;
  kalshiClient: KalshiClient;
  profile: LoadedProfile;
  fetchArticle: typeof fetchArticle;
  /**
   * EXECUTOR_PAPER_LOW_TIER as resolved by prepareStartup (resolvePaperLowTier). Honoured
   * only when this process is ALSO dry-run and not the live unit, re-checked per item
   * below, so a live-capable process can never relax even if startup were bypassed.
   */
  paperLowTier?: boolean;
}

/**
 * Defence in depth for the paper-only low-tier test: the startup value alone is never
 * enough. KALSHI_DRY_RUN must be exactly "true" and EXECUTOR_LIVE_TRADE absent, read
 * here at the call site, every item.
 */
function lowTierRelaxationAllowed(deps: Pick<PipelineDeps, 'paperLowTier'>): boolean {
  return (
    deps.paperLowTier === true &&
    process.env.KALSHI_DRY_RUN === 'true' &&
    process.env.EXECUTOR_LIVE_TRADE === undefined
  );
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
    orderStatus: 'resolved',
    ...overrides,
  };
}

export async function runDecisionPipeline(item: Item, deps: PipelineDeps): Promise<void> {
  const { anthropicClient, ollamaClient, db, fetchLadder, kalshiClient, profile: loaded } = deps;
  const trade = loaded.profile.name;
  const structure = loaded.profile.marketStructure;
  const isDirect = loaded.profile.directSources.includes(item.source_id);

  // Redis delivery is at-least-once: an item that already has a ledger row was fully
  // processed by an earlier delivery, so the correct action is a silent no-op.
  if (hasDecisionForItem(db, item.item_id)) {
    return;
  }

  // Pure and free (reads only trust_tier, story_key, corroborations), so it runs
  // before any fetch or model call: a guaranteed-skip 'rumor' item costs nothing.
  const { rung, lowTierRelaxedFrom } = computeRungDetailed({
    trustTier: item.trust_tier,
    storyKey: item.story_key,
    corroborations: item.corroborations,
    relaxLowTier: lowTierRelaxationAllowed(deps),
  });
  const lowTierRelaxed = lowTierRelaxedFrom !== null;
  // Every row a relaxed item writes carries this prefix, so analysis can always tell a
  // low-tier-test decision from an ordinary one without a schema change.
  const lowTierTag = (text: string): string =>
    lowTierRelaxed ? `[low-tier relaxed: tier ${lowTierRelaxedFrom}] ${text}` : text;
  const record = (rec: DecisionRecord): void => {
    recordDecision(db, { ...rec, reason: lowTierTag(rec.reason) });
  };

  // Hoisted so the catch below can tell whether the pending decision row was already
  // written before it decides how to record a failure (see the catch block).
  let pendingDecisionId: number | null = null;
  let pendingOrderId: number | null = null;
  let pendingRecordForCrash: DecisionRecord | null = null;

  // Everything from here on is wrapped: the Redis consumer acks the entry once this
  // handler returns, so an escaping exception would lose the item with no trace.
  try {
    const paper = process.env.KALSHI_DRY_RUN === 'true';
    if (structure !== 'band' && !paper) {
      // Defence in depth: main() already refuses to start in this state.
      throw new Error(`structure ${structure} is paper-only; KALSHI_DRY_RUN is not "true"`);
    }

    const manualHalt = process.env.EXECUTOR_TRADING_HALTED === 'true';
    if (manualHalt || isTradingHalted(db)) {
      const reason = manualHalt ? 'kill switch active' : 'circuit breaker tripped';
      record(skipRecord(item, reason, { rung, orderStatus: 'resolved' }));
      return;
    }

    if (rung === 'rumor') {
      record(skipRecord(item, 'rumor rung, stake 0', { rung, orderStatus: 'resolved' }));
      return;
    }

    // Checked BEFORE any fetch or model call: a rate-limited item must never spend
    // network, local compute or API cost on a decision that will be declined anyway.
    if (recentTradeCount(db, RATE_LIMIT_WINDOW_MINUTES) >= MAX_TRADES_PER_WINDOW) {
      record(
        skipRecord(item, `rate limit: ${MAX_TRADES_PER_WINDOW} trade(s) per ${RATE_LIMIT_WINDOW_MINUTES} minutes already reached`, {
          rung, orderStatus: 'resolved',
        })
      );
      return;
    }

    // One fetch, capped at the per-source ceiling. Gate and triage see the first 800
    // characters of it (capped again inside their wrappers); the decision sees all of
    // it. A direct source IS the resolution data, so its own snippet is the article.
    const fetchedRaw = isDirect ? null : await deps.fetchArticle(item.url, { maxChars: MAX_SOURCE_CHARS });
    // A page that fetched but yielded no text (e.g. JS-rendered) is no article at all:
    // fall back to the headline+snippet rather than feed the models an empty 'page'.
    const fetched = fetchedRaw !== null && articleToText(fetchedRaw).trim() !== '' ? fetchedRaw : null;
    const article = fetched ?? snippetArticle(item.headline, item.snippet, MAX_SOURCE_CHARS);
    const excerptSource: 'page' | 'snippet' = fetched ? 'page' : 'snippet';
    const articleText = articleToText(article);

    // Deterministic injection tripwire over everything a model will read. A hit never
    // drops the item: it bypasses the (flippable) local gate and goes to Sonnet with a
    // warning, because a model that can be talked out of "relevant" is the harmful case.
    const tripwireHit = detectInjection(articleText).length > 0;
    if (tripwireHit) {
      console.warn(`[TRIPWIRE] item=${item.item_id} source=${item.source_id} text contains instruction-like content; bypassing the local gate`);
    }

    let gateReason: string | null = null;
    if (!isDirect && !tripwireHit) {
      let gate;
      try {
        gate = await runGate(
          { ollama: ollamaClient, db, profile: loaded },
          { itemId: item.item_id, excerptText: articleText, excerptSource, tripwireHit }
        );
      } catch (err) {
        // Malformed output (GateError) or an Ollama failure, including a timeout: the
        // gate's own ai_calls row is already written. Recorded with the spec's
        // `gate error:` prefix (final review M2) so analysis queries can find it; no
        // pending row exists yet, so a plain skip is correct.
        const message = err instanceof Error ? err.message : String(err);
        record(skipRecord(item, `gate error: ${message}`, { rung, orderStatus: 'resolved' }));
        return;
      }
      if (!gate.relevant) {
        record(skipRecord(item, `gate: not relevant: ${gate.reason}`, { rung, orderStatus: 'resolved' }));
        return;
      }
      gateReason = gate.reason;
    }

    const triage = await triageItem(anthropicClient, db, {
      loaded, itemId: item.item_id, excerptText: articleText, excerptSource, gateReason, tripwireHit,
    });
    if (triage.verdict === 'skip') {
      record(skipRecord(item, `triage: ${triage.reason}`, { rung, orderStatus: 'resolved' }));
      return;
    }

    const ladder: ActiveLadder | null = await fetchLadder(loaded.profile.seriesTicker, db);
    if (ladder === null) {
      record(
        skipRecord(item, `no active ${loaded.profile.seriesTicker} event found`, { rung, orderStatus: 'resolved' })
      );
      return;
    }

    if (item.story_key !== null && hasOpenPosition(db, item.story_key, ladder.eventTicker)) {
      record(
        skipRecord(item, 'story already has an open position for the active event', {
          rung,
          eventTicker: ladder.eventTicker,
          orderStatus: 'resolved',
        })
      );
      return;
    }

    const decision = await decideTrade(anthropicClient, db, {
      loaded, itemId: item.item_id, articleText, excerptSource, rung, lowTierRelaxed, tripwireHit, triageReason: triage.reason,
    });
    if (!decision.shouldTrade) {
      record(
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

    const ladderJson = JSON.stringify({ eventTicker: ladder.eventTicker, strikeDate: ladder.strikeDate, bands: ladder.bands });
    const paperRecord = (sizing: SizingResult | null): void => {
      // Idempotent: a crash between this row and the decision row re-delivers the item,
      // and item_id is UNIQUE in paper_positions.
      if (hasPaperPosition(db, item.item_id)) return;
      recordPaperPosition(db, {
        trade,
        itemId: item.item_id,
        structure,
        eventTicker: ladder.eventTicker,
        marketTicker: sizing?.wouldTrade ? sizing.marketTicker : null,
        side: sizing?.wouldTrade ? sizing.side : null,
        contracts: sizing?.wouldTrade ? sizing.contracts : 0,
        entryPriceCents: sizing?.wouldTrade ? sizing.entryPriceCents : null,
        direction: decision.direction,
        magnitude: decision.magnitudePts,
        edgeCents: sizing?.edgeCents ?? null,
        reasoning: lowTierTag(decision.reasoning),
        ladderJson,
      });
    };

    if (structure === 'capture') {
      paperRecord(null);
      record(
        skipRecord(item, `[PAPER capture] ${decision.direction} ${decision.magnitudePts} ${loaded.profile.magnitudeUnit}: ${decision.reasoning}`, {
          rung, eventTicker: ladder.eventTicker, direction: decision.direction, magnitudePts: decision.magnitudePts, orderStatus: 'resolved',
        })
      );
      return;
    }

    if (structure === 'binary') {
      // A binary event has exactly one market; anything else is a mis-pinned series, so
      // decline rather than guess which market to buy.
      const market = ladder.bands.length === 1 ? ladder.bands[0] : undefined;
      const binary = market
        ? evaluateBinarySizing({ market, direction: decision.direction, rung })
        : null;
      if (binary === null || !binary.wouldTrade) {
        record(
          skipRecord(item, binary === null ? `binary event must have exactly one market, found ${ladder.bands.length}` : binary.reason, {
            rung, eventTicker: ladder.eventTicker, direction: decision.direction, magnitudePts: decision.magnitudePts, orderStatus: 'resolved',
          })
        );
        return;
      }
      paperRecord(binary);
      record(
        skipRecord(item, `[PAPER] would buy ${binary.contracts} ${binary.side} on ${binary.marketTicker} at ${binary.entryPriceCents}c: ${decision.reasoning}`, {
          rung, eventTicker: ladder.eventTicker, direction: decision.direction, magnitudePts: decision.magnitudePts, orderStatus: 'resolved',
        })
      );
      return;
    }

    // band and threshold: the existing shift-and-interpolate sizing, with the curve
    // built from bands or from thresholds.
    const sizingBase = {
      bands: ladder.bands,
      rung,
      direction: decision.direction,
      magnitudePts: decision.magnitudePts,
      curveKind: (structure === 'threshold' ? 'threshold' : 'band') as 'band' | 'threshold',
    };

    // Paper research position: sized against its OWN bankroll (PAPER_CAPS) because at the
    // live $1.25 cap almost every edge sizes to zero contracts. Written before and
    // independently of the real-cap sizing below, so a failure in the simulated-order
    // path can never lose the evidence of what the model decided.
    const paperSizing = paper
      ? evaluateSizing({ ...sizingBase, currentTotalExposureCents: paperExposureCents(db, ladder.eventTicker), caps: PAPER_CAPS })
      : null;
    if (paperSizing?.wouldTrade) paperRecord(paperSizing);

    // A low-tier-relaxed item is research data only: it stops at the paper row and
    // NEVER reaches live-cap sizing, the pending rows or placeOrder (not even the
    // dry-run simulation), so the relaxation can never touch the real order path.
    if (lowTierRelaxed) {
      record(skipRecord(item, paperSizing?.wouldTrade
        ? `[PAPER ${paperSizing.contracts} ${paperSizing.side} ${paperSizing.marketTicker} @${paperSizing.entryPriceCents}c] ${decision.reasoning}`
        : `paper sizing: ${paperSizing?.reason ?? 'not paper'}`, {
        rung, eventTicker: ladder.eventTicker, direction: decision.direction, magnitudePts: decision.magnitudePts, orderStatus: 'resolved',
      }));
      return;
    }

    const sizing = evaluateSizing({
      ...sizingBase,
      currentTotalExposureCents: totalExposureCents(db, ladder.eventTicker),
    });

    if (!sizing.wouldTrade) {
      record({
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
        reason: paperSizing?.wouldTrade
          ? `[PAPER ${paperSizing.contracts} ${paperSizing.side} ${paperSizing.marketTicker} @${paperSizing.entryPriceCents}c; live-cap sizing: ${sizing.reason}]`
          : sizing.reason,
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
      // Stored durably because Kalshi's `position` is SIGNED: crash recovery has
      // only this row to interpret a position diff against, and reading a NO fill
      // as a YES-shaped diff records a real position as zero contracts.
      side: sizing.side!,
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

    // A DRY_RUN's "fill" is simulated locally and is NOT a real position. The
    // `orders` row still records the simulation (already unmistakably marked by the
    // DRYRUN- prefix on kalshi_order_id) for audit, but the `decisions` row -- the
    // one every exposure-cap and dedup query actually reads -- must record it as a
    // skip. Otherwise the documented "dry run first, then go live" workflow leaves
    // phantom positions consuming the real $40 cap and makes hasOpenPosition true
    // for stories that never traded.
    const isRealFill = !placed.dryRun && placed.filledContracts > 0;
    const actualNotionalCents = isRealFill ? placed.filledContracts * (placed.avgFillPriceCents ?? 0) : 0;
    const resolvedReason = placed.dryRun
      ? `[DRY_RUN simulated] would have filled ${placed.filledContracts}/${sizing.contracts} contracts ` +
        `at ${placed.avgFillPriceCents}c -- not a real position`
      : (placed.errorDetail ?? `order ${placed.status}: ${placed.filledContracts}/${sizing.contracts} contracts filled`);

    // ONE transaction: resolveOrder alone committing a terminal status while
    // resolveDecision fails (or the process dies in the gap) makes the order
    // invisible to reconcilePendingOrders -- which scans only status='pending' --
    // leaving a real filled position permanently reported as zero exposure.
    // Rolled back together, both rows stay pending and startup recovery fixes them.
    db.transaction(() => {
      resolveOrder(db, orderId, {
        filledContracts: placed.filledContracts,
        avgFillPriceCents: placed.avgFillPriceCents,
        status: placed.status,
        kalshiOrderId: placed.kalshiOrderId,
        kalshiOrderStatus: placed.kalshiOrderStatus,
        errorDetail: placed.errorDetail,
      });
      resolveDecision(db, decisionId, {
        ...pendingRecord,
        contracts: isRealFill ? placed.filledContracts : 0,
        entryPriceCents: isRealFill ? placed.avgFillPriceCents : null,
        notionalCents: actualNotionalCents,
        wouldTrade: isRealFill,
        reason: resolvedReason,
        orderStatus: 'resolved',
      });
    })();

    checkFailedOrdersSignal(db, placed.status);
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
      //
      // The transactional resolve above now makes this state unreachable via the
      // success path (a failing resolveDecision rolls resolveOrder back with it, so
      // the orders row is still 'pending' here and recovery CAN fix it later). This
      // guard stays as the invariant check for any other path that could leave a
      // terminal orders row behind an unresolved decision row.
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
    record(skipRecord(item, `pipeline error: ${message}`, { rung, orderStatus: 'resolved' }));
  }
}
