import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, loadPerpConfig } from '../../src/perp/config.js';

describe('loadPerpConfig', () => {
  it('returns the spec defaults when no override is given', () => {
    const cfg = loadPerpConfig({});
    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(cfg.ticker).toBe('KXUS500PERP');
    expect(cfg.leverageTarget).toBe(4);
    expect(cfg.lossBudget).toBe(0.2);
    expect(cfg.stopFloor).toBe(0.03);
    expect(cfg.stopCap).toBe(0.05);
    expect(cfg.maintenanceMargin).toEqual({ long: 0.0502, short: 0.056 });
    expect(cfg.allowLong && cfg.allowShort).toBe(true);
    expect(cfg.bucketMove).toEqual({ minor: 0.005, moderate: 0.015, major: 0.03, shock: 0.05 });
  });

  it('deep-merges PERP_CONFIG_JSON over the defaults', () => {
    const cfg = loadPerpConfig({
      PERP_CONFIG_JSON: JSON.stringify({ leverageTarget: 3, allowShort: false, bucketMove: { shock: 0.06 } }),
    });
    expect(cfg.leverageTarget).toBe(3);
    expect(cfg.allowShort).toBe(false);
    expect(cfg.bucketMove.shock).toBe(0.06);
    expect(cfg.bucketMove.minor).toBe(0.005);
    expect(cfg.lossBudget).toBe(0.2);
  });

  it('rejects invalid JSON, unknown keys and out-of-range values', () => {
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: '{nope' })).toThrow(/PERP_CONFIG_JSON/);
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ bogus: 1 }) })).toThrow();
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ leverageTarget: 0 }) })).toThrow();
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ lossBudget: 1.5 }) })).toThrow();
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ bucketMove: { nope: 0.1 } }) })).toThrow();
  });

  it('rejects a stop floor above the cap', () => {
    expect(() => loadPerpConfig({ PERP_CONFIG_JSON: JSON.stringify({ stopFloor: 0.06 }) })).toThrow(/stopFloor/);
  });
});
