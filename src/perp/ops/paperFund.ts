// src/perp/ops/paperFund.ts
import type Database from 'better-sqlite3';
import type { PaperState } from '../broker/paper.js';
import { appendJournal, getState, setState } from '../store/db.js';

/** Largest single paper top-up accepted, in USD: guards against a typo adding a fortune of fake collateral. */
export const PAPER_FUND_MAX_USD = 1000;

/**
 * Operator action (paper only): add `usd` of simulated collateral to the saved paper broker state. The entry guard
 * refuses entries once realized leverage (mark / equity) exceeds the governed leverage, so after enough paper losses
 * the bot stays flat until collateral is added; PERP_PAPER_EQUITY_USD cannot do it because the saved state wins on
 * restart. Run it only while the bot is stopped: the running bot would overwrite the saved state with its own copy.
 */
export function fundPaperInDb(db: Database.Database, usd: number, nowMs: number): { cashBefore: number; cashAfter: number } {
  if (!Number.isFinite(usd) || usd <= 0 || usd > PAPER_FUND_MAX_USD) {
    throw new Error(`usd must be a finite number > 0 and <= ${PAPER_FUND_MAX_USD}, got ${String(usd)}`);
  }
  const state = getState<PaperState>(db, 'paper');
  if (state === null) throw new Error('no paper state yet: start the bot once first');
  const cashBefore = state.cash;
  const cashAfter = cashBefore + usd;
  setState(db, 'paper', { ...state, cash: cashAfter });
  appendJournal(db, { tsMs: nowMs, kind: 'paper_funded', payload: { usd, cashBefore, cashAfter } });
  return { cashBefore, cashAfter };
}
