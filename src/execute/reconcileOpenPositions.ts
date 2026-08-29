// src/execute/reconcileOpenPositions.ts
import type Database from 'better-sqlite3';
import type { KalshiClient } from './kalshiClient.js';
import { positionForTicker } from './kalshiClient.js';
import { fetchMarketStatus as realFetchMarketStatus } from '../decide/kalshi.js';
import { sendAlert } from '../alert.js';
import {
  findOpenUnsettledDecisions,
  findPendingOrders,
  markDecisionSettled,
  blockMarket,
  isMarketBlocked,
  isTradingHalted,
  checkDivergencesSignal,
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
 * An `orders` row can be left `pending` forever, not just for the seconds a real
 * placeOrder call takes: pipeline.ts deliberately leaves it pending on any
 * placeOrder failure, for startup reconciliation to resolve on the NEXT boot only.
 * If nothing ever restarts, that row -- and the skip below -- never clears. A
 * ticker stuck skipped forever is worse than the false positive this skip exists
 * to prevent: it is exactly the market most likely to have genuinely diverged,
 * left with its safety check silently switched off. Past this bound, an order is
 * "stuck", not "in flight", and is deliberately let through to the real compare
 * below -- which either finds it healthy or blocks it, surfacing the problem to a
 * human instead of hiding it. The bound is generous versus the legitimate case
 * (max 3 attempts * 10s per-request timeout plus backoff, order.ts's own
 * constants, comfortably under a minute) without being so tight it fights normal
 * retries.
 */
const STUCK_ORDER_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * The market_tickers with an order in flight RIGHT NOW (an `orders` row still
 * `pending`, i.e. placed but not yet resolved, and placed recently enough to still
 * be a legitimate in-flight attempt rather than a stuck one -- see
 * STUCK_ORDER_THRESHOLD_MS). Those tickers are deliberately not reconciled this
 * pass.
 *
 * Why: a decision row sits at would_trade=0 for the entire multi-second duration of
 * placeOrder (createOrder plus any retries), so a fill from an in-flight order can
 * already be reflected in Kalshi's REAL position while the ledger legitimately does
 * not count it as expected yet. Comparing during that window reads a healthy market
 * as diverged and blocks it permanently on a false positive -- the exact
 * fires-correctly-but-checked-nothing failure this project's own law names.
 *
 * Skipping costs nothing for a genuinely in-flight order: it resolves one way or
 * the other within seconds, and the ticker is reconciled normally on the next
 * pass. This design's own stated principle is that there is no cost to waiting ten
 * more minutes.
 */
function tickersWithOrdersInFlight(db: Database.Database): Set<string> {
  const now = Date.now();
  return new Set(
    findPendingOrders(db)
      .filter((order) => now - Date.parse(order.placedAt) < STUCK_ORDER_THRESHOLD_MS)
      .map((order) => order.marketTicker)
  );
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
      const marketStatus = await fetchMarketStatus(marketTicker, db);
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
        // The spec's divergences trigger is "a NEW market_blocks row is written".
        // blockMarket is an UPSERT that refreshes blocked_at (and clears cleared_at)
        // on every call, so without this guard a ticker that stays diverged --
        // exactly the state a genuine divergence leaves behind, since nothing here
        // resolves it -- would re-trip the signal with a freshly-bumped timestamp on
        // every 10-minute pass. Two such tickers would make the 60-minute count
        // permanently >= 2 and the breaker literally un-clearable: it would re-trip
        // within one pass of every `npm run clear-breaker`, forever. Sampled BEFORE
        // blockMarket runs -- querying after would always see the just-written block.
        const wasAlreadyBlocked = isMarketBlocked(db, marketTicker);
        blockMarket(db, marketTicker, reason, expected, real);
        // Logged BEFORE the signal check so that, when this block is the one that
        // trips the breaker, an operator reading the log sees the
        // [RECONCILE-DIVERGENCE] line explaining why immediately above the
        // [CIRCUIT-BREAKER-TRIPPED] line, rather than after it.
        console.error(
          `[RECONCILE-DIVERGENCE] market_ticker=${marketTicker} decisionIds=${rows.map((r) => r.id).join(',')} ${reason}`
        );
        if (!wasAlreadyBlocked) {
          sendAlert(
            `[RECONCILE-DIVERGENCE] market_ticker=${marketTicker} ${reason}. ` +
              // The ticker and the `--` separator are both load-bearing: the script
              // exits 1 with a usage message without a ticker argument, and npm needs
              // `--` to forward a positional argument to it at all. An operator
              // pasting this line verbatim must get a cleared block, not a usage error.
              `Run npm run clear-block -- ${marketTicker} after investigating.`
          );
          const wasHaltedBeforeCheck = isTradingHalted(db);
          checkDivergencesSignal(db);
          if (!wasHaltedBeforeCheck && isTradingHalted(db)) {
            sendAlert(
              '[CIRCUIT-BREAKER-TRIPPED] signal=divergences (multiple distinct markets ' +
                'diverged recently). Check circuit_breaker_trips.reason and run ' +
                'npm run clear-breaker after investigating.'
            );
          }
        }
      }
    } catch (err) {
      console.error(
        `[reconcile-open-positions] failed to reconcile marketTicker=${marketTicker} (decisionIds=${rows.map((r) => r.id).join(',')}), will retry next pass:`,
        err
      );
    }
  }
}

export interface ReconciliationTimerHandle {
  stop(): void;
}

/**
 * The periodic reconciliation timer and its overlap guard, extracted out of
 * main.ts so both are actually testable: while this lived inline in main(),
 * deleting the entire setInterval block left the whole suite green, and nothing
 * anywhere proved the guard SKIPS a tick rather than queueing it.
 *
 * The guard is deliberately skip-not-queue: a pass slower than the interval must
 * never stack up concurrent passes, each comparing the same rows against a
 * different positions snapshot. A skipped tick costs nothing -- the next one runs
 * the same work ten minutes later.
 */
export function startReconciliationTimer(
  deps: ReconcileOpenPositionsDeps,
  intervalMs: number
): ReconciliationTimerHandle {
  let inProgress = false;
  const timer = setInterval(() => {
    if (inProgress) return; // a slow pass skips the next tick, never overlaps
    inProgress = true;
    reconcileOpenPositions(deps)
      .catch((err) => console.error('[reconcile-open-positions] pass failed:', err))
      .finally(() => { inProgress = false; });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
