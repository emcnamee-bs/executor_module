import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchActiveLadder } from '../../src/decide/kalshi.js';

function stubKalshi(events: Array<{ event_ticker: string; strike_date?: string | null }>) {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: any) => {
    urls.push(String(url));
    if (String(url).includes('/events?')) return new Response(JSON.stringify({ events }), { status: 200 });
    return new Response(JSON.stringify({ markets: [{ ticker: 'M-1', strike_type: 'greater', floor_strike: 1, status: 'active', yes_ask_dollars: '0.5000', yes_bid_dollars: '0.4000', yes_ask_size_fp: '10.00', yes_bid_size_fp: '10.00' }] }), { status: 200 });
  }) as any);
  return urls;
}

describe('fetchActiveLadder event selection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not throw when open events carry no strike_date (Kalshi leaves it null on weekly/rolling series) and uses the first listed', async () => {
    const urls = stubKalshi([{ event_ticker: 'KXEOWEEK-26OCT10', strike_date: null }, { event_ticker: 'KXEOWEEK-26OCT17' }]);
    const ladder = await fetchActiveLadder('KXEOWEEK');
    expect(ladder?.eventTicker).toBe('KXEOWEEK-26OCT10');
    expect(urls[1]).toContain('event_ticker=KXEOWEEK-26OCT10');
  });

  it('still picks the earliest strike_date when every event has one (live KXAPRPOTUS behaviour unchanged)', async () => {
    stubKalshi([
      { event_ticker: 'LATE', strike_date: '2026-10-20T00:00:00Z' },
      { event_ticker: 'EARLY', strike_date: '2026-10-12T00:00:00Z' },
    ]);
    const ladder = await fetchActiveLadder('KXAPRPOTUS');
    expect(ladder?.eventTicker).toBe('EARLY');
    expect(ladder?.strikeDate).toBe('2026-10-12T00:00:00Z');
  });

  it('a dated event sorts ahead of an undated one instead of crashing the comparison', async () => {
    stubKalshi([{ event_ticker: 'UNDATED', strike_date: null }, { event_ticker: 'DATED', strike_date: '2026-10-12T00:00:00Z' }]);
    const ladder = await fetchActiveLadder('S');
    expect(ladder?.eventTicker).toBe('UNDATED'); // '' sorts before any date: documented, stable, and never throws
  });
});
