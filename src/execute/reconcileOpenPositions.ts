// src/execute/reconcileOpenPositions.ts
import type Database from 'better-sqlite3';
import type { KalshiClient } from './kalshiClient.js';
import { positionForTicker } from './kalshiClient.js';
import { fetchMarketStatus as realFetchMarketStatus } from '../decide/kalshi.js';
import {
  findOpenUnsettledDecisions,
  findPendingOrders,
  markDecisionSettled,
  blockMarket,
  type OpenUnsettledDecision,
} from '../decide/ledger.js';

export interface ReconcileOpenPositionsDeps {
  db: Database.Database;
  client: KalshiClient;
  /** Injectable for tests; defaults to the real public market-status check. */
  fetchMarketStatus?: typeof realFetchMarketStatus;
}

/**
 * Groups open rows by market_ticker. Nothing upstream dedups decisions by
 * market_ticker specifically (hasOpenPosition dedups per story_key+event_ticker
 * only, and story_key is null for most real items; the exposure-cap trigger in
 * ledger.ts explicitly anticipates multiple would-trade rows per event) -- so two
 * distinct decisions legitimately sharing one market_ticker is a real, structurally
 * expected scenario, not a hypothetical edge case.
 */
function groupByMarketTicker(rows: OpenUnsettledDecision[]): Map<string, OpenUnsettledDecision[]> {
  const groups = new Map<string, OpenUnsettledDecision[]>();
  for (const row of rows) {
    const existing = groups.get(row.marketTicker);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(row.marketTicker, [row]);
    }
  }
  return groups;
}

/**
 * The market_tickers with an order in flight RIGHT NOW (an `orders` row still
 * `pending`, i.e. placed but not yet resolved). Those tickers are deliberately not
 * reconciled this pass.
 *
 * Why: a decision row sits at would_trade=0 for the entire multi-second duration of
 * placeOrder (createOrder plus any retries), so a fill from an in-flight order can
 * already be reflected in Kalshi's REAL position while the ledger legitimately does
 * not count it as expected yet. Comparing during that window reads a healthy market
 * as diverged and blocks it permanently on a false positive -- the exact
 * fires-correctly-but-checked-nothing failure this project's own law names.
 *
 * Skipping costs nothing: the order resolves one way or the other within seconds,
 * and the ticker is reconciled normally on the next pass. This design's own stated
 * principle is that there is no cost to waiting ten more minutes.
 */
function tickersWithOrdersInFlight(db: Database.Database): Set<string> {
  return new Set(findPendingOrders(db).map((order) => order.marketTicker));
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
 *
 * Rows are then processed ONE GROUP PER market_ticker, not one row at a time: a
 * single market_ticker can legitimately have multiple open decision rows against
 * it (see groupByMarketTicker), and Kalshi's real position for that ticker is one
 * aggregate number covering all of them together. Comparing each row individually
 * against that aggregate would misfire a divergence block on every multi-row ticker
 * even when the combined state is perfectly correct -- exactly the false-positive
 * that trains a safety mechanism out of usefulness. fetchMarketStatus is likewise
 * called once per distinct ticker, not once per row.
 *
 * Any ticker with an order IN FLIGHT this pass (see tickersWithOrdersInFlight) is
 * skipped entirely -- not status-checked, not compared, never blocked -- because the
 * ledger's expected count is legitimately behind Kalshi's real position for the
 * seconds an order is live.
 */
export async function reconcileOpenPositions(deps: ReconcileOpenPositionsDeps): Promise<void> {
  const { db, client } = deps;
  const fetchMarketStatus = deps.fetchMarketStatus ?? realFetchMarketStatus;

  const openRows = findOpenUnsettledDecisions(db);
  if (openRows.length === 0) return;

  // Sampled BEFORE the positions fetch as well as after it, and unioned. The
  // before-sample is not redundant: an order that was in flight when the ledger
  // snapshot above was taken, and resolved while getPositions was in the air, is
  // reflected in the real position but missing from `openRows` -- the after-sample
  // alone would no longer see it as pending and would read that as a divergence.
  const inFlightBefore = tickersWithOrdersInFlight(db);

  let positionsResp;
  try {
    positionsResp = await client.getPositions();
  } catch (err) {
    console.error('[reconcile-open-positions] failed to fetch positions for this pass, deferring to the next tick:', err);
    return;
  }

  const inFlight = new Set([...inFlightBefore, ...tickersWithOrdersInFlight(db)]);

  const groups = groupByMarketTicker(openRows);

  for (const [marketTicker, rows] of groups) {
    if (inFlight.has(marketTicker)) {
      console.log(
        `[reconcile-open-positions] skipping marketTicker=${marketTicker} this pass: an order is still in flight (a fill can be real on Kalshi before the ledger counts it)`
      );
      continue;
    }
    try {
      const marketStatus = await fetchMarketStatus(marketTicker);
      if (marketStatus.status === 'finalized') {
        // One transaction per ticker group: a crash midway through must not leave
        // some of this ticker's rows settled and the rest not, which would make the
        // next pass compare a partial expected count against the real position and
        // block a market that is actually fine.
        db.transaction(() => {
          for (const row of rows) {
            markDecisionSettled(db, row.id);
          }
        })();
        continue;
      }

      const real = positionForTicker(positionsResp, marketTicker);
      const expected = rows.reduce((sum, row) => sum + (row.side === 'yes' ? row.contracts : -row.contracts), 0);
      if (real !== expected) {
        const reason = `reconciliation divergence: expected ${expected}, real ${real}`;
        blockMarket(db, marketTicker, reason, expected, real);
        console.error(
          `[RECONCILE-DIVERGENCE] market_ticker=${marketTicker} decisionIds=${rows.map((r) => r.id).join(',')} ${reason}`
        );
      }
    } catch (err) {
      console.error(
        `[reconcile-open-positions] failed to reconcile marketTicker=${marketTicker} (decisionIds=${rows.map((r) => r.id).join(',')}), will retry next pass:`,
        err
      );
    }
  }
}
