import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, constants as cryptoConstants } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KalshiClient, positionForTicker, KalshiRequestError } from '../../src/execute/kalshiClient.js';
import { openLedger, isTradingHalted, CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD } from '../../src/decide/ledger.js';

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

describe('KalshiClient createOrder DRY_RUN', () => {
  let dir: string;
  let keyPath: string;
  const originalDryRun = process.env.KALSHI_DRY_RUN;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-dryrun-test-'));
    keyPath = path.join(dir, 'kalshi_key.pem');
    const { privateKeyPem } = generateTestKeyPair();
    writeFileSync(keyPath, privateKeyPem);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalDryRun === undefined) delete process.env.KALSHI_DRY_RUN;
    else process.env.KALSHI_DRY_RUN = originalDryRun;
  });

  it('never calls fetch when KALSHI_DRY_RUN=true, and returns a synthetic order', async () => {
    process.env.KALSHI_DRY_RUN = 'true';
    let fetchCalled = false;
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: keyPath });
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
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-error-test-'));
    keyPath = path.join(dir, 'kalshi_key.pem');
    const { privateKeyPem } = generateTestKeyPair();
    writeFileSync(keyPath, privateKeyPem);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws KalshiRequestError carrying statusCode and Retry-After on a non-OK response', async () => {
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: keyPath });
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
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: keyPath });
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

  it('preserves the SIGN of a NO holding rather than reporting its magnitude', () => {
    // Kalshi's `position` is signed: negative = a NO holding (confirmed against
    // kalshi-spine's and Fast99Follower's identical normalize.js). Fill detection
    // depends entirely on that sign surviving this function.
    const resp = { market_positions: [{ ticker: 'A', position: -93 }] };
    expect(positionForTicker(resp, 'A')).toBe(-93);
  });

  // --- I6: a malformed entry is not a zero position ----------------------------

  it('throws rather than fabricating a 0 when a MATCHING entry has a non-numeric position', () => {
    // Distinct from "no entry for this ticker", which legitimately means zero. A
    // fabricated zero here feeds straight into fill detection and the exposure
    // ledger -- exactly the "says something it never checked" failure mode.
    const resp = { market_positions: [{ ticker: 'A', position: NaN }] };
    expect(() => positionForTicker(resp, 'A')).toThrow(/non-numeric position for A/);
  });

  it('throws when a matching entry\'s position is missing entirely from the response shape', () => {
    const resp = { market_positions: [{ ticker: 'A' } as unknown as { ticker: string; position: number }] };
    expect(() => positionForTicker(resp, 'A')).toThrow(/non-numeric position for A/);
  });
});

describe('KalshiClient getPositions pagination', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-positions-test-'));
    keyPath = path.join(dir, 'kalshi_key.pem');
    writeFileSync(keyPath, generateTestKeyPair().privateKeyPem);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function clientWithPages(pages: Array<Record<string, unknown>>): {
    client: KalshiClient;
    urls: string[];
  } {
    const urls: string[] = [];
    // A high rate limit only so the multi-page tests do not spend the default
    // throttle's 200ms per request; it has no bearing on what is being tested.
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: keyPath, requestsPerSecond: 1000 });
    // @ts-expect-error -- test-only fetch injection
    client._fetchFn = async (url: string) => {
      urls.push(url);
      const page = pages[Math.min(urls.length - 1, pages.length - 1)];
      return new Response(JSON.stringify(page), { status: 200 });
    };
    return { client, urls };
  }

  it('follows the cursor and returns every page merged into one market_positions array', async () => {
    // The bug this closes: with only the first page fetched, a ticker on page two
    // reads back as absent -- and absent means 0, which is indistinguishable from
    // "really flat" and blocks a healthy market on a spurious divergence.
    const { client, urls } = clientWithPages([
      { market_positions: [{ ticker: 'A', position: 10 }, { ticker: 'B', position: -5 }], cursor: 'CURSOR-2' },
      { market_positions: [{ ticker: 'C', position: 7 }] },
    ]);

    const resp = await client.getPositions();

    expect(resp.market_positions).toEqual([
      { ticker: 'A', position: 10 },
      { ticker: 'B', position: -5 },
      { ticker: 'C', position: 7 },
    ]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('limit=1000');
    expect(urls[0]).not.toContain('cursor=');
    expect(urls[1]).toContain('cursor=CURSOR-2');
    // Callers see one clean list, never a paging token they might act on.
    expect(resp.cursor).toBeUndefined();
  });

  it('stops after one request when the first page carries no cursor', async () => {
    const { client, urls } = clientWithPages([
      { market_positions: [{ ticker: 'A', position: 10 }] },
    ]);

    const resp = await client.getPositions();

    expect(urls).toHaveLength(1);
    expect(resp.market_positions).toHaveLength(1);
  });

  it('preserves the SIGN of a NO holding that arrives on a later page', async () => {
    // Kalshi's position is signed; merging must not touch it.
    const { client } = clientWithPages([
      { market_positions: [{ ticker: 'A', position: 10 }], cursor: 'C2' },
      { market_positions: [{ ticker: 'NO-SIDE', position: -40 }] },
    ]);

    const resp = await client.getPositions();

    expect(positionForTicker(resp, 'NO-SIDE')).toBe(-40);
  });

  it('throws instead of returning a truncated list when the cursor never terminates', async () => {
    // A malformed or non-advancing cursor must not silently yield a partial
    // snapshot presented as complete -- that is the very failure this pagination
    // exists to prevent.
    const { client, urls } = clientWithPages([
      { market_positions: [{ ticker: 'A', position: 1 }], cursor: 'FOREVER' },
    ]);

    await expect(client.getPositions()).rejects.toThrow(/did not terminate after 50 pages/);
    expect(urls).toHaveLength(50);
  });
});

describe('KalshiClient error logging', () => {
  let dir: string;
  let keyPath: string;
  let dbDir: string;
  let db: ReturnType<typeof openLedger>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-key-test-'));
    keyPath = path.join(dir, 'kalshi_key.pem');
    const { privateKeyPem } = generateTestKeyPair();
    writeFileSync(keyPath, privateKeyPem);

    dbDir = mkdtempSync(path.join(tmpdir(), 'kalshi-client-errors-test-'));
    db = openLedger(path.join(dbDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('logs a kalshi_errors row (call_site without the query string) and still rethrows the original error', async () => {
    const client = new KalshiClient(
      { apiKeyId: 'k', privateKeyPath: keyPath },
      { db }
    );
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () =>
      new Response('server exploded', { status: 500, statusText: 'Internal Server Error' });

    await expect(client.getBalance()).rejects.toThrow(/500/);

    const row = db.prepare('SELECT call_site, error_message FROM kalshi_errors').get() as
      { call_site: string; error_message: string };
    expect(row.call_site).toBe('/portfolio/balance');
    expect(row.error_message).toMatch(/500/);
  });

  it('trips the kalshi-errors circuit breaker after enough real errors, driving the real call site', async () => {
    const client = new KalshiClient(
      { apiKeyId: 'k', privateKeyPath: keyPath },
      { db }
    );
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () =>
      new Response('down', { status: 500, statusText: 'Internal Server Error' });

    for (let i = 0; i < CIRCUIT_BREAKER_KALSHI_ERRORS_THRESHOLD; i++) {
      await expect(client.getBalance()).rejects.toThrow();
    }
    expect(isTradingHalted(db)).toBe(true);
  });

  it('without a db, an error still throws normally and nothing is logged', async () => {
    const client = new KalshiClient({ apiKeyId: 'k', privateKeyPath: keyPath });
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () =>
      new Response('down', { status: 500, statusText: 'Internal Server Error' });
    await expect(client.getBalance()).rejects.toThrow(/500/);
  });

  it('logs a kalshi_errors row when _fetchFn throws (network error path) and rethrows the original error', async () => {
    const client = new KalshiClient(
      { apiKeyId: 'k', privateKeyPath: keyPath },
      { db }
    );
    const networkError = new Error('ECONNREFUSED: connection refused');
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () => {
      throw networkError;
    };

    await expect(client.getBalance()).rejects.toThrow('ECONNREFUSED: connection refused');

    const row = db.prepare('SELECT call_site, error_message FROM kalshi_errors').get() as
      { call_site: string; error_message: string };
    expect(row.call_site).toBe('/portfolio/balance');
    expect(row.error_message).toBe('ECONNREFUSED: connection refused');
  });

  it('strips query string from call_site when logging errors on endpoints with query parameters', async () => {
    const client = new KalshiClient(
      { apiKeyId: 'k', privateKeyPath: keyPath },
      { db }
    );
    (client as unknown as { _fetchFn: typeof fetch })._fetchFn = async () =>
      new Response('not found', { status: 500, statusText: 'Internal Server Error' });

    await expect(client.getOrders({ client_order_id: 'test-order-123' })).rejects.toThrow(/500/);

    const row = db.prepare('SELECT call_site, error_message FROM kalshi_errors').get() as
      { call_site: string; error_message: string };
    expect(row.call_site).toBe('/portfolio/orders');
    expect(row.error_message).toMatch(/500/);
  });
});
