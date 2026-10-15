// src/perp/intake/escalate.ts
//
// Which Haiku results reach Sonnet (spec section 4). Pure: the caller supplies the calendar fact and the Sonnet count.
import type { SourceClass } from './prefilter.js';

export type Impact = 'none' | 'minor' | 'moderate' | 'major';
export type EscalateReason = 'impact' | 'calendar' | 'official' | 'none' | 'below_threshold' | 'sonnet_cap';

export interface EscalateInput {
  impact: Impact;
  sourceClass: SourceClass;
  /** A high-impact scheduled event is within +-2 h of now. */
  calendarWindowOpen: boolean;
  sonnetPassesLastHour: number;
  sonnetPerHour: number;
}

export function escalate(i: EscalateInput): { escalate: boolean; reason: EscalateReason } {
  if (i.impact === 'none') return { escalate: false, reason: 'none' };
  const official = i.sourceClass === 'official_macro';
  let wanted: EscalateReason | null = null;
  if (official) wanted = 'official';
  else if (i.impact === 'moderate' || i.impact === 'major') wanted = 'impact';
  else if (i.impact === 'minor' && i.calendarWindowOpen) wanted = 'calendar';
  if (wanted === null) return { escalate: false, reason: 'below_threshold' };
  const bypassCap = official || i.impact === 'major';
  if (!bypassCap && i.sonnetPassesLastHour >= i.sonnetPerHour) return { escalate: false, reason: 'sonnet_cap' };
  return { escalate: true, reason: wanted };
}
