import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { collectMacro, latestPoint, MACRO_SERIES, parseFredCsv } from '../../src/perp/collectors/fred.js';
import { calendarCoverageDays, highImpactWindowOpen, loadCalendar } from '../../src/perp/collectors/calendar.js';
import { collectKalshiEvents } from '../../src/perp/collectors/kalshiEvents.js';
import { collectPerp } from '../../src/perp/collectors/perpMarket.js';

const csv = 'observation_date,VIXCLS\n2026-10-09,17.10\n2026-10-12,.\n2026-10-13,16.20\n2026-10-14,\n';

describe('FRED', () => {
  it('parses valid rows, skipping "." and blanks, oldest first', () => {
    expect(parseFredCsv(csv)).toEqual([{ date: '2026-10-09', value: 17.1 }, { date: '2026-10-13', value: 16.2 }]);
    expect(parseFredCsv('DATE,X\n2026-01-01,1.5\n')).toEqual([{ date: '2026-01-01', value: 1.5 }]);
    expect(parseFredCsv('')).toEqual([]);
  });
  it('latestPoint gives the value, the change vs the previous observation, and the date', () => {
    const p = latestPoint(parseFredCsv(csv));
    expect(p?.value).toBe(16.2);
    expect(p?.change1d).toBeCloseTo(-0.9, 8);
    expect(p?.asOf).toBe('2026-10-13');
    expect(latestPoint([{ date: 'd', value: 1 }])).toEqual({ value: 1, change1d: null, asOf: 'd' });
    expect(latestPoint([])).toBeNull();
  });
  it('collectMacro skips a failing series and returns the rest', async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes('id=DGS10')) return new Response('boom', { status: 500 });
      const id = new URL(url).searchParams.get('id');
      return new Response(`observation_date,${id}\n2026-10-12,10\n2026-10-13,11\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let logged = 0;
    const macro = await collectMacro(fetchFn).finally(() => {
      logged = errSpy.mock.calls.length;
      errSpy.mockRestore();
    });
    expect(logged).toBe(1); // the failure is logged, not thrown
    expect(Object.keys(macro).sort()).toEqual(Object.keys(MACRO_SERIES).filter((k) => k !== 'us10y').sort());
    expect(macro.vix).toEqual({ value: 11, change1d: 1, asOf: '2026-10-13' });
  });
});

describe('calendar (review focus 6)', () => {
  const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
  const H = 3_600_000;
  function withFile(content: string, fn: (file: string) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), 'perp-cal-'));
    try {
      const file = path.join(dir, 'cal.json');
      writeFileSync(file, content);
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it('returns events inside [now-1h, now+72h] sorted by time, and reports coverage', () => {
    const data = [
      { at: new Date(NOW + 80 * H).toISOString(), name: 'far', impact: 'high' },
      { at: new Date(NOW + 5 * H).toISOString(), name: 'soon', impact: 'high' },
      { at: new Date(NOW - 30 * 60_000).toISOString(), name: 'just happened', impact: 'medium' },
      { at: new Date(NOW - 5 * H).toISOString(), name: 'old', impact: 'high' },
    ];
    withFile(JSON.stringify(data), (file) => {
      expect(loadCalendar(file, NOW).map((e) => e.name)).toEqual(['just happened', 'soon']);
      expect(calendarCoverageDays(file, NOW)).toBeCloseTo(80 / 24, 5);
    });
  });
  it('an empty file is valid but has zero coverage', () => {
    withFile('[]', (file) => {
      expect(loadCalendar(file, NOW)).toEqual([]);
      expect(calendarCoverageDays(file, NOW)).toBe(0);
    });
  });
  it('a missing or malformed file is an error, not "no events"', () => {
    expect(() => loadCalendar('/nonexistent/perp-calendar.json', NOW)).toThrow();
    withFile('{not json', (file) => expect(() => loadCalendar(file, NOW)).toThrow());
    withFile(JSON.stringify([{ at: 'not a date', name: 'x', impact: 'high' }]), (file) => expect(() => loadCalendar(file, NOW)).toThrow());
    withFile(JSON.stringify([{ at: '2026-10-20T00:00:00Z', name: 'x', impact: 'extreme' }]), (file) => expect(() => loadCalendar(file, NOW)).toThrow());
  });
});

describe('calendar timestamps need an explicit offset', () => {
  const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
  function withFile(content: string, fn: (file: string) => void) {
    const dir = mkdtempSync(path.join(tmpdir(), 'perp-cal-'));
    try {
      const file = path.join(dir, 'cal.json');
      writeFileSync(file, content);
      fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  it.each(['2026-11-05T19:00:00', '2026-11-05', '11/05/2026 2pm'])('rejects %s in loadCalendar and calendarCoverageDays', (at) => {
    withFile(JSON.stringify([{ at, name: 'x', impact: 'high' }]), (file) => {
      expect(() => loadCalendar(file, NOW)).toThrow();
      expect(() => calendarCoverageDays(file, NOW)).toThrow();
    });
  });
  it('accepts Z and numeric offsets and yields the right epoch ms', () => {
    const data = [
      { at: '2026-10-15T19:00:00Z', name: 'zulu', impact: 'high' },
      { at: '2026-10-15T14:00:00-05:00', name: 'minus5', impact: 'medium' },
      { at: '2026-10-16T01:30:00.500+02:00', name: 'frac', impact: 'high' },
    ];
    withFile(JSON.stringify(data), (file) => {
      const got = loadCalendar(file, NOW);
      expect(got.map((e) => e.tsMs)).toEqual([Date.UTC(2026, 9, 15, 19, 0, 0), Date.UTC(2026, 9, 15, 19, 0, 0), Date.UTC(2026, 9, 15, 23, 30, 0, 500)]);
    });
  });
});

describe('Kalshi event markets', () => {
  it('returns the yes mid price for markets with both a bid and an ask, skipping the rest', async () => {
    const fetchFn = (async (url: string) => {
      if (url.endsWith('/markets/A')) return new Response(JSON.stringify({ market: { yes_bid_dollars: '0.6000', yes_ask_dollars: '0.6400' } }));
      if (url.endsWith('/markets/B')) return new Response(JSON.stringify({ market: { yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0500' } }));
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const out = await collectKalshiEvents(['A', 'B', 'C'], fetchFn);
    expect(out).toHaveLength(1);
    expect(out[0].ticker).toBe('A');
    expect(out[0].yesProb).toBeCloseTo(0.62, 10);
    expect(await collectKalshiEvents([], fetchFn)).toEqual([]);
  });
});

describe('collectPerp', () => {
  const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
  const market = {
    market: {
      bid: '13.7568', ask: '13.7576', price: '13.7576', liquidation_mark_price: { price: '13.7571' },
      schedule: { is_open: true, next_close_ts: 1792184400, next_open_ts: null },
    },
  };
  const get = (market: unknown, funding: unknown) => async (path: string) => {
    if (path.startsWith('/margin/markets/')) return market;
    if (path.startsWith('/margin/funding_rates/estimate')) return funding;
    throw new Error(`unexpected ${path}`);
  };
  it('maps the market, schedule (seconds -> ms) and funding estimate', async () => {
    const out = await collectPerp({ get: get(market, { funding_rate: 0.0002 }) } as never, 'KXUS500PERP', NOW);
    expect(out).toEqual({ bid: 13.7568, ask: 13.7576, mark: 13.7571, marketOpen: true, nextCloseTsMs: 1792184400_000, fundingEstimate: 0.0002 });
  });
  it('tolerates a missing schedule and a failing funding endpoint', async () => {
    const noSchedule = { market: { ...market.market, schedule: null } };
    const client = {
      get: async (path: string) => {
        if (path.startsWith('/margin/funding_rates')) throw new Error('404');
        return noSchedule;
      },
    };
    const out = await collectPerp(client as never, 'KXUS500PERP', NOW);
    expect(out.marketOpen).toBe(true); // unknown schedule: the broker, not the collector, decides tradability
    expect(out.nextCloseTsMs).toBeNull();
    expect(out.fundingEstimate).toBeNull();
  });
  it('throws when the quote is unusable', async () => {
    const withMarket = (m: Record<string, unknown>) => ({ get: async () => ({ market: { ...market.market, ...m } }) });
    await expect(collectPerp(withMarket({ bid: '0' }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
    await expect(collectPerp(withMarket({ ask: undefined }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
    await expect(collectPerp(withMarket({ ask: 'abc' }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
    await expect(collectPerp(withMarket({ liquidation_mark_price: { price: 'abc' } }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
    await expect(collectPerp(withMarket({ liquidation_mark_price: undefined, price: undefined }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
  });
  describe('closed market (W7)', () => {
    const closed = (m: Record<string, unknown>) => ({
      get: get({ market: { ...market.market, schedule: { is_open: false, next_close_ts: null, next_open_ts: 1792400000 }, ...m } }, { funding_rate: 0.0001 }),
    });
    it.each([
      ['missing', { bid: undefined, ask: undefined }],
      ['zero', { bid: '0.0000', ask: '0.0000' }],
      ['garbage', { bid: 'abc', ask: '' }],
    ])('a %s bid/ask does not throw: bid = ask = the liquidation mark, marketOpen false', async (_l, m) => {
      const out = await collectPerp(closed(m) as never, 'KXUS500PERP', NOW);
      expect(out).toMatchObject({ bid: 13.7571, ask: 13.7571, mark: 13.7571, marketOpen: false, nextCloseTsMs: null });
    });
    it('falls back to the last price when the liquidation mark is unusable', async () => {
      const out = await collectPerp(closed({ bid: undefined, liquidation_mark_price: { price: '' } }) as never, 'KXUS500PERP', NOW);
      expect(out).toMatchObject({ bid: 13.7576, ask: 13.7576, mark: 13.7576, marketOpen: false });
    });
    it('still throws when there is no finite positive mark at all', async () => {
      for (const m of [
        { liquidation_mark_price: undefined, price: undefined },
        { liquidation_mark_price: { price: '0' }, price: '0' },
        { liquidation_mark_price: { price: 'abc' }, price: '-1' },
      ]) {
        await expect(collectPerp(closed({ bid: undefined, ...m }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
      }
    });
    it('an open market keeps the strict checks', async () => {
      const open = (m: Record<string, unknown>) => ({ get: get({ market: { ...market.market, ...m } }, { funding_rate: 0.0001 }) });
      await expect(collectPerp(open({ bid: undefined }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
      await expect(collectPerp(open({ ask: '0' }) as never, 'KXUS500PERP', NOW)).rejects.toThrow(/unusable/);
    });
  });
  it('propagates a failing market request', async () => {
    const client = { get: async () => { throw new Error('market 503'); } };
    await expect(collectPerp(client as never, 'KXUS500PERP', NOW)).rejects.toThrow('market 503');
  });
});

describe('highImpactWindowOpen', () => {
  const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
  const file = () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cal-')), 'c.json');
    fs.writeFileSync(f, JSON.stringify([
      { at: '2026-10-14T15:30:00Z', name: 'CPI', impact: 'high' },
      { at: '2026-10-14T20:00:00Z', name: 'Retail sales', impact: 'medium' },
    ]));
    return f;
  };
  it('is open within 2 hours before or after a high-impact event', () => {
    expect(highImpactWindowOpen(file(), NOW)).toBe(true); // 30 min before CPI
    expect(highImpactWindowOpen(file(), NOW + 3_600_000)).toBe(true); // 30 min after
    expect(highImpactWindowOpen(file(), NOW + 2.5 * 3_600_000 + 1)).toBe(false);
    expect(highImpactWindowOpen(file(), NOW - 2 * 3_600_000)).toBe(false);
  });
  it('ignores medium-impact events and throws on a missing file', () => {
    expect(highImpactWindowOpen(file(), Date.UTC(2026, 9, 14, 20, 0, 0))).toBe(false);
    expect(() => highImpactWindowOpen('/nonexistent/cal.json', NOW)).toThrow();
  });
});
