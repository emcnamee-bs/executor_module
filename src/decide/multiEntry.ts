// src/decide/multiEntry.ts
//
// Turns a checked `multi` decision into paper legs and the decision row (multi-market spec, 3.4-3.5).
// Paper only by construction: it sizes against PAPER_CAPS, writes paper_positions and one
// `would_trade = 0` decisions row, and imports nothing that can place an order.
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import type { Rung } from './rung.js';
import type { ActiveLadder } from './kalshi.js';
import type { OutcomeGroup } from '../profile/profile.js';
import type { DecisionRecord } from './ledger.js';
import type { MultiMove } from './decideMulti.js';
import { evaluateMultiSizing } from './sizing.js';
import { skipRecord } from './skipRecord.js';
import { recordPaperLegs, paperExposureCents, PAPER_CAPS } from '../paper/paper.js';
import { hasSellTrigger } from '../paper/exits.js';

export interface MultiEntryArgs {
  db: Database.Database;
  item: Item;
  trade: string;
  rung: Rung;
  ladder: ActiveLadder;
  moves: MultiMove[];
  reasoning: string;
  outcomeGroup: OutcomeGroup;
  /** Prefixes the low-tier-relaxed tag onto stored text (the pipeline's `lowTierTag`). */
  tag: (text: string) => string;
  /** The pipeline's `record` (applies the same tag to decision rows). */
  record: (rec: DecisionRecord) => void;
}

export function applyMultiEntry(a: MultiEntryArgs): void {
  const { db, item, ladder } = a;
  if (a.moves.length === 0) {
    a.record(skipRecord(item, 'multi sizing: no moves to size', { rung: a.rung, eventTicker: ladder.eventTicker, orderStatus: 'resolved' }));
    return;
  }

  // A market that already had an exit trigger is never bought back on paper. Dropped BEFORE sizing,
  // so it can never take a leg slot from a valid market.
  const reasons: string[] = [];
  const movesToSize = a.moves.filter((m) => {
    if (!hasSellTrigger(db, m.market)) return true;
    reasons.push(`exit trigger already fired on ${m.market}; not re-entering`);
    return false;
  });
  const sizing = evaluateMultiSizing({
    markets: ladder.bands,
    moves: movesToSize,
    maxLegs: a.outcomeGroup === 'exclusive' ? 2 : 1,
    rung: a.rung,
    currentTotalExposureCents: paperExposureCents(db, ladder.eventTicker),
    caps: PAPER_CAPS,
  });
  reasons.push(...sizing.reasons);
  const legs = sizing.legs;

  const lead = a.moves.reduce((best, m) => (Math.abs(m.shift) > Math.abs(best.shift) ? m : best), a.moves[0]);
  const base = { rung: a.rung, eventTicker: ladder.eventTicker, direction: lead.shift > 0 ? ('up' as const) : ('down' as const), magnitudePts: Math.abs(lead.shift), orderStatus: 'resolved' as const };

  if (legs.length === 0) {
    a.record(skipRecord(item, reasons.length > 0 ? `multi sizing: ${reasons.join('; ')}` : 'multi sizing: no move produced a tradeable leg', base));
    return;
  }

  const ladderJson = JSON.stringify({ eventTicker: ladder.eventTicker, strikeDate: ladder.strikeDate, bands: ladder.bands });
  recordPaperLegs(
    db,
    item.item_id,
    legs.map((leg) => ({
      trade: a.trade,
      itemId: item.item_id,
      structure: 'multi' as const,
      eventTicker: ladder.eventTicker,
      marketTicker: leg.marketTicker,
      side: leg.side,
      contracts: leg.contracts,
      entryPriceCents: leg.entryPriceCents,
      direction: leg.shift > 0 ? ('up' as const) : ('down' as const),
      magnitude: Math.abs(leg.shift),
      edgeCents: leg.edgeCents,
      reasoning: a.tag(a.reasoning),
      ladderJson,
    }))
  );
  const bought = legs.map((l) => `${l.contracts} ${l.side} ${l.marketTicker} @${l.entryPriceCents}c`).join(' + ');
  a.record(skipRecord(item, `[PAPER multi] ${bought}: ${a.reasoning}`, base));
}
