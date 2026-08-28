// src/execute/reconcileOpenPositions.ts
import type Database from 'better-sqlite3';
import type { KalshiClient } from './kalshiClient.js';
import { positionForTicker } from './kalshiClient.js';
import { fetchMarketStatus as realFetchMarketStatus } from '../decide/kalshi.js';
import { findOpenUnsettledDecisions, markDecisionSettled, blockMarket } from '../decide/ledger.js';

export interface ReconcileOpenPositionsDeps {
  db: Database.Database;
  client: KalshiClient;
  /** Injectable for tests; defaults to the real public market-status check. */
  fetchMarketStatus?: typeof realFetchMarketStatus;
}

/**
 * Periodic drift check between the ledger's believed open positions and Kalshi's
 * real account state (called every 10 minutes from main.ts, independent of item
 * processing -- see Task 5). A market that has genuinely finalized (result "yes" or
 * "no") is marked settled and never checked again; a market merely "closed" (Kalshi
 * can leave a market in this state indefinitely without ever finalizing it) is
 * still checked normally, since its position is still real and unpaid.
 *
 * getPositions() is called ONCE per pass, not once per row: avoids redundant API
 * calls, and keeps every row in the same pass compared against the same instant. If
 * that one call fails, the whole pass defers to the next tick rather than writing
 * any partial state -- there is no cost to waiting 10 more minutes.
 */
export async function reconcileOpenPositions(deps: ReconcileOpenPositionsDeps): Promise<void> {
  const { db, client } = deps;
  const fetchMarketStatus = deps.fetchMarketStatus ?? realFetchMarketStatus;

  const openRows = findOpenUnsettledDecisions(db);
  if (openRows.length === 0) return;

  let positionsResp;
  try {
    positionsResp = await client.getPositions();
  } catch (err) {
    console.error('[reconcile-open-positions] failed to fetch positions for this pass, deferring to the next tick:', err);
    return;
  }

  for (const row of openRows) {
    try {
      const marketStatus = await fetchMarketStatus(row.marketTicker);
      if (marketStatus.status === 'finalized') {
        markDecisionSettled(db, row.id);
        continue;
      }

      const real = positionForTicker(positionsResp, row.marketTicker);
      const expected = row.side === 'yes' ? row.contracts : -row.contracts;
      if (real !== expected) {
        const reason = `reconciliation divergence: expected ${expected}, real ${real}`;
        blockMarket(db, row.marketTicker, reason, expected, real);
        console.error(
          `[RECONCILE-DIVERGENCE] market_ticker=${row.marketTicker} decisionId=${row.id} ${reason}`
        );
      }
    } catch (err) {
      console.error(
        `[reconcile-open-positions] failed to reconcile decisionId=${row.id} marketTicker=${row.marketTicker}, will retry next pass:`,
        err
      );
    }
  }
}
