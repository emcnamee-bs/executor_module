// src/paper/exitTimer.ts
//
// Finishes sales the news path could not complete (spec section 3): every EXIT_RETRY_MS, each position
// with a sell trigger that still holds contracts is retried at the touch until it is sold or the market
// closes (held to settlement). It never needs a news item, so "sell as early as we can" holds even
// when the feed goes quiet.
import type Database from 'better-sqlite3';
import { fetchLadderForEvent, type ActiveLadder } from '../decide/kalshi.js';
import { pendingExits } from './exits.js';
import { attemptExitFill, logExitFill, type ExitFillInfo } from './exitFill.js';

export interface ExitTimerDeps {
  db: Database.Database;
  fetchLadderForEvent: typeof fetchLadderForEvent;
  onFill?: (info: ExitFillInfo) => void;
}

/** One pass. Returns the number of fills. A failed ladder fetch skips that event until the next pass. */
export async function runPendingExits(deps: ExitTimerDeps): Promise<number> {
  const pending = pendingExits(deps.db);
  if (pending.length === 0) return 0;
  const ladders = new Map<string, ActiveLadder | 'failed'>();
  let fills = 0;
  for (const { position, reviewId } of pending) {
    if (!ladders.has(position.eventTicker)) {
      try {
        // No db argument: exit-path Kalshi failures must never feed the circuit breaker.
        ladders.set(position.eventTicker, await deps.fetchLadderForEvent(position.eventTicker));
      } catch (err) {
        console.warn(`[exit-timer] ladder fetch for ${position.eventTicker} failed: ${err instanceof Error ? err.message : String(err)}`);
        ladders.set(position.eventTicker, 'failed');
      }
    }
    const ladder = ladders.get(position.eventTicker)!;
    if (ladder === 'failed') continue;
    const market = ladder.bands.find((b) => b.ticker === position.marketTicker) ?? null;
    const attempt = attemptExitFill(deps.db, { position, reviewId, market });
    logExitFill(position, attempt);
    if (attempt.contracts > 0 && attempt.exitId !== null && attempt.priceCents !== null && attempt.filledAt !== null) {
      fills += 1;
      deps.onFill?.({
        positionId: position.id, reviewId, exitId: attempt.exitId, contracts: attempt.contracts,
        priceCents: attempt.priceCents, remaining: attempt.remaining, filledAt: attempt.filledAt,
      });
    }
  }
  return fills;
}

export function startExitTimer(deps: ExitTimerDeps, intervalMs: number): { stop: () => void } {
  let inProgress = false;
  const timer = setInterval(() => {
    if (inProgress) return; // a slow pass skips the next tick, never overlaps
    inProgress = true;
    runPendingExits(deps)
      .catch((err) => console.error('[exit-timer] pass failed:', err))
      .finally(() => { inProgress = false; });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
