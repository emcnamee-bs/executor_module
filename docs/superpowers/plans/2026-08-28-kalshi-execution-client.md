# Kalshi Execution Client (Slice 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place a real Kalshi order for every `wouldTrade: true` sizing result the decision engine produces, and durably record what actually happened to it — entry-only, no exit/close logic.

**Architecture:** A ported, native-TypeScript Kalshi signing/HTTP client (`src/execute/kalshiClient.ts`) backs an order-placement orchestrator (`src/execute/order.ts`) that builds an IOC-limit order, retries transient failures with backoff, and determines the real fill count via a `getPositions` snapshot taken before and after the call (never by parsing an unverified fill-count field). The ledger (`src/decide/ledger.ts`) gains a crash-safe pending-row-then-resolve pattern so a process crash mid-order can never be silently lost or double-executed. `runDecisionPipeline` calls the orchestrator inline; `main.ts` reconciles any orphaned pending rows at startup.

**Tech Stack:** Node.js ≥20, TypeScript (strict, ESM, NodeNext), vitest, `better-sqlite3`, native `fetch`/`crypto`/`fs` (no new npm dependencies).

**Spec:** `docs/superpowers/specs/2026-08-28-kalshi-execution-client-design.md`

## Global Constraints

- **Entry-only scope.** No task in this plan places, code-paths toward, or tests any exit/close/cancel-a-resting-order logic. `cancelOrder` is deliberately not ported (YAGNI — zero callers).
- **Real money by default.** `KALSHI_DRY_RUN=true` is the only opt-in simulation switch; unset, every order call is real. The existing kill switch (`EXECUTOR_TRADING_HALTED`) is unchanged and already checked upstream of everything this plan touches — no task adds new kill-switch logic.
- **Credential hygiene, absolute.** `KALSHI_API_KEY_ID` / `KALSHI_PRIVATE_KEY_PATH` read from env or a git-ignored `.envrc`/`.env` only. No hardcoded key ID or path as a fallback, anywhere. `.gitignore` entries land in Task 1, before any credential-adjacent code.
- **Fill detection is a `getPositions` diff, never a parsed fill-count field.** `getFills` is not ported (YAGNI — zero callers; confirmed via real production code that it's defined but never called anywhere in this ecosystem, and no fill-object field name has ever been observed). `avg_fill_price_cents` is always recorded as the limit price (`entryPriceCents`) — an IOC limit order can never fill worse than its limit, so this is a conservative, never-understating notional estimate.
- **Position snapshots are captured once, durably, before any order call — never re-derived later.** Two different stories can legally target the same `market_ticker` within one event (dedup is scoped to `(story_key, event_ticker)`, not `market_ticker`), so a fresh "current position" read at reconcile time is only correct if the "before" value was captured and stored at the right moment.
- **Order type: IOC limit, always.** `time_in_force: 'immediate_or_cancel'`, `self_trade_prevention_type: 'taker_at_cross'`. `side` is `'bid'` for a YES order, `'ask'` for a NO order; `price` is always expressed as the YES-equivalent price (`entryPriceCents` for YES, `100 - entryPriceCents` for NO), formatted as a fixed-point dollar string.
- **`client_order_id` is a deterministic UUID-shaped hash of `item_id` alone**, never decision content — this is what makes Kalshi's own dedup and this project's reconciliation correct across a crash-and-redeliver.
- **Retry bound: 3 attempts total, exponential backoff + jitter, honors `Retry-After`** — applies only to `createOrder`, only for retryable failures (429, 5xx, or a network-level error with no HTTP status at all). A definite 4xx rejection (other than 429) is never retried and never ambiguous — Kalshi gave a clear synchronous answer.
- **A third, independent exposure-cap check immediately before the live Kalshi call** — re-queries `totalExposureCents(db, eventTicker)` and declines (no Kalshi call at all) if this order would breach $40, redundant with `evaluateSizing`'s own check moments earlier.
- **No automated test ever places a real order, or calls `createOrder` against the real Kalshi API.** The only real-API contact point is the manual `scripts/smoke.ts`, run by a human, read-only.
- **`Rung`, `RUNG_STAKES`, `DecisionRecord`, `PipelineDeps`, `Item`, `BandMarket`, `ActiveLadder`** and every other slice-1–3 type are unchanged by this plan except where a task explicitly says otherwise (`DecisionRecord` gains fields; `PipelineDeps` gains a field).

---

### Task 1: Kalshi signing + HTTP client

**Files:**
- Create: `src/execute/kalshiClient.ts`
- Test: `test/execute/kalshiClient.test.ts`
- Modify: `.gitignore` (add credential-adjacent patterns before any credential code)

**Interfaces:**
- Consumes: nothing from this codebase (only `node:crypto`, `node:fs`).
- Produces:
  ```typescript
  export interface KalshiClientConfig {
    apiKeyId: string;
    privateKeyPath: string;
    requestsPerSecond?: number; // default 5
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

  export class KalshiRequestError extends Error {
    constructor(message: string, statusCode: number, retryAfterMs: number | null);
    readonly statusCode: number;
    readonly retryAfterMs: number | null;
  }

  export class KalshiClient {
    constructor(config: KalshiClientConfig, opts?: { now?: () => number });
    createOrder(body: CreateOrderBody): Promise<CreateOrderResponse>;
    getOrders(query?: { client_order_id?: string }): Promise<GetOrdersResponse>;
    getPositions(): Promise<GetPositionsResponse>;
    getBalance(): Promise<GetBalanceResponse>;
  }

  export function positionForTicker(resp: GetPositionsResponse, ticker: string): number;
  ```
  Task 4 consumes `KalshiClient`, `KalshiRequestError`, `CreateOrderBody`, `CreateOrderResponse`, `GetOrdersResponse`, `positionForTicker`. Task 7 consumes `KalshiClient`, `KalshiClientConfig`. `scripts/smoke.ts` (Task 8) consumes `KalshiClient`, `getBalance`, `getPositions`.

This is the signing/HTTP primitive, ported from `kalshi-spine`'s `node/kalshiClient.js` (a real, currently-live, production client — read `/Users/eamonmcnamee/Downloads/kalshi-spine/node/kalshiClient.js` for the exact signature scheme this must match byte-for-byte in behavior, just re-expressed in TypeScript using native `fetch` instead of the `https` module, matching this codebase's existing `src/decide/kalshi.ts` convention). `getFills` and `cancelOrder` are deliberately not ported — see Global Constraints.

`getOrders`/`getPositions`/`getBalance`'s exact response shapes (`orders[].client_order_id`/`.ticker`; `market_positions[].ticker`/`.position`) are confirmed directly from Fast99Follower's real production code (`src/executor.js`'s idempotency guard; `src/reconcile.js`'s position reconciliation) — not guessed. Do not add fields beyond what's listed above (e.g. no `remaining_count`, no `kalshi_order_id` on `OrderListEntry`) — those are exactly the unverified fields this plan deliberately avoids depending on.

- [ ] **Step 1: Write the failing signing test**

```typescript
// test/execute/kalshiClient.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, constants as cryptoConstants } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KalshiClient } from '../../src/execute/kalshiClient.js';

function generateTestKeyPair(): { privateKeyPem: string; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'] } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { privateKeyPem, publicKey };
}

describe('KalshiClient signing', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-key-test-'));
    keyPath = path.join(dir, 'kalshi_key.pem');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('signs a request with RSA-PSS/SHA-256 over `${timestampMs}${method}${pathname}`, verifiable by the matching public key', async () => {
    const { privateKeyPem, publicKey } = generateTestKeyPair();
    writeFileSync(keyPath, privateKeyPem);

    let capturedHeaders: Record<string, string> = {};
    const fetchFn = async (_url: string, init: { headers: Record<string, string> }) => {
      capturedHeaders = init.headers;
      return new Response(JSON.stringify({ order: { order_id: 'x', status: 'resting' } }), { status: 200 });
    };

    const client = new KalshiClient(
      { apiKeyId: 'test-key-id', privateKeyPath: keyPath },
      { now: () => 1735689600000 }
    );
    // @ts-expect-error -- test-only fetch injection, see Step 3
    client._fetchFn = fetchFn;

    await client.createOrder({
      ticker: 'KXAPRPOTUS-26AUG28-40.6',
      side: 'bid',
      count: '5',
      price: '0.1200',
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      client_order_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });

    expect(capturedHeaders['KALSHI-ACCESS-KEY']).toBe('test-key-id');
    expect(capturedHeaders['KALSHI-ACCESS-TIMESTAMP']).toBe('1735689600000');

    const message = `1735689600000POST/trade-api/v2/portfolio/events/orders`;
    const signatureValid = cryptoVerify(
      'sha256',
      Buffer.from(message, 'utf8'),
      { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(capturedHeaders['KALSHI-ACCESS-SIGNATURE'], 'base64')
    );
    expect(signatureValid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/execute/kalshiClient.test.ts`
Expected: FAIL — `Cannot find module '../../src/execute/kalshiClient.js'`.

- [ ] **Step 3: Write the client**

```typescript
// src/execute/kalshiClient.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/execute/kalshiClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Write failing tests for DRY_RUN, error classification, and `positionForTicker`**

```typescript
// Add to test/execute/kalshiClient.test.ts

import { positionForTicker, KalshiRequestError } from '../../src/execute/kalshiClient.js';

describe('KalshiClient createOrder DRY_RUN', () => {
  const originalDryRun = process.env.KALSHI_DRY_RUN;
  afterEach(() => {
    if (originalDryRun === undefined) delete process.env.KALSHI_DRY_RUN;
    else process.env.KALSHI_DRY_RUN = originalDryRun;
  });

  it('never calls fetch when KALSHI_DRY_RUN=true, and returns a synthetic order', async () => {
    process.env.KALSHI_DRY_RUN = 'true';
    let fetchCalled = false;
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: '/nonexistent' });
    // @ts-expect-error -- test-only fetch injection
    client._fetchFn = async () => {
      fetchCalled = true;
      throw new Error('should never be called');
    };

    const result = await client.createOrder({
      ticker: 'T', side: 'bid', count: '1', price: '0.5000',
      time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross',
      client_order_id: 'cid-1',
    });

    expect(fetchCalled).toBe(false);
    expect(result.order.order_id).toBe('DRYRUN-cid-1');
    expect(result.order.status).toBe('dryrun');
  });
});

describe('KalshiClient error classification', () => {
  it('throws KalshiRequestError carrying statusCode and Retry-After on a non-OK response', async () => {
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: '/nonexistent' });
    // @ts-expect-error -- test-only fetch injection
    client._fetchFn = async () =>
      new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'Retry-After': '2' },
      });

    await expect(client.getPositions()).rejects.toMatchObject({
      name: 'KalshiRequestError',
      statusCode: 429,
      retryAfterMs: 2000,
    });
  });

  it('sets retryAfterMs to null when no Retry-After header is present', async () => {
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: '/nonexistent' });
    // @ts-expect-error -- test-only fetch injection
    client._fetchFn = async () => new Response('server error', { status: 500 });

    await expect(client.getPositions()).rejects.toMatchObject({ statusCode: 500, retryAfterMs: null });
  });
});

describe('positionForTicker', () => {
  it('returns the matching market position', () => {
    const resp = { market_positions: [{ ticker: 'A', position: 5 }, { ticker: 'B', position: -3 }] };
    expect(positionForTicker(resp, 'B')).toBe(-3);
  });

  it('returns 0 when the ticker has no position (absence means zero, same convention as this codebase\'s price-is-zero handling)', () => {
    const resp = { market_positions: [{ ticker: 'A', position: 5 }] };
    expect(positionForTicker(resp, 'ZZZ')).toBe(0);
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/execute/kalshiClient.test.ts`
Expected: all PASS.

- [ ] **Step 7: Add credential-hygiene `.gitignore` entries**

Read the current `.gitignore` first (it already covers `data/decisions.db*` from slice 3). Add, if not already covered by an existing broad pattern:

```
kalshi_key.pem
*.pem
```

- [ ] **Step 8: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`
Expected: everything passes.

```bash
git add src/execute/kalshiClient.ts test/execute/kalshiClient.test.ts .gitignore
git commit -m "feat: add signed Kalshi execution client (createOrder/getOrders/getPositions/getBalance)"
```

---

### Task 2: Ledger schema — pending/resolve pattern and `orders` table

**Files:**
- Modify: `src/decide/ledger.ts`
- Test: `test/decide/ledger.test.ts`

**Interfaces:**
- Consumes: nothing new — extends slice 3's existing `ledger.ts` (`DecisionRecord`, `openLedger`, `recordDecision`, `hasDecisionForItem`, `hasOpenPosition`, `totalExposureCents` all remain, unchanged in behavior for every slice-3 caller).
- Produces (new, consumed by Task 4/5/6):
  ```typescript
  export type OrderStatus =
    | 'pending' | 'filled' | 'partial' | 'unfilled'
    | 'rejected' | 'error' | 'unknown' | 'declined-at-execution';

  export interface PendingOrderInput {
    decisionId: number;
    clientOrderId: string;
    marketTicker: string;
    requestedContracts: number;
    positionBeforeContracts: number;
  }

  export interface OrderResolution {
    filledContracts: number;
    avgFillPriceCents: number | null;
    status: OrderStatus;
    kalshiOrderId: string | null;
    errorDetail: string | null;
  }

  export interface PendingOrderRow {
    id: number;
    decisionId: number;
    clientOrderId: string;
    marketTicker: string;
    requestedContracts: number;
    positionBeforeContracts: number;
  }

  export function recordPendingDecision(db: Database.Database, record: DecisionRecord): number; // returns decisionId
  export function resolveDecision(db: Database.Database, decisionId: number, record: DecisionRecord): void;
  export function recordPendingOrder(db: Database.Database, input: PendingOrderInput): number; // returns orderId
  export function resolveOrder(db: Database.Database, orderId: number, resolution: OrderResolution): void;
  export function findPendingOrders(db: Database.Database): PendingOrderRow[];
  ```

`DecisionRecord` (existing, from Task 1's slice-3 baseline) gains one field: `orderStatus: 'pending' | 'resolved'`. Every existing slice-3 caller of `recordDecision` (the skip paths in `pipeline.ts`) must be updated to pass `orderStatus: 'resolved'` — skips never go through the pending/order flow. This is a mechanical, one-line change per call site, done in Task 6 (this task only changes `ledger.ts` itself and adds a `recordDecision` wrapper — see Step 3).

- [ ] **Step 1: Write the failing schema/pending-flow tests**

```typescript
// Add to test/decide/ledger.test.ts, alongside the existing describe('ledger', ...) block

import {
  recordPendingDecision,
  resolveDecision,
  recordPendingOrder,
  resolveOrder,
  findPendingOrders,
} from '../../src/decide/ledger.js';

describe('pending decision + order flow (slice 4)', () => {
  it('recordPendingDecision writes a would_trade=0, order_status=pending row and returns its id', () => {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    expect(decisionId).toBeGreaterThan(0);

    const row = db.prepare('SELECT would_trade, order_status FROM decisions WHERE id = ?').get(decisionId) as {
      would_trade: number;
      order_status: string;
    };
    // Even though tradeRecord() defaults wouldTrade: true, a pending row is never a
    // confirmed position yet -- recordPendingDecision forces would_trade to 0
    // regardless of what the input record says, exactly like a genuine 0-fill outcome.
    expect(row.would_trade).toBe(0);
    expect(row.order_status).toBe('pending');
  });

  it('resolveDecision updates an existing pending row in place to the real outcome', () => {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    resolveDecision(db, decisionId, tradeRecord({ contracts: 3, entryPriceCents: 12, notionalCents: 36, wouldTrade: true, orderStatus: 'resolved' }));

    const row = db.prepare('SELECT would_trade, contracts, notional_cents, order_status FROM decisions WHERE id = ?').get(decisionId) as {
      would_trade: number;
      contracts: number;
      notional_cents: number;
      order_status: string;
    };
    expect(row.would_trade).toBe(1);
    expect(row.contracts).toBe(3);
    expect(row.notional_cents).toBe(36);
    expect(row.order_status).toBe('resolved');
  });

  it('recordPendingOrder writes a pending orders row referencing its decision, and findPendingOrders finds it', () => {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    const orderId = recordPendingOrder(db, {
      decisionId,
      clientOrderId: 'cid-abc',
      marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
      requestedContracts: 83,
      positionBeforeContracts: 0,
    });
    expect(orderId).toBeGreaterThan(0);

    const pending = findPendingOrders(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: orderId,
      decisionId,
      clientOrderId: 'cid-abc',
      marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
      requestedContracts: 83,
      positionBeforeContracts: 0,
    });
  });

  it('resolveOrder updates an existing pending order row in place and it no longer appears in findPendingOrders', () => {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    const orderId = recordPendingOrder(db, {
      decisionId, clientOrderId: 'cid-def', marketTicker: 'T', requestedContracts: 10, positionBeforeContracts: 0,
    });

    resolveOrder(db, orderId, {
      filledContracts: 10, avgFillPriceCents: 12, status: 'filled', kalshiOrderId: 'kalshi-1', errorDetail: null,
    });

    expect(findPendingOrders(db)).toHaveLength(0);
    const row = db.prepare('SELECT filled_contracts, avg_fill_price_cents, status, kalshi_order_id, resolved_at FROM orders WHERE id = ?').get(orderId) as {
      filled_contracts: number; avg_fill_price_cents: number; status: string; kalshi_order_id: string; resolved_at: string | null;
    };
    expect(row.filled_contracts).toBe(10);
    expect(row.avg_fill_price_cents).toBe(12);
    expect(row.status).toBe('filled');
    expect(row.kalshi_order_id).toBe('kalshi-1');
    expect(row.resolved_at).not.toBeNull();
  });

  it('client_order_id is UNIQUE across orders', () => {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    recordPendingOrder(db, { decisionId, clientOrderId: 'cid-dup', marketTicker: 'T', requestedContracts: 1, positionBeforeContracts: 0 });
    expect(() =>
      recordPendingOrder(db, { decisionId, clientOrderId: 'cid-dup', marketTicker: 'T', requestedContracts: 1, positionBeforeContracts: 0 })
    ).toThrow(/UNIQUE/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/ledger.test.ts`
Expected: FAIL — `recordPendingDecision is not a function` (and similarly for the others).

- [ ] **Step 3: Extend the schema and add the new functions**

In `src/decide/ledger.ts`:

1. Add `order_status` to `DecisionRecord` and to the `decisions` table's `CREATE TABLE IF NOT EXISTS` (via `ALTER TABLE ... ADD COLUMN`, since the table already exists from slice 3 — `better-sqlite3`'s `db.exec` on a fresh DB will run `CREATE TABLE IF NOT EXISTS` fine, but the `ALTER TABLE ADD COLUMN` needs to run unconditionally once, guarded so it doesn't error on a DB that already has the column):

```typescript
export type OrderStatus =
  | 'pending' | 'filled' | 'partial' | 'unfilled'
  | 'rejected' | 'error' | 'unknown' | 'declined-at-execution';

export interface DecisionRecord {
  itemId: string;
  storyKey: string | null;
  eventTicker: string | null;
  marketTicker: string | null;
  side: 'yes' | 'no' | null;
  rung: Rung;
  direction: 'up' | 'down' | null;
  magnitudePts: number | null;
  contracts: number;
  entryPriceCents: number | null;
  notionalCents: number;
  edgeCents: number | null;
  wouldTrade: boolean;
  reason: string;
  orderStatus: 'pending' | 'resolved';
}
```

Add `order_status TEXT NOT NULL DEFAULT 'resolved' CHECK (order_status IN ('pending','resolved'))` as a column in the `decisions` `CREATE TABLE` statement (this is safe to add directly to the `CREATE TABLE IF NOT EXISTS` — since no ledger DB predates this branch, confirmed in slice 3's final adjudication, there is no existing-table migration concern here).

2. Add the `orders` table to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  client_order_id TEXT NOT NULL UNIQUE,
  kalshi_order_id TEXT,
  market_ticker TEXT NOT NULL,
  requested_contracts INTEGER NOT NULL CHECK (requested_contracts > 0),
  position_before_contracts INTEGER NOT NULL,
  filled_contracts INTEGER NOT NULL DEFAULT 0 CHECK (filled_contracts >= 0),
  avg_fill_price_cents INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'filled', 'partial', 'unfilled', 'rejected', 'error', 'unknown',
    'declined-at-execution'
  )),
  error_detail TEXT,
  placed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
```

3. Update `recordDecision`'s `INSERT` to include `order_status` (bind `@orderStatus`), and update `assertNotionalIsConsistent`'s caller unaffected.

4. Add the new functions:

```typescript
/** Writes a not-yet-executed decision: forced would_trade=0, order_status='pending', regardless of the input record's own wouldTrade -- a pending row is never a confirmed position. Returns the new row's id. */
export function recordPendingDecision(db: Database.Database, record: DecisionRecord): number {
  const pendingRecord: DecisionRecord = { ...record, wouldTrade: false, orderStatus: 'pending' };
  assertNotionalIsConsistent(pendingRecord);
  const info = db.prepare(
    `INSERT INTO decisions
      (item_id, story_key, event_ticker, market_ticker, side, rung, direction,
       magnitude_pts, contracts, entry_price_cents, notional_cents, edge_cents,
       would_trade, reason, order_status)
     VALUES (@itemId, @storyKey, @eventTicker, @marketTicker, @side, @rung, @direction,
       @magnitudePts, @contracts, @entryPriceCents, @notionalCents, @edgeCents,
       @wouldTrade, @reason, @orderStatus)`
  ).run({ ...pendingRecord, wouldTrade: 0 });
  return Number(info.lastInsertRowid);
}

/** Updates a pending decision row in place with the real outcome. */
export function resolveDecision(db: Database.Database, decisionId: number, record: DecisionRecord): void {
  assertNotionalIsConsistent(record);
  db.prepare(
    `UPDATE decisions SET
       market_ticker = @marketTicker, side = @side, contracts = @contracts,
       entry_price_cents = @entryPriceCents, notional_cents = @notionalCents,
       edge_cents = @edgeCents, would_trade = @wouldTrade, reason = @reason,
       order_status = @orderStatus
     WHERE id = @decisionId`
  ).run({ ...record, wouldTrade: record.wouldTrade ? 1 : 0, decisionId });
}

export interface PendingOrderInput {
  decisionId: number;
  clientOrderId: string;
  marketTicker: string;
  requestedContracts: number;
  positionBeforeContracts: number;
}

export function recordPendingOrder(db: Database.Database, input: PendingOrderInput): number {
  const info = db.prepare(
    `INSERT INTO orders
      (decision_id, client_order_id, market_ticker, requested_contracts, position_before_contracts, status)
     VALUES (@decisionId, @clientOrderId, @marketTicker, @requestedContracts, @positionBeforeContracts, 'pending')`
  ).run(input);
  return Number(info.lastInsertRowid);
}

export interface OrderResolution {
  filledContracts: number;
  avgFillPriceCents: number | null;
  status: OrderStatus;
  kalshiOrderId: string | null;
  errorDetail: string | null;
}

export function resolveOrder(db: Database.Database, orderId: number, resolution: OrderResolution): void {
  db.prepare(
    `UPDATE orders SET
       filled_contracts = @filledContracts, avg_fill_price_cents = @avgFillPriceCents,
       status = @status, kalshi_order_id = @kalshiOrderId, error_detail = @errorDetail,
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @orderId`
  ).run({ ...resolution, orderId });
}

export interface PendingOrderRow {
  id: number;
  decisionId: number;
  clientOrderId: string;
  marketTicker: string;
  requestedContracts: number;
  positionBeforeContracts: number;
}

export function findPendingOrders(db: Database.Database): PendingOrderRow[] {
  const rows = db
    .prepare(
      `SELECT id, decision_id AS decisionId, client_order_id AS clientOrderId, market_ticker AS marketTicker,
              requested_contracts AS requestedContracts, position_before_contracts AS positionBeforeContracts
       FROM orders WHERE status = 'pending'`
    )
    .all();
  return rows as PendingOrderRow[];
}
```

5. Update the existing test file's `skipRecord`/`tradeRecord`/`tradeRecordOfNotional` fixtures to include `orderStatus: 'resolved'` in their defaults (they represent already-resolved decisions, matching every slice-3 call site).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/ledger.test.ts`
Expected: all PASS, including every pre-existing slice-3 ledger test (unaffected by the additive schema change).

- [ ] **Step 5: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`

Expected: the pre-existing `pipeline.test.ts` will now FAIL to typecheck/run, because `DecisionRecord` gained a required `orderStatus` field that `pipeline.ts`'s `skipRecord` helper doesn't yet set. This is expected and fixed in Task 6 — for THIS task's commit, only `ledger.ts` and `ledger.test.ts` are in scope. Run the full suite anyway and note the `pipeline.ts`/`pipeline.test.ts` type errors in your report so Task 6 isn't a surprise; do not fix them here.

```bash
git add src/decide/ledger.ts test/decide/ledger.test.ts
git commit -m "feat: add pending/resolve decision+order ledger schema for execution tracking"
```

---

### Task 3: Order body construction and `client_order_id` derivation

**Files:**
- Create: `src/execute/order.ts`
- Test: `test/execute/order.test.ts`

**Interfaces:**
- Consumes: `CreateOrderBody` (Task 1).
- Produces (consumed by Task 4):
  ```typescript
  export interface OrderRequest {
    itemId: string;
    marketTicker: string;
    side: 'yes' | 'no';
    contracts: number;
    entryPriceCents: number;
  }

  export function deriveClientOrderId(itemId: string): string;
  export function buildOrderBody(order: OrderRequest): CreateOrderBody;
  ```

This is the pure, HTTP-free half of `order.ts` — ported from Fast99Follower's `src/executor.js` (`buildOrderBody`, `toClientUuid`), adapted to this project's `side: 'yes'|'no'` convention (slice 3's `sizing.ts` already uses `'yes'|'no'`, not Kalshi's own `'bid'|'ask'`).

- [ ] **Step 1: Write the failing tests**

```typescript
// test/execute/order.ts
import { describe, it, expect } from 'vitest';
import { deriveClientOrderId, buildOrderBody } from '../../src/execute/order.js';

describe('deriveClientOrderId', () => {
  it('is deterministic: the same itemId always produces the same id', () => {
    expect(deriveClientOrderId('item-123')).toBe(deriveClientOrderId('item-123'));
  });

  it('is UUID-shaped (matches Kalshi\'s expected client_order_id format)', () => {
    expect(deriveClientOrderId('item-123')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it('differs for different itemIds', () => {
    expect(deriveClientOrderId('item-1')).not.toBe(deriveClientOrderId('item-2'));
  });
});

describe('buildOrderBody', () => {
  it('builds a YES order as a bid at entryPriceCents', () => {
    const body = buildOrderBody({
      itemId: 'item-1', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'yes', contracts: 83, entryPriceCents: 12,
    });
    expect(body).toEqual({
      ticker: 'KXAPRPOTUS-26AUG28-40.6',
      side: 'bid',
      count: '83',
      price: '0.1200',
      time_in_force: 'immediate_or_cancel',
      self_trade_prevention_type: 'taker_at_cross',
      client_order_id: deriveClientOrderId('item-1'),
    });
  });

  it('builds a NO order as an ask at the YES-equivalent price (100 - entryPriceCents)', () => {
    const body = buildOrderBody({
      itemId: 'item-2', marketTicker: 'KXAPRPOTUS-26AUG28-40.6', side: 'no', contracts: 5, entryPriceCents: 42,
    });
    expect(body.side).toBe('ask');
    expect(body.price).toBe('0.5800'); // (100 - 42) / 100
    expect(body.count).toBe('5');
  });

  it('always sets IOC time_in_force and taker_at_cross self-trade prevention', () => {
    const body = buildOrderBody({ itemId: 'i', marketTicker: 'T', side: 'yes', contracts: 1, entryPriceCents: 50 });
    expect(body.time_in_force).toBe('immediate_or_cancel');
    expect(body.self_trade_prevention_type).toBe('taker_at_cross');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/execute/order.test.ts`
Expected: FAIL — `Cannot find module '../../src/execute/order.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/execute/order.ts
import { createHash } from 'node:crypto';
import type { CreateOrderBody } from './kalshiClient.js';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/execute/order.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run full suite and typecheck, then commit**

```bash
git add src/execute/order.ts test/execute/order.test.ts
git commit -m "feat: add order-body construction and deterministic client_order_id"
```

---

### Task 4: Order placement — retry, reconciliation, position-diff fill detection

**Files:**
- Modify: `src/execute/order.ts`
- Modify: `test/execute/order.test.ts`

**Interfaces:**
- Consumes: `KalshiClient`, `KalshiRequestError`, `CreateOrderResponse`, `GetOrdersResponse`, `positionForTicker` (Task 1); `buildOrderBody`, `deriveClientOrderId`, `OrderRequest` (Task 3); `totalExposureCents`, `MAX_TOTAL_EXPOSURE_CENTS` (existing, `ledger.ts`).
- Produces (consumed by Task 5 and Task 6):
  ```typescript
  export interface PlaceOrderInput {
    itemId: string;
    eventTicker: string;
    marketTicker: string;
    side: 'yes' | 'no';
    contracts: number;
    entryPriceCents: number;
    notionalCents: number;
    /**
     * Captured by the CALLER (pipeline.ts, Task 6) via positionForTicker(await
     * kalshiClient.getPositions(), marketTicker) immediately before recordPendingOrder
     * -- NOT re-derived inside placeOrder. This is what lets the same snapshot be
     * durably stored in the orders row (for reconcilePendingOrders to use later if the
     * process crashes) and used here for the live diff, with no risk of the two ever
     * disagreeing because there is only one read, by one caller, at one moment.
     */
    positionBeforeContracts: number;
  }

  export interface PlaceOrderDeps {
    client: KalshiClient;
    db: Database.Database;
  }

  export interface PlaceOrderResult {
    clientOrderId: string;
    kalshiOrderId: string | null;
    filledContracts: number;
    avgFillPriceCents: number | null;
    status: OrderStatus; // from ledger.ts
    errorDetail: string | null;
  }

  export async function placeOrder(input: PlaceOrderInput, deps: PlaceOrderDeps): Promise<PlaceOrderResult>;

  export interface ReconcileResult {
    filledContracts: number;
    status: 'filled' | 'partial' | 'unfilled' | 'unknown';
  }

  export async function reconcileOrder(
    client: KalshiClient,
    clientOrderId: string,
    marketTicker: string,
    positionBeforeContracts: number,
    requestedContracts: number
  ): Promise<ReconcileResult>;
  ```

`placeOrder` does NOT write the pending rows itself, and does NOT capture the "before" position snapshot itself — both happen in the caller (Task 6's pipeline integration), since the caller needs the decision id from `recordPendingDecision` and needs to store the same snapshot durably in the `orders` row via `recordPendingOrder` before `placeOrder` is ever invoked. `placeOrder` only calls `getPositions` for the "after" snapshot (on a definite success) or via `reconcileOrder` (on an ambiguous failure) — never for "before". To keep this task's tests self-contained without a real `evaluateSizing`/pipeline dependency, every test constructs `PlaceOrderInput` directly with an explicit `positionBeforeContracts`, exactly as Task 6's real caller will.

- [ ] **Step 1: Write the failing tests for `reconcileOrder`**

```typescript
// Add to test/execute/order.test.ts
import { reconcileOrder, placeOrder, deriveClientOrderId, type PlaceOrderDeps } from '../../src/execute/order.js';
import { KalshiClient } from '../../src/execute/kalshiClient.js';
import { openLedger, recordPendingDecision } from '../../src/decide/ledger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

function mockClient(overrides: Partial<KalshiClient> = {}): KalshiClient {
  return { createOrder: async () => { throw new Error('not stubbed'); }, getOrders: async () => ({ orders: [] }), getPositions: async () => ({ market_positions: [] }), getBalance: async () => ({ balance: 0 }), ...overrides } as unknown as KalshiClient;
}

describe('reconcileOrder', () => {
  it('reports "filled" when the position diff meets or exceeds the requested contracts', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 83 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 0, 83);
    expect(result).toEqual({ filledContracts: 83, status: 'filled' });
  });

  it('reports "partial" when the position diff is positive but less than requested', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 40 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 0, 83);
    expect(result).toEqual({ filledContracts: 40, status: 'partial' });
  });

  it('reports "unfilled" when the order is found but the position never changed', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 10 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 10, 83);
    expect(result).toEqual({ filledContracts: 0, status: 'unfilled' });
  });

  it('reports "unknown" when getOrders has no record AND the position never changed', async () => {
    const client = mockClient({
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 5 }] }),
    });
    const result = await reconcileOrder(client, 'cid-missing', 'T', 5, 83);
    expect(result).toEqual({ filledContracts: 0, status: 'unknown' });
  });

  it('uses the STORED positionBeforeContracts, not a fresh read -- proves a different decision\'s fill on the same ticker in between does not corrupt this reconciliation', async () => {
    // Suppose this order's own before-snapshot was 20, but by the time we reconcile,
    // a completely different decision on the same market_ticker has also filled,
    // pushing the CURRENT position to 60. The diff against the ORIGINAL 20 (not a
    // fresh "before" of 0, and not confused by attributing the other decision's
    // contracts to this one) must still be computed correctly as 40.
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-1', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 60 }] }),
    });
    const result = await reconcileOrder(client, 'cid-1', 'T', 20, 40);
    expect(result).toEqual({ filledContracts: 40, status: 'filled' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/execute/order.test.ts`
Expected: FAIL — `reconcileOrder is not a function`.

- [ ] **Step 3: Implement `reconcileOrder`**

Add to `src/execute/order.ts`:

```typescript
import { KalshiClient, KalshiRequestError, positionForTicker } from './kalshiClient.js';

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/execute/order.test.ts`
Expected: `reconcileOrder` tests PASS.

- [ ] **Step 5: Write the failing tests for `placeOrder`**

```typescript
// Add to test/execute/order.test.ts

describe('placeOrder', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'placeorder-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const baseInput = (overrides: Partial<Parameters<typeof placeOrder>[0]> = {}) => ({
    itemId: 'item-1', eventTicker: 'KXAPRPOTUS-26AUG28', marketTicker: 'KXAPRPOTUS-26AUG28-40.6',
    side: 'yes' as const, contracts: 83, entryPriceCents: 12, notionalCents: 996,
    positionBeforeContracts: 0, ...overrides,
  });

  it('declines at execution (no Kalshi call at all, not even a position read) when the final exposure recheck would breach the $40 cap', async () => {
    let createOrderCalled = false;
    let getPositionsCalled = false;
    const client = mockClient({
      createOrder: async () => { createOrderCalled = true; return { order: { order_id: 'x', status: 'executed' } }; },
      getPositions: async () => { getPositionsCalled = true; return { market_positions: [] }; },
    });
    // Insert an existing would-trade row that already consumes $39.50 of the same event's cap.
    const decisionId = recordPendingDecision(db, tradeRecord({ eventTicker: 'KXAPRPOTUS-26AUG28', notionalCents: 3950, contracts: 10, entryPriceCents: 395 }));
    resolveDecision(db, decisionId, tradeRecord({ eventTicker: 'KXAPRPOTUS-26AUG28', notionalCents: 3950, contracts: 10, entryPriceCents: 395, wouldTrade: true, orderStatus: 'resolved' }));

    const result = await placeOrder(baseInput({ notionalCents: 996 }), { client, db });

    expect(createOrderCalled).toBe(false);
    expect(getPositionsCalled).toBe(false);
    expect(result.status).toBe('declined-at-execution');
    expect(result.filledContracts).toBe(0);
  });

  it('places a full fill: position (relative to the CALLER-supplied positionBeforeContracts) moves by exactly the requested contracts', async () => {
    let getPositionsCalls = 0;
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-1', status: 'executed' } }),
      getPositions: async () => {
        getPositionsCalls += 1;
        return { market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] };
      },
    });

    const result = await placeOrder(baseInput({ positionBeforeContracts: 0 }), { client, db });

    expect(getPositionsCalls).toBe(1); // only the "after" snapshot -- "before" comes from the input, not a fresh read
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
    expect(result.avgFillPriceCents).toBe(12); // the limit price -- never worse
    expect(result.kalshiOrderId).toBe('kalshi-1');
  });

  it('places a partial fill correctly, diffed against a non-zero positionBeforeContracts', async () => {
    const client = mockClient({
      createOrder: async () => ({ order: { order_id: 'kalshi-2', status: 'executed' } }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 25 }] }),
    });

    const result = await placeOrder(baseInput({ positionBeforeContracts: 10 }), { client, db }); // 25 - 10 = 15 filled
    expect(result.status).toBe('partial');
    expect(result.filledContracts).toBe(15);
  });

  it('retries on a 429 and succeeds on the second attempt', async () => {
    let attempts = 0;
    const client = mockClient({
      createOrder: async () => {
        attempts += 1;
        if (attempts === 1) throw new KalshiRequestError('rate limited', 429, 1);
        return { order: { order_id: 'kalshi-3', status: 'executed' } };
      },
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), { client, db });
    expect(attempts).toBe(2);
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
  });

  it('gives up after 3 attempts and reconciles via position diff, finding a real fill', async () => {
    let attempts = 0;
    const client = mockClient({
      createOrder: async () => { attempts += 1; throw new KalshiRequestError('server error', 500, null); },
      getOrders: async () => ({ orders: [{ client_order_id: deriveClientOrderId('item-1'), ticker: 'KXAPRPOTUS-26AUG28-40.6' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position: 83 }] }),
    });

    const result = await placeOrder(baseInput(), { client, db });
    expect(attempts).toBe(3);
    expect(result.status).toBe('filled');
    expect(result.filledContracts).toBe(83);
    expect(result.errorDetail).toMatch(/server error/);
  });

  it('gives up after 3 attempts and reconciles via position diff, finding genuinely nothing', async () => {
    const client = mockClient({
      createOrder: async () => { throw new KalshiRequestError('timeout', 503, null); },
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [] }),
    });

    const result = await placeOrder(baseInput(), { client, db });
    expect(result.status).toBe('unknown');
    expect(result.filledContracts).toBe(0);
  });

  it('does not retry a definite 4xx rejection (not 429), and records it as rejected without reconciling', async () => {
    let attempts = 0;
    let getOrdersCalled = false;
    const client = mockClient({
      createOrder: async () => { attempts += 1; throw new KalshiRequestError('insufficient balance', 400, null); },
      getOrders: async () => { getOrdersCalled = true; return { orders: [] }; },
    });

    const result = await placeOrder(baseInput(), { client, db });
    expect(attempts).toBe(1);
    expect(getOrdersCalled).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.filledContracts).toBe(0);
  });

  it('simulates a full fill under KALSHI_DRY_RUN without calling getPositions at all', async () => {
    const originalDryRun = process.env.KALSHI_DRY_RUN;
    process.env.KALSHI_DRY_RUN = 'true';
    try {
      let getPositionsCalls = 0;
      const client = mockClient({
        createOrder: async (body) => ({ order: { order_id: `DRYRUN-${body.client_order_id}`, status: 'dryrun' } }),
        getPositions: async () => { getPositionsCalls += 1; return { market_positions: [] }; },
      });

      const result = await placeOrder(baseInput(), { client, db });
      expect(result.status).toBe('filled');
      expect(result.filledContracts).toBe(83);
      expect(result.avgFillPriceCents).toBe(12);
      expect(getPositionsCalls).toBe(0);
    } finally {
      if (originalDryRun === undefined) delete process.env.KALSHI_DRY_RUN;
      else process.env.KALSHI_DRY_RUN = originalDryRun;
    }
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run test/execute/order.test.ts`
Expected: FAIL — `placeOrder is not a function`.

- [ ] **Step 7: Implement `placeOrder`**

Add to `src/execute/order.ts`:

```typescript
import type Database from 'better-sqlite3';
import { totalExposureCents, MAX_TOTAL_EXPOSURE_CENTS, type OrderStatus } from '../decide/ledger.js';

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

  // Third, independent exposure-cap layer -- redundant with evaluateSizing's own
  // check moments earlier, matching this project's established defense-in-depth
  // pattern (sizing.ts's contractsWithinCaps + the ledger's DB-level CHECK/trigger).
  const currentExposure = totalExposureCents(db, input.eventTicker);
  if (currentExposure + input.notionalCents > MAX_TOTAL_EXPOSURE_CENTS) {
    return {
      clientOrderId, kalshiOrderId: null, filledContracts: 0, avgFillPriceCents: null,
      status: 'declined-at-execution',
      errorDetail: `exposure cap would be breached: ${currentExposure}c + ${input.notionalCents}c > ${MAX_TOTAL_EXPOSURE_CENTS}c`,
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
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run test/execute/order.test.ts`
Expected: all PASS.

- [ ] **Step 9: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`
Expected: same pre-existing `pipeline.ts` typecheck failure from Task 2 (still not fixed until Task 6) — everything else passes.

```bash
git add src/execute/order.ts test/execute/order.test.ts
git commit -m "feat: add placeOrder with retry, exposure recheck, and position-diff fill detection"
```

---

### Task 5: Startup reconciliation of orphaned pending orders

**Files:**
- Modify: `src/execute/order.ts`
- Modify: `test/execute/order.test.ts`

**Interfaces:**
- Consumes: `findPendingOrders`, `resolveOrder`, `resolveDecision` (Task 2, `ledger.ts`); `reconcileOrder` (Task 4, this file).
- Produces (consumed by Task 7):
  ```typescript
  export async function reconcilePendingOrders(db: Database.Database, client: KalshiClient): Promise<void>;
  ```

This closes the crash-recovery loop: any `orders` row still `'pending'` at process startup (the process died between writing it and getting a real answer from Kalshi) is resolved using the exact same `reconcileOrder` logic Task 4 already built and tested — proving there is only one reconciliation code path, not two.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to test/execute/order.test.ts
import { reconcilePendingOrders } from '../../src/execute/order.js';
import { findPendingOrders, recordPendingOrder } from '../../src/decide/ledger.js';

describe('reconcilePendingOrders', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'reconcile-startup-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function pendingSetup(overrides: { requestedContracts?: number; positionBeforeContracts?: number } = {}) {
    const decisionId = recordPendingDecision(db, tradeRecord({ orderStatus: 'pending' }));
    const orderId = recordPendingOrder(db, {
      decisionId, clientOrderId: 'cid-startup', marketTicker: 'T',
      requestedContracts: overrides.requestedContracts ?? 83,
      positionBeforeContracts: overrides.positionBeforeContracts ?? 0,
    });
    return { decisionId, orderId };
  }

  it('resolves a crash-orphaned pending order that actually filled', async () => {
    pendingSetup();
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-startup', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 83 }] }),
    });

    await reconcilePendingOrders(db, client);

    expect(findPendingOrders(db)).toHaveLength(0);
    const decisionRow = db.prepare('SELECT would_trade, contracts, order_status FROM decisions').get() as {
      would_trade: number; contracts: number; order_status: string;
    };
    expect(decisionRow.would_trade).toBe(1);
    expect(decisionRow.contracts).toBe(83);
    expect(decisionRow.order_status).toBe('resolved');
  });

  it('resolves a crash-orphaned pending order that never filled', async () => {
    pendingSetup();
    const client = mockClient({
      getOrders: async () => ({ orders: [] }),
      getPositions: async () => ({ market_positions: [] }),
    });

    await reconcilePendingOrders(db, client);

    const decisionRow = db.prepare('SELECT would_trade, order_status FROM decisions').get() as {
      would_trade: number; order_status: string;
    };
    expect(decisionRow.would_trade).toBe(0);
    expect(decisionRow.order_status).toBe('resolved');
  });

  it('uses the STORED positionBeforeContracts from the pending row, not a fresh zero, so a different decision\'s intervening fill on the same ticker cannot corrupt this reconciliation', async () => {
    pendingSetup({ positionBeforeContracts: 20, requestedContracts: 40 });
    const client = mockClient({
      getOrders: async () => ({ orders: [{ client_order_id: 'cid-startup', ticker: 'T' }] }),
      getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 60 }] }), // 20 (this order's before) + 40 (this order's real fill)
    });

    await reconcilePendingOrders(db, client);

    const decisionRow = db.prepare('SELECT contracts FROM decisions').get() as { contracts: number };
    expect(decisionRow.contracts).toBe(40);
  });

  it('is a no-op when there are no pending orders', async () => {
    const client = mockClient();
    await expect(reconcilePendingOrders(db, client)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/execute/order.test.ts`
Expected: FAIL — `reconcilePendingOrders is not a function`.

- [ ] **Step 3: Implement `reconcilePendingOrders`**

Add to `src/execute/order.ts`:

```typescript
import { findPendingOrders, resolveOrder, resolveDecision } from '../decide/ledger.js';

/**
 * Recovers from a process crash between writing a pending decision/order pair and
 * getting a real answer from Kalshi. Reuses reconcileOrder -- the same function an
 * ambiguous mid-request failure uses -- so there is exactly one reconciliation code
 * path, not two independently-maintained ones.
 */
export async function reconcilePendingOrders(db: Database.Database, client: KalshiClient): Promise<void> {
  for (const pending of findPendingOrders(db)) {
    const reconciled = await reconcileOrder(
      client, pending.clientOrderId, pending.marketTicker,
      pending.positionBeforeContracts, pending.requestedContracts
    );

    // The decision row's entry_price_cents already holds the originally-sized limit
    // price (recordPendingDecision stores it as given, unvalidated, since
    // assertNotionalIsConsistent only checks would-trade rows) -- avg_fill_price_cents
    // is always this same limit price on any real fill, per this project's "never
    // filled worse than the limit" rule, matching pipeline.ts's resolution logic.
    const decisionRow = db.prepare('SELECT * FROM decisions WHERE id = ?').get(pending.decisionId) as Record<string, unknown>;
    const entryPriceCents = decisionRow.entry_price_cents as number;

    resolveOrder(db, pending.id, {
      filledContracts: reconciled.filledContracts,
      avgFillPriceCents: reconciled.filledContracts > 0 ? entryPriceCents : null,
      status: reconciled.status,
      kalshiOrderId: null,
      errorDetail: 'resolved by startup reconciliation after an unresolved pending order',
    });

    resolveDecision(db, pending.decisionId, {
      itemId: decisionRow.item_id as string,
      storyKey: decisionRow.story_key as string | null,
      eventTicker: decisionRow.event_ticker as string | null,
      marketTicker: pending.marketTicker,
      side: decisionRow.side as 'yes' | 'no' | null,
      rung: decisionRow.rung as DecisionRecord['rung'],
      direction: decisionRow.direction as 'up' | 'down' | null,
      magnitudePts: decisionRow.magnitude_pts as number | null,
      contracts: reconciled.filledContracts,
      entryPriceCents: reconciled.filledContracts > 0 ? entryPriceCents : null,
      notionalCents: reconciled.filledContracts > 0 ? reconciled.filledContracts * entryPriceCents : 0,
      edgeCents: decisionRow.edge_cents as number | null,
      wouldTrade: reconciled.filledContracts > 0,
      reason: `resolved by startup reconciliation: ${reconciled.status}`,
      orderStatus: 'resolved',
    });
  }
}
```

Note: this re-reads the pending decision row directly (raw SQL) rather than adding another `ledger.ts` helper, since it needs every column to reconstruct a full `DecisionRecord` for `resolveDecision` — if this feels awkward once written, consider instead adding a `findDecisionById(db, id): DecisionRecord & { id: number }` helper to `ledger.ts` in this same task and using that instead; either is acceptable, but do not leave the raw-SQL version untyped (cast every field explicitly, as shown, not `as any`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/execute/order.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run full suite and typecheck, then commit**

```bash
git add src/execute/order.ts test/execute/order.test.ts
git commit -m "feat: add startup reconciliation for crash-orphaned pending orders"
```

---

### Task 6: Pipeline integration

**Files:**
- Modify: `src/decide/pipeline.ts`
- Modify: `test/decide/pipeline.test.ts`

**Interfaces:**
- Consumes: `placeOrder`, `PlaceOrderResult` (Task 4); `recordPendingDecision`, `recordPendingOrder`, `resolveDecision`, `resolveOrder` (Task 2); everything already consumed by slice 3's `pipeline.ts` (`computeRung`, `fetchActiveLadder`, `evaluateSizing`, `synopsize`, `verifySynopsis`, `decideTrade`, `hasDecisionForItem`, `hasOpenPosition`, `totalExposureCents`).
- Produces: `PipelineDeps` gains one field:
  ```typescript
  export interface PipelineDeps {
    anthropicClient: Anthropic;
    db: Database.Database;
    fetchLadder: typeof fetchActiveLadder;
    kalshiClient: KalshiClient; // NEW
  }
  ```
  `runDecisionPipeline`'s signature is unchanged (`(item: Item, deps: PipelineDeps): Promise<void>`) — Task 7 consumes this.

Read the current `src/decide/pipeline.ts` in full before editing (reproduced in this plan's Global Constraints context, but re-read the actual file — this is the same "read first, don't assume" discipline slice 3 established). Every `skipRecord(...)` call site needs one addition: `orderStatus: 'resolved'` in its overrides (skips are never pending — they're resolved the instant they're recorded). The ONE branch that changes structurally is the final `wouldTrade: true` path.

- [ ] **Step 1: Write the failing tests**

```typescript
// Add to test/decide/pipeline.test.ts, alongside the existing tests.
// This file already mocks synopsize/verifySynopsis/decideTrade via vi.spyOn and uses
// a real temp SQLite ledger (openLedger) plus a stubLadder() fixture -- follow that
// same pattern, adding a mocked placeOrder via vi.spyOn on '../../src/execute/order.js'.

import * as orderModule from '../../src/execute/order.js';

// The pipeline reads a position snapshot directly (via kalshiClient.getPositions())
// before placeOrder is ever called -- every test in this block needs that stubbed,
// independent of whatever placeOrder itself is mocked to return.
function stubKalshiClient(position = 0) {
  return { getPositions: async () => ({ market_positions: [{ ticker: 'KXAPRPOTUS-26AUG28-40.6', position }] }) } as any;
}

it('places a real order for a would-trade decision and resolves both the decision and order rows with the ACTUAL fill, not the sized amount', async () => {
  vi.spyOn(orderModule, 'placeOrder').mockResolvedValue({
    clientOrderId: 'cid-x', kalshiOrderId: 'kalshi-x', filledContracts: 40, // a partial fill: sizing wanted more
    avgFillPriceCents: 12, status: 'partial', errorDetail: null,
  });

  const deps = { anthropicClient, db, fetchLadder: async () => stubLadder(), kalshiClient: stubKalshiClient() };
  await runDecisionPipeline(matchedItem, deps);

  const decisionRow = db.prepare('SELECT would_trade, contracts, entry_price_cents, notional_cents, order_status FROM decisions').get() as {
    would_trade: number; contracts: number; entry_price_cents: number; notional_cents: number; order_status: string;
  };
  // The row reflects the ACTUAL fill (40), not whatever evaluateSizing originally sized.
  expect(decisionRow.would_trade).toBe(1);
  expect(decisionRow.contracts).toBe(40);
  expect(decisionRow.entry_price_cents).toBe(12);
  expect(decisionRow.notional_cents).toBe(480);
  expect(decisionRow.order_status).toBe('resolved');

  const orderRow = db.prepare('SELECT status, filled_contracts, kalshi_order_id FROM orders').get() as {
    status: string; filled_contracts: number; kalshi_order_id: string;
  };
  expect(orderRow.status).toBe('partial');
  expect(orderRow.filled_contracts).toBe(40);
  expect(orderRow.kalshi_order_id).toBe('kalshi-x');
});

it('records would_trade=0 when placeOrder reports a zero fill, even though evaluateSizing decided to trade', async () => {
  vi.spyOn(orderModule, 'placeOrder').mockResolvedValue({
    clientOrderId: 'cid-y', kalshiOrderId: null, filledContracts: 0, avgFillPriceCents: null, status: 'unfilled', errorDetail: null,
  });

  const deps = { anthropicClient, db, fetchLadder: async () => stubLadder(), kalshiClient: stubKalshiClient() };
  await runDecisionPipeline(matchedItem, deps);

  const decisionRow = db.prepare('SELECT would_trade, contracts FROM decisions').get() as { would_trade: number; contracts: number };
  expect(decisionRow.would_trade).toBe(0);
  expect(decisionRow.contracts).toBe(0);
});

it('is crash-safe: a pending decision + order row is written and durably captures position_before_contracts BEFORE placeOrder is ever called', async () => {
  let placeOrderCallCount = 0;
  vi.spyOn(orderModule, 'placeOrder').mockImplementation(async () => {
    placeOrderCallCount += 1;
    // Simulate the pending rows already existing at the moment placeOrder is invoked.
    const pending = db.prepare('SELECT * FROM orders WHERE status = ?').all('pending');
    expect(pending).toHaveLength(1);
    throw new Error('simulated crash mid-placeOrder');
  });

  const deps = { anthropicClient, db, fetchLadder: async () => stubLadder(), kalshiClient: stubKalshiClient() };
  await runDecisionPipeline(matchedItem, deps); // the pipeline's own try/catch (I3) turns this into a durable skip row

  expect(placeOrderCallCount).toBe(1);
  const decisionRow = db.prepare('SELECT would_trade, reason FROM decisions').get() as { would_trade: number; reason: string };
  expect(decisionRow.would_trade).toBe(0);
  expect(decisionRow.reason).toMatch(/simulated crash mid-placeOrder/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/decide/pipeline.test.ts`
Expected: FAIL — either a typecheck error (missing `kalshiClient` on `PipelineDeps`, `orderStatus` missing on `DecisionRecord`) or a runtime failure since `pipeline.ts` doesn't call `placeOrder` yet.

- [ ] **Step 3: Update `pipeline.ts`**

Add `orderStatus: 'resolved'` to every existing `skipRecord(...)` overrides object (five call sites: kill switch, rumor, verify-rejected, ladder-null, dedup, should-trade-false — read the current file for the exact list, do not guess the count). Add `kalshiClient` to `PipelineDeps` and destructure it alongside the existing deps. Replace the final `wouldTrade: true` block:

```typescript
import { placeOrder, deriveClientOrderId } from '../execute/order.js';
import { positionForTicker } from '../execute/kalshiClient.js';
import {
  recordDecision, recordPendingDecision, resolveDecision,
  recordPendingOrder, resolveOrder,
  hasDecisionForItem, hasOpenPosition, totalExposureCents,
  type DecisionRecord,
} from './ledger.js';

// ... inside runDecisionPipeline, replacing the final `recordDecision(db, {...})` block:

    const sizing = evaluateSizing({
      bands: ladder.bands,
      rung,
      direction: decision.direction,
      magnitudePts: decision.magnitudePts,
      currentTotalExposureCents: totalExposureCents(db, ladder.eventTicker),
    });

    if (!sizing.wouldTrade) {
      recordDecision(db, {
        itemId: item.item_id, storyKey: item.story_key, eventTicker: ladder.eventTicker,
        marketTicker: sizing.marketTicker, side: sizing.side, rung,
        direction: decision.direction, magnitudePts: decision.magnitudePts,
        contracts: sizing.contracts, entryPriceCents: sizing.entryPriceCents,
        notionalCents: sizing.notionalCents, edgeCents: sizing.edgeCents,
        wouldTrade: sizing.wouldTrade, reason: sizing.reason, orderStatus: 'resolved',
      });
      return;
    }

    // Pending rows written BEFORE placeOrder is ever called -- this is what makes I4's
    // hasDecisionForItem dedup cover the entire execution step, and what durably
    // captures position_before_contracts even if the process crashes moments later.
    const pendingRecord: DecisionRecord = {
      itemId: item.item_id, storyKey: item.story_key, eventTicker: ladder.eventTicker,
      marketTicker: sizing.marketTicker, side: sizing.side, rung,
      direction: decision.direction, magnitudePts: decision.magnitudePts,
      contracts: sizing.contracts, entryPriceCents: sizing.entryPriceCents,
      notionalCents: sizing.notionalCents, edgeCents: sizing.edgeCents,
      wouldTrade: true, reason: sizing.reason, orderStatus: 'pending',
    };
    const decisionId = recordPendingDecision(db, pendingRecord);

    const clientOrderId = deriveClientOrderId(item.item_id);
    // Captured ONCE, here, before any order call -- stored durably in the orders row
    // (for reconcilePendingOrders to use if this process crashes moments later) and
    // passed into placeOrder directly, so there is exactly one read at exactly one
    // moment, never re-derived (see Global Constraints).
    const positionBeforeContracts = positionForTicker(await kalshiClient.getPositions(), sizing.marketTicker);
    const orderId = recordPendingOrder(db, {
      decisionId, clientOrderId, marketTicker: sizing.marketTicker,
      requestedContracts: sizing.contracts, positionBeforeContracts,
    });

    const placed = await placeOrder(
      {
        itemId: item.item_id, eventTicker: ladder.eventTicker, marketTicker: sizing.marketTicker,
        side: sizing.side, contracts: sizing.contracts, entryPriceCents: sizing.entryPriceCents!,
        notionalCents: sizing.notionalCents, positionBeforeContracts,
      },
      { client: kalshiClient, db }
    );

    resolveOrder(db, orderId, {
      filledContracts: placed.filledContracts, avgFillPriceCents: placed.avgFillPriceCents,
      status: placed.status, kalshiOrderId: placed.kalshiOrderId, errorDetail: placed.errorDetail,
    });

    const actualNotionalCents = placed.filledContracts > 0 ? placed.filledContracts * (placed.avgFillPriceCents ?? 0) : 0;
    resolveDecision(db, decisionId, {
      ...pendingRecord,
      contracts: placed.filledContracts,
      entryPriceCents: placed.filledContracts > 0 ? placed.avgFillPriceCents : null,
      notionalCents: actualNotionalCents,
      wouldTrade: placed.filledContracts > 0,
      reason: placed.errorDetail ?? `order ${placed.status}: ${placed.filledContracts}/${sizing.contracts} contracts filled`,
      orderStatus: 'resolved',
    });
```

Note the single position snapshot above: `positionBeforeContracts` is read exactly once, by `pipeline.ts`, before `recordPendingOrder` — and the SAME value flows into both the durable `orders` row and `placeOrder`'s input (Task 4's `PlaceOrderInput.positionBeforeContracts`). `placeOrder` itself never calls `getPositions` for a "before" reading; it only reads "after" on success, or defers to `reconcileOrder` (which takes the stored value as a parameter) on an ambiguous failure. This is exactly Task 4's finalized interface — no further change to `order.ts` is needed in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/decide/pipeline.test.ts test/execute/order.test.ts`
Expected: all PASS.

- [ ] **Step 5: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`
Expected: everything passes now (this is the task that resolves the `pipeline.ts` typecheck gap flagged since Task 2).

```bash
git add src/decide/pipeline.ts test/decide/pipeline.test.ts src/execute/order.ts test/execute/order.test.ts
git commit -m "feat: wire order placement into the decision pipeline"
```

---

### Task 7: `main.ts` wiring — real client construction and startup reconciliation

**Files:**
- Modify: `src/main.ts`
- Modify: `test/main.test.ts`

**Interfaces:**
- Consumes: `KalshiClient`, `KalshiClientConfig` (Task 1); `reconcilePendingOrders` (Task 5); `PipelineDeps` (Task 6, now requiring `kalshiClient`).
- Produces: `OnItemDeps` gains `kalshiClient: KalshiClient`, matching `PipelineDeps`'s new field.

Read the current `src/main.ts` in full first (per this project's established discipline — it's been modified by every prior slice's final review).

- [ ] **Step 1: Write the failing test**

```typescript
// Add to test/main.test.ts, in the 'makeOnItem wiring' describe block

it('startup reconciles an orphaned pending order before consuming any stream entries', async () => {
  // Hand-insert a pending decision+order pair, simulating a prior crash.
  const decisionId = recordPendingDecision(db, {
    itemId: 'orphan-1', storyKey: null, eventTicker: 'KXAPRPOTUS-26AUG28', marketTicker: 'T',
    side: 'yes', rung: 'reported', direction: 'up', magnitudePts: 0.3, contracts: 5,
    entryPriceCents: 12, notionalCents: 60, edgeCents: 3, wouldTrade: true, reason: 'pre-crash', orderStatus: 'pending',
  });
  recordPendingOrder(db, { decisionId, clientOrderId: 'orphan-cid', marketTicker: 'T', requestedContracts: 5, positionBeforeContracts: 0 });

  const kalshiClient = {
    getOrders: async () => ({ orders: [{ client_order_id: 'orphan-cid', ticker: 'T' }] }),
    getPositions: async () => ({ market_positions: [{ ticker: 'T', position: 5 }] }),
  } as any;

  await reconcilePendingOrders(db, kalshiClient);

  const resolved = db.prepare('SELECT would_trade, contracts FROM decisions WHERE item_id = ?').get('orphan-1') as {
    would_trade: number; contracts: number;
  };
  expect(resolved.would_trade).toBe(1);
  expect(resolved.contracts).toBe(5);
});
```

This test exercises `reconcilePendingOrders` directly (already fully tested in Task 5) — its purpose here is only to confirm `main.test.ts`'s imports/fixtures line up with the real call, since Step 3 wires the actual call into `main()` itself, which isn't independently re-tested (no test drives `main()` end-to-end; that would require a real Redis + Kalshi credentials).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL — missing imports.

- [ ] **Step 3: Wire `main.ts`**

```typescript
// Additions to src/main.ts (exact placement depends on the current file's structure --
// read it first per Step 1; this is the logic to add, not a full-file replacement)

import { KalshiClient } from './execute/kalshiClient.js';
import { reconcilePendingOrders } from './execute/order.js';

// Inside main(), after `const db = openLedger(DEFAULT_LEDGER_PATH);` and before constructing the AbortController:
const kalshiClient = new KalshiClient({
  apiKeyId: mustGetEnv('KALSHI_API_KEY_ID'),
  privateKeyPath: mustGetEnv('KALSHI_PRIVATE_KEY_PATH'),
});

console.log('[startup] reconciling any orphaned pending orders...');
await reconcilePendingOrders(db, kalshiClient);
console.log('[startup] reconciliation complete');

// OnItemDeps and the makeOnItem call site both gain `kalshiClient`:
export interface OnItemDeps {
  anthropicClient: Anthropic;
  db: Database.Database;
  fetchLadder: typeof fetchActiveLadder;
  kalshiClient: KalshiClient;
}

// ... makeOnItem({ anthropicClient, db, fetchLadder: fetchActiveLadder, kalshiClient })
```

Add a small `mustGetEnv` helper near the top of the file if one doesn't already exist:

```typescript
function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .envrc)`);
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/main.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite and typecheck, then commit**

Run: `direnv exec . npm run typecheck && direnv exec . npm test`

```bash
git add src/main.ts test/main.test.ts
git commit -m "feat: wire the real Kalshi client and startup reconciliation into main.ts"
```

---

### Task 8: Manual smoke-test script

**Files:**
- Create: `scripts/smoke.ts`

**Interfaces:**
- Consumes: `KalshiClient`, `KalshiClientConfig` (Task 1).
- Produces: nothing consumed by other code — this is a standalone, manually-invoked script, never imported or run by the automated suite.

- [ ] **Step 1: Write the script**

```typescript
// scripts/smoke.ts
//
// Manual, read-only sanity check against the REAL Kalshi API. Run this once before
// ever unsetting KALSHI_DRY_RUN, to confirm credentials and signing work end to end
// without placing any order. Not part of `npm test` -- invoke directly:
//   direnv exec . npx tsx scripts/smoke.ts

import { KalshiClient } from '../src/execute/kalshiClient.js';

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .envrc)`);
  return value;
}

async function main(): Promise<void> {
  const client = new KalshiClient({
    apiKeyId: mustGetEnv('KALSHI_API_KEY_ID'),
    privateKeyPath: mustGetEnv('KALSHI_PRIVATE_KEY_PATH'),
  });

  console.log('[smoke] fetching balance...');
  const balance = await client.getBalance();
  console.log(`[smoke] balance: ${JSON.stringify(balance)}`);

  console.log('[smoke] fetching positions...');
  const positions = await client.getPositions();
  console.log(`[smoke] positions: ${JSON.stringify(positions)}`);

  console.log('[smoke] OK -- credentials and signing verified. No order was placed.');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add an npm script**

In `package.json`'s `scripts`, add: `"smoke": "tsx scripts/smoke.ts"`.

- [ ] **Step 3: Run typecheck (not the script itself — it needs real credentials)**

Run: `direnv exec . npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.ts package.json
git commit -m "feat: add manual read-only Kalshi smoke-test script"
```

---

## Self-Review Notes

- **Spec coverage:** every Decision point (1–13) in the spec maps to a task: 1→Task 1, 2/6/11/12→Task 6, 3→Tasks 1/4, 4→Task 3, 5→Task 2, 7/8→Task 4, 9→Task 4 (Global Constraints), 10→Task 4, 13→Task 5. The credential-hygiene and manual-smoke-test sections map to Tasks 1 and 8.
- **Placeholder scan:** none found — every step has runnable code or an exact command.
- **Type consistency, and three real defects this pass caught and fixed (not just flagged):**
  1. Task 4's first draft had `placeOrder` taking its own internal `getPositions` snapshot for "before," while Task 6 needed the caller to capture and durably store that same snapshot ahead of time. Fixed by moving `positionBeforeContracts` into `PlaceOrderInput` as a required, caller-supplied field — `placeOrder` now only ever reads "after," matching Task 6's actual pipeline code exactly. Task 4's own tests (`baseInput`, the "full fill"/"partial fill" cases) were rewritten to single-call `getPositions` mocks accordingly.
  2. Task 6's pipeline tests originally passed `kalshiClient: {} as any` — but the fixed pipeline code now calls `kalshiClient.getPositions()` directly (for the snapshot) before ever calling the mocked `placeOrder`. Added a `stubKalshiClient()` helper so all three tests provide a real `getPositions` stub.
  3. Task 5's `reconcilePendingOrders` originally hardcoded `avgFillPriceCents: null` unconditionally, even on a confirmed real fill — inconsistent with every other resolution path in this plan, where `avgFillPriceCents` always equals the stored limit price (`entry_price_cents`) whenever `filledContracts > 0`. Fixed to read `decisionRow.entry_price_cents` once and use it for both the `resolveOrder` and `resolveDecision` calls.
  - `DecisionRecord.orderStatus`, `PendingOrderInput`, `OrderResolution`, `PendingOrderRow` (Task 2) are used identically in Tasks 4–7. `OrderStatus`'s union (`'pending' | 'filled' | 'partial' | 'unfilled' | 'rejected' | 'error' | 'unknown' | 'declined-at-execution'`) is the same set used in the `orders` table CHECK constraint (Task 2), `PlaceOrderResult.status` (Task 4), and `reconcileOrder`'s narrower `ReconcileResult.status` (a subset, correctly, since `reconcileOrder` never returns `'pending'`, `'rejected'`, `'error'`, or `'declined-at-execution'` — those are only ever produced by `placeOrder`'s non-reconciliation branches).
