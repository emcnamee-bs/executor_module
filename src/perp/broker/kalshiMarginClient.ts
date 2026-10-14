// src/perp/broker/kalshiMarginClient.ts
import { readFileSync } from 'node:fs';
import { constants, createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';

export type MarginEnv = 'prod' | 'demo';
export const MARGIN_HOSTS: Record<MarginEnv, string> = {
  prod: 'https://external-api.kalshi.com',
  demo: 'https://external-api.demo.kalshi.co',
};
const API_PREFIX = '/trade-api/v2';
const REQUEST_TIMEOUT_MS = 10_000;

export class MarginApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs: number | null
  ) {
    super(message);
    this.name = 'MarginApiError';
  }
}

export interface MarginClientConfig {
  env: MarginEnv;
  apiKeyId: string;
  privateKeyPath: string;
  requestsPerSecond?: number;
}

export type Query = Record<string, string | number | undefined>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class KalshiMarginClient {
  private key: KeyObject | null = null;
  private lastAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly cfg: MarginClientConfig, opts: { now?: () => number; fetchFn?: typeof fetch } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.fetchFn = opts.fetchFn ?? fetch;
    this.minIntervalMs = Math.max(1, Math.ceil(1000 / Math.max(1, cfg.requestsPerSecond ?? 5)));
  }

  private privateKey(): KeyObject {
    if (this.key === null) this.key = createPrivateKey(readFileSync(this.cfg.privateKeyPath, 'utf8'));
    return this.key;
  }

  private throttle(): Promise<void> {
    const run = async () => {
      const wait = this.lastAt + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  private async request<T>(method: Method, path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    await this.throttle();
    const url = new URL(MARGIN_HOSTS[this.cfg.env] + API_PREFIX + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const ts = String(this.now());
    const signature = cryptoSign('sha256', Buffer.from(`${ts}${method}${url.pathname}`, 'utf8'), {
      key: this.privateKey(),
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');

    const headers: Record<string, string> = {
      'KALSHI-ACCESS-KEY': this.cfg.apiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'KALSHI-ACCESS-SIGNATURE': signature,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetchFn(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new MarginApiError(
        `Kalshi margin ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        text.slice(0, 2000),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
      );
    }
    return (text.length > 0 ? JSON.parse(text) : null) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }
  put<T>(path: string, body: unknown, query?: Query): Promise<T> {
    return this.request<T>('PUT', path, { body, query });
  }
  del<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('DELETE', path, { query });
  }
}
