// test/decide/kalshi.test.ts
import { describe, it, expect } from 'vitest';
import { fetchActiveLadder } from '../../src/decide/kalshi.js';

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
