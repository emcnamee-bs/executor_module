// test/decide/kalshi.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchActiveLadder, fetchMarketStatus } from '../../src/decide/kalshi.js';
import { openLedger } from '../../src/decide/ledger.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

describe('fetchActiveLadder (real Kalshi API)', () => {
  it('returns the currently active KXAPRPOTUS weekly event with a full band ladder', async () => {
    const ladder = await fetchActiveLadder('KXAPRPOTUS');

    expect(ladder).not.toBeNull();
    if (!ladder) return;

    expect(ladder.eventTicker).toMatch(/^KXAPRPOTUS-\d{2}[A-Z]{3}\d{2}$/);
    expect(ladder.bands.length).toBeGreaterThan(0);

    for (const band of ladder.bands) {
      expect(band.ticker.startsWith(ladder.eventTicker)).toBe(true);
      expect(['less', 'greater', 'between']).toContain(band.strikeType);
      if (band.strikeType === 'between') {
        expect(band.floorStrike).not.toBeNull();
        expect(band.capStrike).not.toBeNull();
      }
      if (band.strikeType === 'greater') {
        expect(band.floorStrike).not.toBeNull();
        expect(band.capStrike).toBeNull();
      }
      if (band.strikeType === 'less') {
        expect(band.capStrike).not.toBeNull();
        expect(band.floorStrike).toBeNull();
      }
      if (band.yesAskCents !== null) {
        expect(band.yesAskCents).toBeGreaterThan(0);
        expect(band.yesAskCents).toBeLessThanOrEqual(100);
      }
      if (band.yesBidCents !== null) {
        expect(band.yesBidCents).toBeGreaterThanOrEqual(0);
        expect(band.yesBidCents).toBeLessThan(100);
      }
      expect(band.yesAskSizeContracts).toBeGreaterThanOrEqual(0);
      expect(band.yesBidSizeContracts).toBeGreaterThanOrEqual(0);
    }
  }, 15000);

  it('returns null for a series with no open event', async () => {
    const ladder = await fetchActiveLadder('KXNONEXISTENTSERIESXYZ');
    expect(ladder).toBeNull();
  }, 15000);
});

describe('fetchMarketStatus (real Kalshi API)', () => {
  it('returns "finalized" with a yes/no result for a market that has actually resolved', async () => {
    // KXAPRPOTUS-26AUG28-39.8 finalized with result "yes" -- a real, confirmed
    // historical market from this project's own live API research. If Kalshi ever
    // purges old market data such that this ticker 404s, replace it with any current
    // event's finalized band (query
    // `/markets?series_ticker=KXAPRPOTUS&status=settled` for a fresh one).
    const status = await fetchMarketStatus('KXAPRPOTUS-26AUG28-39.8');
    expect(status.status).toBe('finalized');
    expect(['yes', 'no']).toContain(status.result);
  }, 15000);

  it('returns "closed" with an empty result for a market that closed but never finalized', async () => {
    // A real market over a year past its strike date with zero open interest --
    // confirmed live to still be stuck at status "closed", result "". Proves this
    // function reads the raw field verbatim rather than assuming "closed" implies
    // resolved.
    const status = await fetchMarketStatus('KXAPRPOTUS-25JAN31-40.0');
    expect(status.status).toBe('closed');
    expect(status.result).toBe('');
  }, 15000);
});

describe('fetchMarketStatus / fetchActiveLadder error logging', () => {
  let dir: string;
  let db: ReturnType<typeof openLedger>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kalshi-errors-test-'));
    db = openLedger(path.join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    fetchSpy?.mockRestore();
  });

  it('fetchMarketStatus logs to kalshi_errors and still throws, given a db', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('down', { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(fetchMarketStatus('SOME-TICKER', db)).rejects.toThrow();

    const row = db.prepare('SELECT call_site FROM kalshi_errors').get() as { call_site: string };
    expect(row.call_site).toBe('fetchMarketStatus');
  });

  it('fetchMarketStatus without a db still throws normally (no crash from the missing db)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('down', { status: 500, statusText: 'Internal Server Error' })
    );
    await expect(fetchMarketStatus('SOME-TICKER')).rejects.toThrow();
  });

  it('fetchActiveLadder logs to kalshi_errors and still throws, given a db', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('down', { status: 500, statusText: 'Internal Server Error' })
    );

    await expect(fetchActiveLadder('KXAPRPOTUS', db)).rejects.toThrow();

    const row = db.prepare('SELECT call_site FROM kalshi_errors').get() as { call_site: string };
    expect(row.call_site).toBe('fetchActiveLadder');
  });

  it('fetchMarketStatus logs to kalshi_errors on fetch rejection (network error) and still throws', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchMarketStatus('SOME-TICKER', db)).rejects.toThrow('ECONNREFUSED');

    const row = db.prepare('SELECT call_site FROM kalshi_errors').get() as { call_site: string };
    expect(row.call_site).toBe('fetchMarketStatus');
  });
});
