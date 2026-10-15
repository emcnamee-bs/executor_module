import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify, constants, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KalshiMarginClient, MarginApiError } from '../../src/perp/broker/kalshiMarginClient.js';

let dir: string;
let keyPath: string;
let publicKey: KeyObject;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'perp-key-'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pair.publicKey;
  keyPath = path.join(dir, 'k.pem');
  writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Call { url: string; init: RequestInit }
function fakeFetch(reply: (call: Call) => Response): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    return reply(c);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('KalshiMarginClient timeouts', () => {
  /** A fetch that never answers on its own: it settles only when the request's abort signal fires, like a hung connection. */
  function hangingFetch(): { fn: typeof fetch; signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    const fn = ((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    }) as unknown as typeof fetch;
    return { fn, signals };
  }

  it('gives up on a hung GET after readTimeoutMs', async () => {
    const { fn } = hangingFetch();
    const client = new KalshiMarginClient({ env: 'prod', apiKeyId: 'k', privateKeyPath: keyPath, readTimeoutMs: 60 }, { fetchFn: fn });
    const t0 = Date.now();
    await expect(client.get('/margin/markets/X')).rejects.toThrow(/timeout|abort/i);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('defaults GET to 5 s but keeps writes at 10 s (a timed-out order has an unknown outcome)', async () => {
    const { fn, signals } = hangingFetch();
    const client = new KalshiMarginClient({ env: 'prod', apiKeyId: 'k', privateKeyPath: keyPath }, { fetchFn: fn });
    void client.get('/margin/markets/X').catch(() => undefined);
    void client.post('/margin/orders', { x: 1 }).catch(() => undefined);
    void client.put('/margin/isolated/positions/X/exit_trigger', { x: 1 }).catch(() => undefined);
    void client.del('/margin/isolated/positions/X/exit_trigger').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500)); // throttle spaces the requests ~200 ms apart; none can have timed out yet
    expect(signals).toHaveLength(4);
    expect(signals.every((s) => !s.aborted)).toBe(true);
  });
});

describe('KalshiMarginClient', () => {
  it('signs timestamp+METHOD+pathname (no query) with RSA-PSS and sends the key id', async () => {
    const { fn, calls } = fakeFetch(() => json({ ok: true }));
    const client = new KalshiMarginClient(
      { env: 'prod', apiKeyId: 'key-123', privateKeyPath: keyPath },
      { now: () => 1735689600000, fetchFn: fn }
    );
    await client.get('/margin/markets/KXUS500PERP', { limit: 5, skip: undefined });

    expect(calls[0].url).toBe('https://external-api.kalshi.com/trade-api/v2/margin/markets/KXUS500PERP?limit=5');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['KALSHI-ACCESS-KEY']).toBe('key-123');
    expect(h['KALSHI-ACCESS-TIMESTAMP']).toBe('1735689600000');
    const ok = cryptoVerify(
      'sha256',
      Buffer.from('1735689600000GET/trade-api/v2/margin/markets/KXUS500PERP'),
      { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')
    );
    expect(ok).toBe(true);
  });

  it('uses the demo host for env=demo', async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    const client = new KalshiMarginClient({ env: 'demo', apiKeyId: 'k', privateKeyPath: keyPath }, { fetchFn: fn });
    await client.get('/margin/enabled');
    expect(calls[0].url).toBe('https://external-api.demo.kalshi.co/trade-api/v2/margin/enabled');
  });

  it('sends JSON bodies for POST and PUT, and a query for DELETE', async () => {
    const { fn, calls } = fakeFetch(() => json({ ok: 1 }));
    const client = new KalshiMarginClient({ env: 'prod', apiKeyId: 'k', privateKeyPath: keyPath }, { fetchFn: fn });
    await client.post('/margin/orders', { a: 1 });
    await client.put('/margin/cross/positions/T/exit_trigger', { kind: 'trailing', trail_bps: 388 }, { subaccount: 2 });
    await client.del('/margin/isolated/positions/T/exit_trigger');
    expect(calls.map((c) => c.init.method)).toEqual(['POST', 'PUT', 'DELETE']);
    expect(calls[0].init.body).toBe('{"a":1}');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(calls[1].url).toContain('?subaccount=2');
    expect(calls[2].init.body).toBeUndefined();
  });

  it('returns null for an empty body (204)', async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 204 }));
    const client = new KalshiMarginClient({ env: 'prod', apiKeyId: 'k', privateKeyPath: keyPath }, { fetchFn: fn });
    expect(await client.del('/margin/isolated/positions/T/exit_trigger')).toBeNull();
  });

  it('throws MarginApiError with status, body and Retry-After, and never echoes the key id', async () => {
    const { fn } = fakeFetch(() => new Response('{"error":"slow down"}', { status: 429, headers: { 'Retry-After': '3' } }));
    const client = new KalshiMarginClient({ env: 'prod', apiKeyId: 'SECRET-KEY-ID', privateKeyPath: keyPath }, { fetchFn: fn });
    const err = (await client.get('/margin/balance').catch((e: unknown) => e)) as MarginApiError;
    expect(err).toBeInstanceOf(MarginApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.body).toContain('slow down');
    expect(err.message).not.toContain('SECRET-KEY-ID');
  });

  const FIXED_KEY_ERROR = 'Kalshi private key could not be read or parsed (check the key file path and format)';

  it('fails at construction with a fixed message when the key file does not exist (no path, no key id)', () => {
    const missing = path.join(dir, 'no-such-dir', 'missing-key.pem');
    let err: unknown;
    try {
      new KalshiMarginClient({ env: 'prod', apiKeyId: 'SECRET-KEY-ID', privateKeyPath: missing });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toBe(FIXED_KEY_ERROR);
    expect(String(e)).not.toContain(missing);
    expect(String(e)).not.toContain('missing-key.pem');
    expect(String(e)).not.toContain('SECRET-KEY-ID');
    expect((e as { cause?: unknown }).cause).toBeUndefined();
    expect((e as { path?: unknown }).path).toBeUndefined();
  });

  it('fails at construction with the same fixed message when the key file is not a PEM', () => {
    const garbage = path.join(dir, 'garbage-key.pem');
    writeFileSync(garbage, 'this is not a pem file');
    let err: unknown;
    try {
      new KalshiMarginClient({ env: 'prod', apiKeyId: 'SECRET-KEY-ID', privateKeyPath: garbage });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toBe(FIXED_KEY_ERROR);
    expect(String(e)).not.toContain(garbage);
    expect(String(e)).not.toContain('garbage-key.pem');
    expect(String(e)).not.toContain('SECRET-KEY-ID');
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });
});
