// src/paper/exitFill.ts
//
// Simulated sell at the touch (spec section 3): the held side's best bid, capped at the size shown
// at the touch. No bid = unsellable (retried); a closed or missing market = held to settlement.
import type Database from 'better-sqlite3';
import type { BandMarket } from '../decide/kalshi.js';
import { recordExitFill, recordExitMarker, remainingContracts, type OpenPaperPosition } from './exits.js';

export type FillOutcome = 'filled' | 'partial' | 'unsellable' | 'held_to_settlement';

export interface FillAttempt {
  outcome: FillOutcome;
  /** Contracts sold by THIS attempt (0 for unsellable / held / nothing left). */
  contracts: number;
  priceCents: number | null;
  remaining: number;
  exitId: number | null;
  filledAt: string | null;
}

/** What hooks (such as the lateness job) receive after a fill. */
export interface ExitFillInfo {
  positionId: number;
  reviewId: number;
  exitId: number;
  contracts: number;
  priceCents: number;
  remaining: number;
  filledAt: string;
}

export function attemptExitFill(
  db: Database.Database,
  args: { position: OpenPaperPosition; reviewId: number; market: BandMarket | null; filledAt?: string }
): FillAttempt {
  const { position, reviewId, market } = args;
  const remaining = remainingContracts(db, position.id);
  const none = (outcome: FillOutcome): FillAttempt => ({ outcome, contracts: 0, priceCents: null, remaining, exitId: null, filledAt: null });

  if (remaining <= 0) return none('filled');
  if (market === null || market.status !== 'active') {
    recordExitMarker(db, position.id, reviewId, 'held_to_settlement');
    return none('held_to_settlement');
  }

  const bid = position.side === 'yes' ? market.yesBidCents : market.yesAskCents === null ? null : 100 - market.yesAskCents;
  const size = position.side === 'yes' ? market.yesBidSizeContracts : market.yesAskSizeContracts;
  if (bid === null || bid <= 0 || size <= 0) {
    recordExitMarker(db, position.id, reviewId, 'unsellable');
    return none('unsellable');
  }

  const qty = Math.min(remaining, size);
  const filledAt = args.filledAt ?? new Date().toISOString();
  const fill = recordExitFill(db, { positionId: position.id, reviewId, contracts: qty, priceCents: Math.min(bid, 100), filledAt });
  return {
    outcome: fill.closed ? 'filled' : 'partial',
    contracts: qty,
    priceCents: Math.min(bid, 100),
    remaining: fill.remaining,
    exitId: fill.exitId,
    filledAt,
  };
}

export function logExitFill(position: OpenPaperPosition, a: FillAttempt): void {
  if (a.contracts > 0) {
    console.log(`[EXIT FILL] trade=${position.trade} market=${position.marketTicker} side=${position.side} sold=${a.contracts} @${a.priceCents}c remaining=${a.remaining}`);
  } else {
    console.log(`[EXIT ${a.outcome.toUpperCase()}] trade=${position.trade} market=${position.marketTicker} side=${position.side} remaining=${a.remaining}`);
  }
}
