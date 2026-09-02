import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants, type KeyObject } from 'node:crypto';
import type Database from 'better-sqlite3';
import { recordKalshiError } from '../decide/ledger.js';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

/** Ceiling on any single Kalshi HTTP request. See the signal in `request()`. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Page size asked for on each positions fetch, so the common case is one page. */
const POSITIONS_PAGE_SIZE = 1000;

/** Safety bound on cursor-following, against a malformed or non-advancing cursor. */
const MAX_POSITION_PAGES = 50;

export interface KalshiClientConfig {
  apiKeyId: string;
  privateKeyPath: string;
  requestsPerSecond?: number;
}

export interface CreateOrderBody {
  ticker: string;
  side: 'bid' | 'ask';
  count: string;
  price: string;
  time_in_force: string;
  self_trade_prevention_type: string;
  client_order_id: string;
}

export interface KalshiOrder {
  order_id: string;
  status: string;
}

export interface CreateOrderResponse {
  order: KalshiOrder;
}

export interface OrderListEntry {
  client_order_id: string;
  ticker: string;
}

export interface GetOrdersResponse {
  orders: OrderListEntry[];
}

export interface MarketPosition {
  ticker: string;
  /**
   * Confirmed live on 2026-09-01 (mini-mac deployment smoke test): the real
   * Kalshi API sends ONLY `position_fp` on every real account position entry --
   * never this field. Kept as an optional fallback source for a future/other
   * account or endpoint version that might still send it.
   */
  position?: number;
  /** Fixed-point decimal string form of `position`, e.g. "142.12" or "-70.92".
   * Confirmed against kalshi-spine's and Fast99Follower's identical
   * normalize.js as the field the live API actually sends. Signed the same way
   * as `position` (positive = YES, negative = NO). */
  position_fp?: string;
}

export interface GetPositionsResponse {
  market_positions: MarketPosition[];
  /**
   * Kalshi's paging token: present while more pages remain, absent/empty on the
   * last one. `getPositions()` follows it internally and never returns it, so a
   * caller always sees one complete list.
   */
  cursor?: string;
}

export interface GetBalanceResponse {
  balance: number;
}

/** Carries enough of the HTTP failure for order.ts's retry policy to classify it. */
export class KalshiRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryAfterMs: number | null
  ) {
    super(message);
    this.name = 'KalshiRequestError';
  }
}

function retryAfterMsFromHeader(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export class KalshiClient {
  private readonly apiKeyId: string;
  private readonly privateKeyPath: string;
  private privateKey: KeyObject | null = null;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Test-only fetch injection point; production code always uses the real global fetch. */
  private _fetchFn: typeof fetch = fetch;
  private readonly db?: Database.Database;

  constructor(config: KalshiClientConfig, opts: { now?: () => number; db?: Database.Database } = {}) {
    this.apiKeyId = config.apiKeyId;
    this.privateKeyPath = config.privateKeyPath;
    this.now = opts.now ?? (() => Date.now());
    this.minIntervalMs = Math.max(1, Math.ceil(1000 / Math.max(1, config.requestsPerSecond ?? 5)));
    this.db = opts.db;
  }

  private key(): KeyObject {
    if (!this.privateKey) {
      const pem = readFileSync(this.privateKeyPath, 'utf8');
      this.privateKey = createPrivateKey(pem);
    }
    return this.privateKey;
  }

  private sign(timestampMs: string, method: string, pathname: string): string {
    const message = `${timestampMs}${method}${pathname}`;
    const signature = cryptoSign('sha256', Buffer.from(message, 'utf8'), {
      key: this.key(),
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    });
    return signature.toString('base64');
  }

  private async throttle(): Promise<void> {
    const run = async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = this.now();
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    await this.throttle();

    const url = new URL(KALSHI_API_BASE + endpoint);
    const timestamp = String(this.now());
    const signature = this.sign(timestamp, method, url.pathname);

    const headers: Record<string, string> = {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const callSite = endpoint.split('?')[0];
    let res: Response;
    try {
      res = await this._fetchFn(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // Node's fetch has NO default timeout. Without this, a dead socket or stalled
        // TLS handshake hangs forever, and main.ts's overlap guard -- cleared only in
        // a .finally() -- latches on forever with zero log output (throttle() only
        // spaces out request START times via a delay it awaits itself; it does not
        // wait for a prior response, so a hung request does not block later ones on
        // its own -- the guard-latching risk is the one this timeout closes). A
        // timeout turns that silent hang into an AbortError rejection, which every
        // caller here already handles.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.db) recordKalshiError(this.db, callSite, message);
      throw err;
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON body */
      }
    }

    if (!res.ok) {
      const message = `Kalshi ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 500)}`;
      if (this.db) recordKalshiError(this.db, callSite, message);
      throw new KalshiRequestError(message, res.status, retryAfterMsFromHeader(res));
    }
    return (json ?? {}) as T;
  }

  createOrder(body: CreateOrderBody): Promise<CreateOrderResponse> {
    if (process.env.KALSHI_DRY_RUN === 'true') {
      console.error('[KALSHI_DRY_RUN] createOrder blocked (no exchange call):', JSON.stringify(body));
      return Promise.resolve({ order: { order_id: `DRYRUN-${body.client_order_id}`, status: 'dryrun' } });
    }
    return this.request('POST', '/portfolio/events/orders', body);
  }

  getOrders(query: { client_order_id?: string } = {}): Promise<GetOrdersResponse> {
    const qs = query.client_order_id ? `?client_order_id=${encodeURIComponent(query.client_order_id)}` : '';
    return this.request('GET', `/portfolio/orders${qs}`);
  }

  /**
   * EVERY page of the account's positions, merged into one list.
   *
   * A single unfiltered `GET /portfolio/positions` returns whatever fits on one
   * page. If the account's position history is large enough for the exchange to
   * paginate, a ticker being reconciled can fall off that page and read back as
   * absent -- and `positionForTicker` reports absent as 0, which is
   * indistinguishable from "really flat". On a weekly-resolving series the history
   * only grows, so that risk grows with runtime: misreading a real open position as
   * 0 fires a spurious permanent market block, and the reverse case masks a real
   * divergence.
   *
   * Follows `cursor` to completion, mirroring `kalshi-spine`'s `getTrades`. Capped
   * at MAX_POSITION_PAGES against a malformed or non-advancing cursor; hitting that
   * cap THROWS rather than returning a truncated list, because a partial snapshot
   * silently presented as complete is the exact failure this method exists to
   * prevent (the same reason positionForTicker refuses to fabricate a zero below).
   *
   * Still one logical call per reconciliation pass from the caller's point of view
   * -- this makes that one call complete, it does not change how often callers make
   * it.
   */
  async getPositions(): Promise<GetPositionsResponse> {
    const merged: MarketPosition[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_POSITION_PAGES; page++) {
      // Built by hand, matching getOrders just above: request() takes no query
      // object today and this is not enough cases to warrant adding one.
      const qs =
        `?limit=${POSITIONS_PAGE_SIZE}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const resp = await this.request<GetPositionsResponse>('GET', `/portfolio/positions${qs}`);
      if (Array.isArray(resp.market_positions)) merged.push(...resp.market_positions);
      cursor = resp.cursor ? resp.cursor : undefined;
      if (!cursor) return { market_positions: merged };
    }

    throw new Error(
      `Kalshi positions pagination did not terminate after ${MAX_POSITION_PAGES} pages ` +
        `(${merged.length} positions read, cursor still set) -- refusing to report a ` +
        `partial positions snapshot as complete`
    );
  }

  /**
   * Diagnostic only -- NOT used by getPositions() or any production call site.
   * getPositions() merges every page and drops `cursor` entirely, so nothing in
   * the normal read path can show an operator whether the account's real
   * position count exceeds one page, or what Kalshi actually names its
   * pagination token. This exists purely so scripts/smoke.ts can display that raw
   * first page before go-live, since the merged path is unable to.
   */
  getPositionsRawPage(): Promise<GetPositionsResponse> {
    return this.request('GET', `/portfolio/positions?limit=${POSITIONS_PAGE_SIZE}`);
  }

  getBalance(): Promise<GetBalanceResponse> {
    return this.request('GET', '/portfolio/balance');
  }
}

/**
 * Kalshi's position is SIGNED: positive = a YES holding, negative = a NO holding
 * (confirmed against kalshi-spine's and Fast99Follower's identical
 * `normalize.js`: `count = Math.abs(pos); side = pos > 0 ? 'yes' : 'no'`). The sign
 * is preserved here verbatim -- `signedFillDelta` in order.ts is the single place
 * that convention is interpreted.
 *
 * No entry for the ticker legitimately means zero (this codebase's established
 * "absence means zero" convention, matching src/decide/kalshi.ts's 0.0000-price
 * handling). But an entry that EXISTS with neither a numeric `position` nor a
 * parseable `position_fp` is a malformed response, not a zero position:
 * fabricating a zero there would feed straight into fill detection and the
 * exposure ledger. Fail loudly instead.
 *
 * `position_fp` is not a guess: confirmed live on 2026-09-01 against a real
 * account (mini-mac deployment smoke test) that the real API sends ONLY this
 * field, never a bare `position` -- matching kalshi-spine's and Fast99Follower's
 * own normalize.js, which already fall back to it the same way (`fp(v) =>
 * Number(v)`, no scaling). `position` is checked first and preferred when
 * present, in case some other account or endpoint version still sends it.
 */
export function positionForTicker(resp: GetPositionsResponse, ticker: string): number {
  const entry = resp.market_positions.find((p) => p.ticker === ticker);
  if (entry === undefined) return 0;
  if (Number.isFinite(entry.position)) {
    return entry.position as number;
  }
  const fromFp = Number(entry.position_fp);
  if (entry.position_fp !== undefined && Number.isFinite(fromFp)) {
    return fromFp;
  }
  throw new Error(
    `Kalshi returned a non-numeric position for ${ticker}: ${JSON.stringify(entry)}`
  );
}
