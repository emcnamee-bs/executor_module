// src/decide/skipRecord.ts
import type { Item } from '../item.js';
import type { Rung } from './rung.js';
import type { DecisionRecord } from './ledger.js';

/**
 * `rung` is required, not defaulted: it is computed from `Item` fields alone, before
 * any model call and therefore before every skip point below, so no skip row ever
 * needs a placeholder standing in for "not yet computed".
 */
export function skipRecord(
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
