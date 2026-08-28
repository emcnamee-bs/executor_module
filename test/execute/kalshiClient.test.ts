import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, constants as cryptoConstants } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KalshiClient, positionForTicker, KalshiRequestError } from '../../src/execute/kalshiClient.js';

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
