import { createHash } from 'node:crypto';
import type { CreateOrderBody } from './kalshiClient.js';
import { KalshiClient, KalshiRequestError, positionForTicker } from './kalshiClient.js';
import type Database from 'better-sqlite3';
import {
  totalExposureCents,
  MAX_TOTAL_EXPOSURE_CENTS,
  isMarketBlocked,
  findPendingOrders,
  resolveOrder,
  resolveDecision,
  type OrderStatus,
  type DecisionRecord,
} from '../decide/ledger.js';
import type { Rung } from '../decide/rung.js';

/** Deterministic, UUID-shaped client_order_id from item_id alone -- never decision content, so a crash-and-redeliver that recomputes a different decision still submits the SAME id, letting Kalshi's own dedup and this project's reconciliation both work correctly. */
export function deriveClientOrderId(itemId: string): string {
  const hash = createHash('md5').update(itemId).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface OrderRequest {
  itemId: string;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
}

/**
 * Kalshi's book is expressed on the YES leg: buy YES -> side "bid" at the YES
 * price; buy NO -> side "ask" at the YES-equivalent price (100 - NO price).
 * Always an IOC order at the sized entry price -- see Global Constraints.
 */
export function buildOrderBody(order: OrderRequest): CreateOrderBody {
  const isYes = order.side === 'yes';
  const yesPriceCents = isYes ? order.entryPriceCents : 100 - order.entryPriceCents;
  return {
    ticker: order.marketTicker,
    side: isYes ? 'bid' : 'ask',
    count: String(order.contracts),
    price: (yesPriceCents / 100).toFixed(4),
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross',
    client_order_id: deriveClientOrderId(order.itemId),
  };
}

export interface ReconcileResult {
  filledContracts: number;
  status: 'filled' | 'partial' | 'unfilled' | 'unknown';
}

/**
 * A YES fill increases Kalshi's `position`; a NO fill DECREASES it (`position` is
 * signed: positive = a YES holding, negative = a NO holding -- confirmed against
 * both real production clients this code was ported from, kalshi-spine's and
 * Fast99Follower's identical `normalize.js`: `count = Math.abs(pos);
 * side = pos > 0 ? 'yes' : 'no'`). This is the ONE place that sign convention is
 * applied -- everywhere else in this codebase works in a side-agnostic contract
 * count. Reading a NO fill with a YES-shaped `after - before` diff yields a
 * negative number that clamps to 0, silently recording a real, fully-executed
 * position as zero contracts / zero exposure.
 *
 * Also clamped ABOVE by requestedContracts by both callers: an IOC order can never
 * fill more than it asked for, so a larger diff means the account's position moved
 * for some unrelated reason between the two snapshots, and attributing that move to
 * this order would over-state its notional.
 */
export function signedFillDelta(side: 'yes' | 'no', before: number, after: number): number {
  const delta = side === 'yes' ? after - before : before - after;
  return Math.max(0, delta);
}

/**
 * Ground truth for an ambiguous or crash-orphaned order attempt. Never guesses:
 * getOrders confirms whether Kalshi has any record of the client_order_id at all;
 * the SIGNED position diff against the STORED positionBeforeContracts (never
 * re-derived) is the authoritative fill count regardless of what an ambiguous HTTP
 * response did or didn't say.
 */
export async function reconcileOrder(
  client: KalshiClient,
  clientOrderId: string,
  marketTicker: string,
  side: 'yes' | 'no',
  positionBeforeContracts: number,
  requestedContracts: number
): Promise<ReconcileResult> {
  const ordersResp = await client.getOrders({ client_order_id: clientOrderId });
  const found = ordersResp.orders.some((o) => o.client_order_id === clientOrderId);

  const positionsResp = await client.getPositions();
  const positionNow = positionForTicker(positionsResp, marketTicker);
  const filledContracts = Math.min(
    signedFillDelta(side, positionBeforeContracts, positionNow),
    requestedContracts
  );

  if (filledContracts === 0) {
    return { filledContracts: 0, status: found ? 'unfilled' : 'unknown' };
  }
  return { filledContracts, status: filledContracts >= requestedContracts ? 'filled' : 'partial' };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

export interface PlaceOrderInput {
  itemId: string;
  eventTicker: string;
  marketTicker: string;
  side: 'yes' | 'no';
  contracts: number;
  entryPriceCents: number;
  notionalCents: number;
  /** Captured by the CALLER via positionForTicker(await client.getPositions(), marketTicker)
   * immediately before recordPendingOrder -- never re-derived inside placeOrder itself. */
  positionBeforeContracts: number;
}

export interface PlaceOrderDeps {
  client: KalshiClient;
  db: Database.Database;
  sleepFn?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * NOTE for callers (Task 6's pipeline integration): `placeOrder` can still throw
 * rather than resolve to a `PlaceOrderResult` -- specifically if the "after"
 * `getPositions` call (on a definite createOrder success) or either call inside
 * `reconcileOrder` (on exhausted retries) itself fails. This is left uncaught
 * deliberately: the caller's `orders` row was already written as 'pending' by
 * `recordPendingOrder` before `placeOrder` was ever invoked, so a thrown error
 * here leaves that row untouched rather than resolving it to a guessed status --
 * `reconcilePendingOrders` (Task 5) will pick it up later. The caller MUST wrap
 * its `placeOrder` call in its own try/catch and leave the pending row in place
 * on that path; it must not assume `placeOrder` always resolves cleanly.
 */
export interface PlaceOrderResult {
  clientOrderId: string;
  kalshiOrderId: string | null;
  /**
   * Kalshi's own status word off the createOrder response (`order.status`), kept
   * purely as an audit trail so there is persisted evidence of what the exchange
   * itself said. Never used to compute filledContracts. Null wherever no real
   * response was received: ambiguous failure, rejection, and DRY_RUN (whose
   * "response" is synthesised locally, not received from Kalshi).
   */
  kalshiOrderStatus: string | null;
  filledContracts: number;
  avgFillPriceCents: number | null;
  status: OrderStatus;
  /**
   * True ONLY on the KALSHI_DRY_RUN simulated-fill path. Callers MUST NOT record a
   * would_trade=1 decision row for a dry run: the simulated fill is not a real
   * position, and a phantom row in the production ledger consumes the real exposure
   * cap and makes hasOpenPosition true for a story that never traded.
   */
  dryRun: boolean;
  errorDetail: string | null;
}

export async function placeOrder(input: PlaceOrderInput, deps: PlaceOrderDeps): Promise<PlaceOrderResult> {
  const { client, db } = deps;
  const sleepFn = deps.sleepFn ?? sleep;
  const maxAttempts = deps.maxAttempts ?? 3;
  const baseDelayMs = deps.baseDelayMs ?? 500;
  const clientOrderId = deriveClientOrderId(input.itemId);

  // notionalCents is DERIVED here, never trusted verbatim from the input -- a
  // guard that checks the caller's own claimed notional rather than the real
  // contracts x entryPriceCents would let a caller-side bug (e.g. notionalCents:
  // 0 alongside real contracts/entryPriceCents) sail straight past the exposure
  // cap and place a real order. Matches the same invariant the ledger's own
  // schema enforces (notional_cents = contracts * entry_price_cents).
  const notionalCents = input.contracts * input.entryPriceCents;

  // Third, independent exposure-cap layer -- redundant with evaluateSizing's own
  // check moments earlier, matching this project's established defense-in-depth
  // pattern (sizing.ts's contractsWithinCaps + the ledger's DB-level CHECK/trigger).
  const currentExposure = totalExposureCents(db, input.eventTicker);
  if (currentExposure + notionalCents > MAX_TOTAL_EXPOSURE_CENTS) {
    return {
      clientOrderId, kalshiOrderId: null, kalshiOrderStatus: null, filledContracts: 0,
      avgFillPriceCents: null, status: 'declined-at-execution', dryRun: false,
      errorDetail: `exposure cap would be breached: ${currentExposure}c + ${notionalCents}c > ${MAX_TOTAL_EXPOSURE_CENTS}c`,
    };
  }

  if (isMarketBlocked(db, input.marketTicker)) {
    return {
      clientOrderId, kalshiOrderId: null, kalshiOrderStatus: null, filledContracts: 0,
      avgFillPriceCents: null, status: 'declined-at-execution', dryRun: false,
      errorDetail: `market_ticker ${input.marketTicker} is blocked pending manual review (reconciliation divergence) -- see market_blocks`,
    };
  }

  const body = buildOrderBody({
    itemId: input.itemId, marketTicker: input.marketTicker, side: input.side,
    contracts: input.contracts, entryPriceCents: input.entryPriceCents,
  });

  if (process.env.KALSHI_DRY_RUN === 'true') {
    // The simulated fill below is deliberately flagged `dryRun: true`: the caller
    // must record it as a SKIP in the decisions table, never as a real position.
    const resp = await client.createOrder(body);
    return {
      clientOrderId, kalshiOrderId: resp.order.order_id, kalshiOrderStatus: null,
      filledContracts: input.contracts, avgFillPriceCents: input.entryPriceCents,
      status: 'filled', dryRun: true, errorDetail: null,
    };
  }

  let lastError: unknown = null;
  let kalshiOrderId: string | null = null;
  let kalshiOrderStatus: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await client.createOrder(body);
      kalshiOrderId = resp.order.order_id;
      kalshiOrderStatus = resp.order.status;
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof KalshiRequestError && !isRetryableStatus(err.statusCode)) {
        // A definite synchronous rejection (e.g. 400 insufficient balance) -- Kalshi
        // gave a clear answer, no ambiguity, nothing to reconcile or retry.
        return {
          clientOrderId, kalshiOrderId: null, kalshiOrderStatus: null, filledContracts: 0,
          avgFillPriceCents: null, status: 'rejected', dryRun: false, errorDetail: err.message,
        };
      }
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt) break;
      const retryAfterMs = err instanceof KalshiRequestError ? err.retryAfterMs : null;
      await sleepFn(retryAfterMs ?? backoffDelayMs(attempt, baseDelayMs));
    }
  }

  if (kalshiOrderId === null) {
    // Every attempt was ambiguous (network error / 429 / 5xx, retries exhausted) --
    // never guess; determine the real outcome from Kalshi's own records.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    const reconciled = await reconcileOrder(
      client, clientOrderId, input.marketTicker, input.side, input.positionBeforeContracts, input.contracts
    );
    return {
      clientOrderId, kalshiOrderId: null, kalshiOrderStatus: null,
      filledContracts: reconciled.filledContracts,
      avgFillPriceCents: reconciled.filledContracts > 0 ? input.entryPriceCents : null,
      status: reconciled.status, dryRun: false, errorDetail: message,
    };
  }

  const positionAfter = positionForTicker(await client.getPositions(), input.marketTicker);
  // SIGNED delta (a NO fill moves `position` down), clamped above by the requested
  // count -- an IOC order can never fill more than it asked for, so anything larger
  // is an unrelated position move that must not be attributed to this order.
  const filledContracts = Math.min(
    signedFillDelta(input.side, input.positionBeforeContracts, positionAfter),
    input.contracts
  );
  return {
    clientOrderId, kalshiOrderId, kalshiOrderStatus, filledContracts,
    avgFillPriceCents: filledContracts > 0 ? input.entryPriceCents : null,
    status: filledContracts === 0 ? 'unfilled' : filledContracts >= input.contracts ? 'filled' : 'partial',
    dryRun: false, errorDetail: null,
  };
}

/**
 * Raw column shape of a `decisions` row (snake_case, matching SCHEMA in
 * ledger.ts) as read directly via SQL -- used only inside
 * `reconcilePendingOrders` to reconstruct a full `DecisionRecord` for
 * `resolveDecision`. Every field is typed explicitly (never `any`) even
 * though nothing here re-validates the DB's own CHECK constraints.
 */
interface DecisionRow {
  id: number;
  item_id: string;
  story_key: string | null;
  event_ticker: string | null;
  market_ticker: string | null;
  side: 'yes' | 'no' | null;
  rung: Rung;
  direction: 'up' | 'down' | null;
  magnitude_pts: number | null;
  contracts: number;
  entry_price_cents: number | null;
  notional_cents: number;
  edge_cents: number | null;
  would_trade: number;
  reason: string;
  order_status: 'pending' | 'resolved';
  created_at: string;
}

/**
 * Rebuilds a full `DecisionRecord` from a stored `decisions` row plus a determined
 * fill outcome. Shared by `reconcilePendingOrders` and the orphaned-decision sweep
 * so there is exactly one definition of "what a resolved decision row looks like",
 * not two that can drift apart. A fill with no known price is treated as no
 * position at all rather than a would-trade row with a null entry price -- the
 * ledger's own notional-consistency invariant would (correctly) reject that.
 */
function resolvedDecisionRecord(
  row: DecisionRow,
  marketTicker: string | null,
  filledContracts: number,
  fillPriceCents: number | null,
  reason: string
): DecisionRecord {
  const filled = filledContracts > 0 && fillPriceCents !== null;
  return {
    itemId: row.item_id,
    storyKey: row.story_key,
    eventTicker: row.event_ticker,
    marketTicker,
    side: row.side,
    rung: row.rung,
    direction: row.direction,
    magnitudePts: row.magnitude_pts,
    contracts: filled ? filledContracts : 0,
    entryPriceCents: filled ? fillPriceCents : null,
    notionalCents: filled ? filledContracts * fillPriceCents! : 0,
    edgeCents: row.edge_cents,
    wouldTrade: filled,
    reason,
    orderStatus: 'resolved',
  };
}

function decisionRowById(db: Database.Database, decisionId: number): DecisionRow {
  return db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId) as DecisionRow;
}

/**
 * Recovers from a process crash between writing a pending decision/order pair and
 * getting a real answer from Kalshi. Reuses reconcileOrder -- the same function an
 * ambiguous mid-request failure uses -- so there is exactly one reconciliation code
 * path, not two independently-maintained ones.
 *
 * Every iteration is independently fault-isolated. Without that, ONE transient
 * Kalshi error (a single 500, a socket reset) on ANY pending row kills the whole
 * process before the Redis consumer ever starts -- and if the failure is
 * deterministic (an expired API key, say), the identical retry on every restart is
 * a permanent boot loop. A row that fails here stays 'pending' and is retried on
 * the next start, which is exactly what this function is for.
 *
 * The two resolve writes per row are wrapped in ONE transaction: `findPendingOrders`
 * scans only `orders.status = 'pending'`, so an `orders` row committed to a terminal
 * status while its `decisions` row is still pending would be invisible to this
 * recovery forever -- a real filled position permanently reported as zero exposure.
 */
export async function reconcilePendingOrders(db: Database.Database, client: KalshiClient): Promise<void> {
  for (const pending of findPendingOrders(db)) {
    try {
      const reconciled = await reconcileOrder(
        client, pending.clientOrderId, pending.marketTicker, pending.side,
        pending.positionBeforeContracts, pending.requestedContracts
      );

      // The decision row's entry_price_cents already holds the originally-sized limit
      // price (recordPendingDecision stores it as given, unvalidated, since
      // assertNotionalIsConsistent only checks would-trade rows) -- avg_fill_price_cents
      // is always this same limit price on any real fill, per this project's "never
      // filled worse than the limit" rule, matching pipeline.ts's resolution logic.
      const decisionRow = decisionRowById(db, pending.decisionId);
      const entryPriceCents = decisionRow.entry_price_cents;

      db.transaction(() => {
        resolveOrder(db, pending.id, {
          filledContracts: reconciled.filledContracts,
          avgFillPriceCents: reconciled.filledContracts > 0 ? entryPriceCents : null,
          status: reconciled.status,
          kalshiOrderId: null,
          kalshiOrderStatus: null,
          errorDetail: 'resolved by startup reconciliation after an unresolved pending order',
        });
        resolveDecision(
          db,
          pending.decisionId,
          resolvedDecisionRecord(
            decisionRow,
            pending.marketTicker,
            reconciled.filledContracts,
            entryPriceCents,
            `resolved by startup reconciliation: ${reconciled.status}`
          )
        );
      })();
    } catch (err) {
      console.error(
        `[startup-reconcile] failed to reconcile order clientOrderId=${pending.clientOrderId} ` +
          `decisionId=${pending.decisionId}; leaving it pending for the next startup pass:`,
        err
      );
    }
  }

  // Guarded for the same reason each row above is: nothing in startup recovery is
  // allowed to be the reason the process never reaches the Redis consumer.
  try {
    reconcileOrphanedPendingDecisions(db);
  } catch (err) {
    console.error('[startup-reconcile] orphaned-pending-decision sweep failed:', err);
  }
}

interface OrphanedDecisionRow {
  decisionId: number;
  orderId: number | null;
  orderStatus: OrderStatus | null;
  orderMarketTicker: string | null;
  orderFilledContracts: number | null;
  orderAvgFillPriceCents: number | null;
  orderKalshiOrderId: string | null;
}

/**
 * The `decisions`-row side of the same recovery `reconcilePendingOrders` performs
 * from the `orders`-row side. Two shapes of orphan exist, and neither is reachable
 * from a `status = 'pending'` scan of `orders`:
 *
 *  (a) A decision stuck at `order_status: 'pending'` with NO `orders` row at all --
 *      e.g. `getPositions` or `recordPendingOrder` itself threw before any order row
 *      was created. Nothing was ever submitted, so it resolves to would_trade=0.
 *  (b) A decision stuck at `order_status: 'pending'` whose `orders` row already
 *      reached a terminal status. The transactional resolve above makes this
 *      structurally unreachable for any NEW row, but rows written before that fix --
 *      or by any future path that skips the transactional helper -- can still be in
 *      this state, and it is the exact shape that reports a REAL filled position as
 *      zero exposure. It resolves from the orders row's own recorded fill.
 *
 * Runs from `reconcilePendingOrders` so main.ts's single startup call covers both.
 * Purely DB-local: no Kalshi call, so it needs no client and cannot fail on network.
 */
export function reconcileOrphanedPendingDecisions(db: Database.Database): void {
  const orphans = db
    .prepare(
      `SELECT d.id AS decisionId, o.id AS orderId, o.status AS orderStatus,
              o.market_ticker AS orderMarketTicker, o.filled_contracts AS orderFilledContracts,
              o.avg_fill_price_cents AS orderAvgFillPriceCents, o.kalshi_order_id AS orderKalshiOrderId
       FROM decisions d
       LEFT JOIN orders o ON o.decision_id = d.id
       WHERE d.order_status = 'pending'
         AND (o.id IS NULL OR o.status != 'pending')`
    )
    .all() as OrphanedDecisionRow[];

  for (const orphan of orphans) {
    try {
      const decisionRow = decisionRowById(db, orphan.decisionId);
      if (orphan.orderId === null) {
        // Case (a): no order was ever submitted for this decision.
        resolveDecision(
          db,
          orphan.decisionId,
          resolvedDecisionRecord(
            decisionRow,
            decisionRow.market_ticker,
            0,
            null,
            `order never submitted: ${decisionRow.reason}`
          )
        );
        continue;
      }
      // A DRY_RUN order's `orders` row is a SIMULATED terminal outcome (placeOrder's
      // dry-run branch writes a real-looking `status`/`filled_contracts` for audit,
      // marked only by the `DRYRUN-` kalshi_order_id prefix) -- it must never be
      // resolved as a real fill here, or this sweep would resurrect exactly the
      // phantom exposure I5's fix exists to prevent, just from legacy/orphaned data
      // instead of the live path. Route it through the same never-submitted shape
      // as case (a): no real order exists to report a fill from.
      if (orphan.orderKalshiOrderId?.startsWith('DRYRUN-')) {
        resolveDecision(
          db,
          orphan.decisionId,
          resolvedDecisionRecord(
            decisionRow,
            decisionRow.market_ticker,
            0,
            null,
            `order was a DRY_RUN simulation, not a real position: ${decisionRow.reason}`
          )
        );
        continue;
      }
      // Case (b): the orders row already holds the real, terminal outcome -- use it
      // verbatim rather than re-deriving anything.
      const filledContracts = orphan.orderFilledContracts ?? 0;
      const fillPriceCents = orphan.orderAvgFillPriceCents ?? decisionRow.entry_price_cents;
      resolveDecision(
        db,
        orphan.decisionId,
        resolvedDecisionRecord(
          decisionRow,
          orphan.orderMarketTicker ?? decisionRow.market_ticker,
          filledContracts,
          fillPriceCents,
          `resolved from an already-terminal order row (${orphan.orderStatus}): ` +
            `${filledContracts} contracts filled`
        )
      );
    } catch (err) {
      console.error(
        `[startup-reconcile] failed to resolve orphaned pending decision decisionId=${orphan.decisionId}:`,
        err
      );
    }
  }
}
