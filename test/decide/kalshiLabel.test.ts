// test/decide/kalshiLabel.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchLadderForEvent } from '../../src/decide/kalshi.js';

const market = (ticker: string, extra: Record<string, unknown> = {}) => ({
  ticker, status: 'active', yes_ask_dollars: '0.5500', yes_bid_dollars: '0.5000', yes_ask_size_fp: '10.00', yes_bid_size_fp: '8.00', ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchEventBands label', () => {
  it('maps yes_sub_title to label, trimmed, and omits it when absent or blank', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ markets: [market('EV-A', { yes_sub_title: '  Hike 25bps ' }), market('EV-B', { yes_sub_title: '   ' }), market('EV-C')] }),
    })));
    const ladder = await fetchLadderForEvent('EV');
    expect(ladder.bands[0].label).toBe('Hike 25bps');
    expect('label' in ladder.bands[1]).toBe(false);
    expect('label' in ladder.bands[2]).toBe(false);
  });
});
