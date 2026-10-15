// src/decide/periodCheck.ts
//
// Entry period check (2026-10-14 audit). The CPI trade bought YES on "October CPI" from articles about the
// SEPTEMBER print, the model writing that the figure "effectively resolves the market"; the market itself (closing
// Nov 10) kept quoting 19-20c. Dated news can only inform a market that settles on the same period, so every entry
// decision must now also state whether its shift treats an article about a different period as this market's
// settlement data. Code, not the model, enforces the answer: a buy needs period_matches === true, and a missing or
// false answer fails closed to "no trade".
import type { TradeProfile } from '../profile/profile.js';

/** Structured-output fields every entry decision carries (no numeric constraints: see decide.ts). */
export const PERIOD_FIELDS = {
  period_matches: { type: 'boolean' },
  period_note: { type: 'string' },
} as const;

export const PERIOD_REQUIRED = ['period_matches', 'period_note'] as const;

/** The prompt paragraph, naming the market's own period so the model has something to compare against. */
export function periodRule(profile: Pick<TradeProfile, 'title' | 'settlement'>): string {
  return `PERIOD CHECK. This market is: "${profile.title}". It settles as follows: ${profile.settlement}
Before you recommend any entry, compare the period, date, release or event the article's figures or events belong to with the period this market settles on. Answer period_matches: true if your shift rests on evidence about the period this market settles on, or on drivers of it that are not tied to a different period. Answer false if your shift treats an article about a DIFFERENT period (another month, week, year, meeting or release: for example the September CPI report for an October CPI market, or last week's count for this week's market) as if it were this market's own settlement data. period_note: one sentence naming the period the article covers and the period this market settles on. When period_matches is false the entry is not made.`;
}

export interface PeriodAnswer {
  ok: boolean;
  /** The model's note, trimmed; empty when it gave none. */
  note: string;
}

/** True only for a literal boolean true. Anything else (missing, false, a string) is a mismatch. */
export function readPeriod(raw: { period_matches?: unknown; period_note?: unknown }): PeriodAnswer {
  const note = typeof raw.period_note === 'string' ? raw.period_note.trim() : '';
  return { ok: raw.period_matches === true, note };
}

/** The reason recorded when a buy is turned into no trade. */
export function periodMismatchReason(answer: PeriodAnswer): string {
  return `period mismatch, not entering: ${answer.note || 'the model did not confirm the article is about the period this market settles on'}`;
}
