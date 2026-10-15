// src/perp/ops/replay.ts
//
// Offline funnel check: run a list of real stream items through the prefilter, in order, with a fresh state, and summarise
// what would reach Haiku. Pure (no I/O); the script feeds it from Redis.
import type { Item } from '../../item.js';
import { hygieneSkip } from '../intake/hygiene.js';
import { createPrefilterState, prefilter, recordPass, type PrefilterConfig } from '../intake/prefilter.js';

export interface ReplaySummary {
  total: number;
  hygiene: number;
  evaluated: number;
  passed: number;
  byReason: Record<string, number>;
  bySource: Record<string, { evaluated: number; passed: number }>;
}

/** `nowFor(item)` is the clock for that item (default: the item's own publish/first-seen time, so replays of old items are not "stale"). */
export function replayItems(items: Item[], cfg: PrefilterConfig, nowFor?: (item: Item) => number): ReplaySummary {
  const state = createPrefilterState();
  const out: ReplaySummary = { total: 0, hygiene: 0, evaluated: 0, passed: 0, byReason: {}, bySource: {} };
  const clock = nowFor ?? ((it: Item) => Date.parse(it.source_publish_ts ?? it.first_seen_ts) + 60_000);
  for (const item of items) {
    out.total += 1;
    const now = clock(item);
    if (hygieneSkip(item, now) !== null) { out.hygiene += 1; continue; }
    const v = prefilter(item, cfg, state, now);
    out.evaluated += 1;
    out.byReason[v.reason] = (out.byReason[v.reason] ?? 0) + 1;
    const src = (out.bySource[item.source_id] ??= { evaluated: 0, passed: 0 });
    src.evaluated += 1;
    if (v.pass) {
      out.passed += 1;
      src.passed += 1;
      recordPass(state, item, v, now, cfg);
    }
  }
  return out;
}

export function formatReplay(s: ReplaySummary): string {
  const lines = [
    `items ${s.total}; skipped by hygiene ${s.hygiene}; evaluated ${s.evaluated}; passed to Haiku ${s.passed} (${s.evaluated === 0 ? 0 : ((100 * s.passed) / s.evaluated).toFixed(1)}%)`,
    `by reason: ${Object.entries(s.byReason).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    'source                       evaluated  passed',
  ];
  for (const [src, v] of Object.entries(s.bySource).sort((a, b) => b[1].evaluated - a[1].evaluated)) {
    lines.push(`${src.padEnd(28)} ${String(v.evaluated).padStart(9)}  ${String(v.passed).padStart(6)}`);
  }
  return lines.join('\n');
}
