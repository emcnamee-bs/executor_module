// test/profile/multiProfile.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProfile, assertLiveAllowed, OUTCOME_GROUPS } from '../../src/profile/profile.js';
import { writeProfile } from './fixtures.js';

const root = () => mkdtempSync(path.join(tmpdir(), 'multiprofile-'));
const load = (over: Record<string, unknown>) => {
  const r = root();
  writeProfile(r, 'kxfeddecision', { profile: { seriesTicker: 'KXFEDDECISION', ...over } });
  return loadProfile('kxfeddecision', r);
};

describe('multi profiles', () => {
  it('lists the three outcome groups', () => {
    expect([...OUTCOME_GROUPS]).toEqual(['ladder', 'exclusive', 'independent']);
  });

  it('loads a multi profile that names its outcomeGroup', () => {
    const loaded = load({ marketStructure: 'multi', outcomeGroup: 'exclusive' });
    expect(loaded.profile.marketStructure).toBe('multi');
    expect(loaded.profile.outcomeGroup).toBe('exclusive');
  });

  it('rejects a multi profile without an outcomeGroup', () => {
    expect(() => load({ marketStructure: 'multi' })).toThrow(/outcomeGroup/);
  });

  it('rejects an outcomeGroup on any other structure', () => {
    expect(() => load({ marketStructure: 'threshold', outcomeGroup: 'ladder' })).toThrow(/outcomeGroup/);
    expect(() => load({ marketStructure: 'capture', outcomeGroup: 'ladder' })).toThrow(/outcomeGroup/);
  });

  it('rejects an unknown outcomeGroup value', () => {
    expect(() => load({ marketStructure: 'multi', outcomeGroup: 'sequence' })).toThrow(/outcomeGroup/);
  });

  it('is paper-only: refuses a start without KALSHI_DRY_RUN=true', () => {
    const { profile } = load({ marketStructure: 'multi', outcomeGroup: 'ladder' });
    expect(() => assertLiveAllowed(profile, {} as NodeJS.ProcessEnv)).toThrow(/paper-only/);
    expect(() => assertLiveAllowed(profile, { KALSHI_DRY_RUN: 'true' } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
