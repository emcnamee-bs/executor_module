import { createHash } from 'node:crypto';
import type { CreateOrderBody } from './kalshiClient.js';
import { KalshiClient, KalshiRequestError, positionForTicker } from './kalshiClient.js';
import type Database from 'better-sqlite3';
import { totalExposureCents, MAX_TOTAL_EXPOSURE_CENTS, type OrderStatus } from '../decide/ledger.js';

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
 * Ground truth for an ambiguous or crash-orphaned order attempt. Never guesses:
 * getOrders confirms whether Kalshi has any record of the client_order_id at all;
 * the position diff against the STORED positionBeforeContracts (never re-derived)
 * is the authoritative fill count regardless of what an ambiguous HTTP response did
 * or didn't say.
 */
export async function reconcileOrder(
  client: KalshiClient,
  clientOrderId: string,
  marketTicker: string,
  positionBeforeContracts: number,
  requestedContracts: number
): Promise<ReconcileResult> {
  const ordersResp = await client.getOrders({ client_order_id: clientOrderId });
  const found = ordersResp.orders.some((o) => o.client_order_id === clientOrderId);

  const positionsResp = await client.getPositions();
  const positionNow = positionForTicker(positionsResp, marketTicker);
  const filledContracts = Math.max(0, positionNow - positionBeforeContracts);

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
  filledContracts: number;
  avgFillPriceCents: number | null;
  status: OrderStatus;
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
      clientOrderId, kalshiOrderId: null, filledContracts: 0, avgFillPriceCents: null,
      status: 'declined-at-execution',
      errorDetail: `exposure cap would be breached: ${currentExposure}c + ${notionalCents}c > ${MAX_TOTAL_EXPOSURE_CENTS}c`,
    };
  }

  const body = buildOrderBody({
    itemId: input.itemId, marketTicker: input.marketTicker, side: input.side,
    contracts: input.contracts, entryPriceCents: input.entryPriceCents,
  });

  if (process.env.KALSHI_DRY_RUN === 'true') {
    const resp = await client.createOrder(body);
    return {
      clientOrderId, kalshiOrderId: resp.order.order_id, filledContracts: input.contracts,
      avgFillPriceCents: input.entryPriceCents, status: 'filled', errorDetail: null,
    };
  }

  let lastError: unknown = null;
  let kalshiOrderId: string | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await client.createOrder(body);
      kalshiOrderId = resp.order.order_id;
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof KalshiRequestError && !isRetryableStatus(err.statusCode)) {
        // A definite synchronous rejection (e.g. 400 insufficient balance) -- Kalshi
        // gave a clear answer, no ambiguity, nothing to reconcile or retry.
        return {
          clientOrderId, kalshiOrderId: null, filledContracts: 0, avgFillPriceCents: null,
          status: 'rejected', errorDetail: err.message,
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
      client, clientOrderId, input.marketTicker, input.positionBeforeContracts, input.contracts
    );
    return {
      clientOrderId, kalshiOrderId: null, filledContracts: reconciled.filledContracts,
      avgFillPriceCents: reconciled.filledContracts > 0 ? input.entryPriceCents : null,
      status: reconciled.status, errorDetail: message,
    };
  }

  const positionAfter = positionForTicker(await client.getPositions(), input.marketTicker);
  const filledContracts = Math.max(0, positionAfter - input.positionBeforeContracts);
  return {
    clientOrderId, kalshiOrderId, filledContracts,
    avgFillPriceCents: filledContracts > 0 ? input.entryPriceCents : null,
    status: filledContracts === 0 ? 'unfilled' : filledContracts >= input.contracts ? 'filled' : 'partial',
    errorDetail: null,
  };
}
