// src/decide/pipeline.ts
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import { computeRung, type Rung } from './rung.js';
import { fetchActiveLadder, type ActiveLadder } from './kalshi.js';
import {
  recordDecision,
  hasDecisionForItem,
  hasOpenPosition,
  totalExposureCents,
  type DecisionRecord,
} from './ledger.js';
import { evaluateSizing } from './sizing.js';
import { synopsize } from './synopsis.js';
import { verifySynopsis } from './verify.js';
import { decideTrade } from './decide.js';

const KALSHI_SERIES_TICKER = 'KXAPRPOTUS';

export interface PipelineDeps {
  anthropicClient: Anthropic;
  db: Database.Database;
  fetchLadder: typeof fetchActiveLadder;
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
    ...overrides,
  };
}

export async function runDecisionPipeline(item: Item, deps: PipelineDeps): Promise<void> {
  const { anthropicClient, db, fetchLadder } = deps;

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

  // Everything from here on is wrapped: the Redis consumer acks the entry once this
  // handler returns, so an escaping exception loses the item with no durable trace
  // at all. A recorded skip row is the trace. (This has already happened once in
  // production: a transient truncated-JSON parse error left nothing behind.)
  try {
    if (process.env.EXECUTOR_TRADING_HALTED === 'true') {
      recordDecision(db, skipRecord(item, 'kill switch active', { rung }));
      return;
    }

    if (rung === 'rumor') {
      recordDecision(db, skipRecord(item, 'rumor rung, stake 0', { rung }));
      return;
    }

    const synopsis = await synopsize(anthropicClient, item.headline, item.snippet);
    const verification = await verifySynopsis(anthropicClient, item.headline, item.snippet, synopsis);
    if (!verification.supported) {
      recordDecision(
        db,
        skipRecord(item, `synopsis not supported by source: ${verification.note}`, { rung })
      );
      return;
    }

    const ladder: ActiveLadder | null = await fetchLadder(KALSHI_SERIES_TICKER);
    if (ladder === null) {
      recordDecision(db, skipRecord(item, 'no active KXAPRPOTUS event found', { rung }));
      return;
    }

    if (item.story_key !== null && hasOpenPosition(db, item.story_key, ladder.eventTicker)) {
      recordDecision(
        db,
        skipRecord(item, 'story already has an open position for the active event', {
          rung,
          eventTicker: ladder.eventTicker,
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
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If THIS insert throws too (a genuinely malformed record, or the DB itself),
    // let it propagate: main.ts's catch is the final backstop and will log it.
    recordDecision(db, skipRecord(item, `pipeline error: ${message}`, { rung }));
  }
}
