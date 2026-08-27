// src/decide/pipeline.ts
import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import { computeRung } from './rung.js';
import { fetchActiveLadder, type ActiveLadder } from './kalshi.js';
import { recordDecision, hasOpenPosition, totalExposureCents, type DecisionRecord } from './ledger.js';
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

function skipRecord(item: Item, reason: string, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    itemId: item.item_id,
    storyKey: item.story_key,
    eventTicker: null,
    marketTicker: null,
    side: null,
    rung: 'rumor',
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

  if (process.env.EXECUTOR_TRADING_HALTED === 'true') {
    recordDecision(db, skipRecord(item, 'kill switch active'));
    return;
  }

  const synopsis = await synopsize(anthropicClient, item.headline, item.snippet);
  const verification = await verifySynopsis(anthropicClient, item.headline, item.snippet, synopsis);
  if (!verification.supported) {
    recordDecision(db, skipRecord(item, `synopsis not supported by source: ${verification.note}`));
    return;
  }

  const rung = computeRung({
    trustTier: item.trust_tier,
    storyKey: item.story_key,
    corroborations: item.corroborations,
  });
  if (rung === 'rumor') {
    recordDecision(db, skipRecord(item, 'rumor rung, stake 0', { rung }));
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
    currentTotalExposureCents: totalExposureCents(db),
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
}
