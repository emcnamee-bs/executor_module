import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants, type KeyObject } from 'node:crypto';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

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
  position: number;
}

export interface GetPositionsResponse {
  market_positions: MarketPosition[];
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

  constructor(config: KalshiClientConfig, opts: { now?: () => number } = {}) {
    this.apiKeyId = config.apiKeyId;
    this.privateKeyPath = config.privateKeyPath;
    this.now = opts.now ?? (() => Date.now());
    this.minIntervalMs = Math.max(1, Math.ceil(1000 / Math.max(1, config.requestsPerSecond ?? 5)));
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

    const res = await this._fetchFn(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

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
      throw new KalshiRequestError(
        `Kalshi ${method} ${endpoint} -> ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        retryAfterMsFromHeader(res)
      );
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

  getPositions(): Promise<GetPositionsResponse> {
    return this.request('GET', '/portfolio/positions');
  }

  getBalance(): Promise<GetBalanceResponse> {
    return this.request('GET', '/portfolio/balance');
  }
}

export function positionForTicker(resp: GetPositionsResponse, ticker: string): number {
  return resp.market_positions.find((p) => p.ticker === ticker)?.position ?? 0;
}
