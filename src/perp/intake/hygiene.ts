// src/perp/intake/hygiene.ts
//
// The stateless checks every news item gets before anything costs money, shared by the bot's intake and the lab so both
// judge exactly the same items. The stateful ones (already seen, no market context) stay with their owners.
import type { Item } from '../../item.js';

export type HygieneSkip = 'skipped_replay' | 'skipped_amended' | 'skipped_bad_time' | 'skipped_old';

export const DEFAULT_MAX_AGE_MS = 6 * 3_600_000;
/** A publish time further than this in the future is clock trouble or garbage, not news: skip it. */
export const MAX_FUTURE_SKEW_MS = 10 * 60_000;

/** Epoch ms of an ISO timestamp; NaN for a missing, empty or unparseable value. */
const parseTs = (v: string | null | undefined): number => (typeof v === 'string' && v.trim() !== '' ? Date.parse(v) : NaN);

export function hygieneSkip(item: Item, nowMs: number, maxAgeMs: number = DEFAULT_MAX_AGE_MS): HygieneSkip | null {
  if (item.replay) return 'skipped_replay';
  if (item.event_type === 'item_amended') return 'skipped_amended';
  // Fail closed on time: the publish time (else first-seen time) must parse and must not lie in the future.
  const publishedRaw = parseTs(item.source_publish_ts);
  const published = Number.isFinite(publishedRaw) ? publishedRaw : parseTs(item.first_seen_ts);
  if (!Number.isFinite(published) || published - nowMs > MAX_FUTURE_SKEW_MS) return 'skipped_bad_time';
  if (nowMs - published > maxAgeMs) return 'skipped_old';
  return null;
}
