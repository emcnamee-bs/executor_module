// test/decide/kalshiEventLadder.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openLedger } from '../../src/decide/ledger.js';
import { fetchLadderForEvent } from '../../src/decide/kalshi.js';

function market(over: Record<string, unknown> = {}) {
  return {
    ticker: 'KXWTI-26OCT1314-T92.99', floor_strike: 92.99, strike_type: 'greater', status: 'active',
    yes_ask_dollars: '0.1900', yes_bid_dollars: '0.1800', yes_ask_size_fp: '120.00', yes_bid_size_fp: '80.50', ...over,
  };
}
function stubFetch(body: unknown, ok = true, status = 200) {
  const f = vi.fn(async (_url: string) => ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => body }));
  vi.stubGlobal('fetch', f);
  return f;
}

describe('fetchLadderForEvent', () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ladder-test-'));
    db = openLedger(path.join(dir, 'l.db'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const kalshiErrors = () => (db.prepare(`SELECT COUNT(*) AS n FROM kalshi_errors`).get() as { n: number }).n;

  it('maps the open markets of that event, with sizes and no-quote as null', async () => {
    const f = stubFetch({ markets: [market(), market({ ticker: 'KXWTI-26OCT1314-T95', floor_strike: 95, yes_ask_dollars: '0.0300', yes_bid_dollars: '0.0000', yes_bid_size_fp: '0.00' })] });
    const ladder = await fetchLadderForEvent('KXWTI-26OCT1314', undefined, '2026-10-13T18:30:00Z');
    expect(f.mock.calls[0][0]).toContain('/markets?event_ticker=KXWTI-26OCT1314&status=open');
    expect(ladder.eventTicker).toBe('KXWTI-26OCT1314');
    expect(ladder.strikeDate).toBe('2026-10-13T18:30:00Z');
    expect(ladder.bands[0]).toEqual({
      ticker: 'KXWTI-26OCT1314-T92.99', floorStrike: 92.99, capStrike: null, strikeType: 'greater', status: 'active',
      yesAskCents: 19, yesBidCents: 18, yesAskSizeContracts: 120, yesBidSizeContracts: 80,
    });
    expect(ladder.bands[1]).toMatchObject({ yesAskCents: 3, yesBidCents: null, yesBidSizeContracts: 0 });
  });

  it('an event with no open markets is an empty ladder, not an error', async () => {
    stubFetch({ markets: [] });
    expect((await fetchLadderForEvent('KXWTI-OLD')).bands).toEqual([]);
  });

  it('throws on an HTTP failure and writes kalshi_errors only when a db is passed', async () => {
    stubFetch({}, false, 500);
    await expect(fetchLadderForEvent('KXWTI-26OCT1314')).rejects.toThrow(/500/);
    expect(kalshiErrors()).toBe(0);
    await expect(fetchLadderForEvent('KXWTI-26OCT1314', db)).rejects.toThrow(/500/);
    expect(kalshiErrors()).toBe(1);
  });
});
