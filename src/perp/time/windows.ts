// src/perp/time/windows.ts
import type { ScheduledEvent } from '../types.js';

export const MS_PER_MIN = 60_000;

/** Minutes until the next scheduled market close; null when the exchange does not report one. */
export function minutesToClose(nowMs: number, nextCloseTsMs: number | null): number | null {
  return nextCloseTsMs === null ? null : (nextCloseTsMs - nowMs) / MS_PER_MIN;
}

/** True when `nowMs` is within +-`minutes` of any high-impact scheduled event. */
export function inEventWindow(nowMs: number, events: ScheduledEvent[], minutes: number): boolean {
  return events.some((e) => e.impact === 'high' && Math.abs(e.tsMs - nowMs) <= minutes * MS_PER_MIN);
}

/** True when a high-impact event is strictly ahead and starts within `withinMinutes`. */
export function eventSoon(nowMs: number, events: ScheduledEvent[], withinMinutes: number): boolean {
  return events.some((e) => e.impact === 'high' && e.tsMs > nowMs && e.tsMs - nowMs <= withinMinutes * MS_PER_MIN);
}
