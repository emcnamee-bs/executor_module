// src/perp/collectors/calendar.ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { ScheduledEvent } from '../types.js';

// An offset-less timestamp would be read in the machine's local zone and shift event windows between machines, so the offset is mandatory.
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const EntrySchema = z.object({
  at: z
    .string()
    .regex(ISO_WITH_OFFSET, 'at must be an ISO-8601 timestamp with a Z or +hh:mm offset')
    .refine((s) => Number.isFinite(Date.parse(s)), 'at must be a valid ISO-8601 timestamp'),
  name: z.string().min(1),
  impact: z.enum(['high', 'medium']),
});
const FileSchema = z.array(EntrySchema);

function readAll(file: string): ScheduledEvent[] {
  const parsed = FileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return parsed.map((e) => ({ tsMs: Date.parse(e.at), name: e.name, impact: e.impact })).sort((a, b) => a.tsMs - b.tsMs);
}

/**
 * Scheduled events from the operator-maintained JSON file, from one hour ago to `horizonHours` ahead.
 * A missing or invalid file THROWS: silently trading through CPI/FOMC because the file vanished is worse than not starting.
 */
export function loadCalendar(file: string, nowMs: number, horizonHours = 72): ScheduledEvent[] {
  return readAll(file).filter((e) => e.tsMs >= nowMs - 3_600_000 && e.tsMs <= nowMs + horizonHours * 3_600_000);
}

/** Days from now until the last event in the file (0 when there are none), for a "calendar is running out" alert. */
export function calendarCoverageDays(file: string, nowMs: number): number {
  const all = readAll(file);
  if (all.length === 0) return 0;
  return Math.max(0, (all[all.length - 1].tsMs - nowMs) / 86_400_000);
}

/**
 * True when a HIGH-impact scheduled event lies within `windowMs` (default 2 h) before or after `nowMs`. Used by the news
 * escalation policy: a minor item is worth Sonnet's time around CPI/FOMC. A missing or invalid file THROWS, like loadCalendar.
 */
export function highImpactWindowOpen(file: string, nowMs: number, windowMs = 2 * 3_600_000): boolean {
  return readAll(file).some((e) => e.impact === 'high' && Math.abs(e.tsMs - nowMs) <= windowMs);
}
