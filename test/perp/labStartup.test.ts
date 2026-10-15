// test/perp/labStartup.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { assertPaperOnly, resolveLabConfig } from '../../src/perp/lab/startup.js';

const env = (o: Record<string, string | undefined> = {}) => ({ PERP_MODE: 'paper', ...o }) as NodeJS.ProcessEnv;

describe('assertPaperOnly', () => {
  it('accepts a pinned paper process', () => {
    expect(() => assertPaperOnly(env())).not.toThrow();
  });
  it('refuses anything else', () => {
    expect(() => assertPaperOnly({} as NodeJS.ProcessEnv)).toThrow(/PERP_MODE/);
    expect(() => assertPaperOnly(env({ PERP_MODE: 'live' }))).toThrow(/PERP_MODE/);
    expect(() => assertPaperOnly(env({ PERP_MODE: 'demo' }))).toThrow(/PERP_MODE/);
    expect(() => assertPaperOnly(env({ PERP_LIVE: 'KXUS500PERP:3' }))).toThrow(/PERP_LIVE/);
  });
});

describe('resolveLabConfig', () => {
  it('defaults: $0.50/day, 7 days, paths under the repo data dir', () => {
    const c = resolveLabConfig(env(), '/repo');
    expect(c).toMatchObject({ capUsd: 0.5, days: 7 });
    expect(c.dataDir).toBe(path.join('/repo', 'data', 'perp'));
    expect(c.botDbPath).toBe(path.join('/repo', 'data', 'perp', 'perp-paper.db'));
    expect(c.prefilterFile).toBe(path.join('/repo', 'config', 'perp-prefilter.json'));
    expect(Number.isInteger(c.seed)).toBe(true);
  });
  it('reads overrides and rejects nonsense', () => {
    expect(resolveLabConfig(env({ LAB_DAILY_USD_CAP: '0.25', LAB_DAYS: '3', LAB_SEED: '42' }), '/r')).toMatchObject({ capUsd: 0.25, days: 3, seed: 42 });
    expect(() => resolveLabConfig(env({ LAB_DAILY_USD_CAP: '0' }), '/r')).toThrow(/LAB_DAILY_USD_CAP/);
    expect(() => resolveLabConfig(env({ LAB_DAILY_USD_CAP: '5' }), '/r')).toThrow(/LAB_DAILY_USD_CAP/); // the lab's audit budget is small by design
    expect(() => resolveLabConfig(env({ LAB_DAYS: '0' }), '/r')).toThrow(/LAB_DAYS/);
    expect(() => resolveLabConfig(env({ LAB_SEED: 'x' }), '/r')).toThrow(/LAB_SEED/);
  });
});
