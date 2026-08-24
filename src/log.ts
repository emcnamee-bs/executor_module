import type { Item } from './item.js';

export function formatSummaryLine(item: Item): string {
  const headlinePart = item.provenance_gaps.includes('synthetic_headline')
    ? `[synthetic] ${item.headline}`
    : item.headline;
  const replayTag = item.replay ? ' REPLAY' : '';

  return `[${item.item_id}] source=${item.source_id} trust=${item.trust_tier} event=${item.event_type}${replayTag} :: ${headlinePart}`;
}
