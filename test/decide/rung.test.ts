import { describe, it, expect } from 'vitest';
import { computeRung, computeRungDetailed, RUNG_STAKES } from '../../src/decide/rung.js';

describe('RUNG_STAKES', () => {
  it('has the four expected stake values', () => {
    expect(RUNG_STAKES).toEqual({
      rumor: 0.0,
      reported: 0.25,
      corroborated: 0.5,
      confirmed: 1.0,
    });
  });
});

describe('computeRung', () => {
  it('tier 1 with no story_key floors at reported', () => {
    expect(computeRung({ trustTier: 1, storyKey: null, corroborations: 0 })).toBe('reported');
  });

  it('tier 2 with no story_key floors at reported', () => {
    expect(computeRung({ trustTier: 2, storyKey: null, corroborations: 0 })).toBe('reported');
  });

  it('tier 3 with no story_key floors at rumor', () => {
    expect(computeRung({ trustTier: 3, storyKey: null, corroborations: 0 })).toBe('rumor');
  });

  it('tier 5 with no story_key floors at rumor', () => {
    expect(computeRung({ trustTier: 5, storyKey: null, corroborations: 0 })).toBe('rumor');
  });

  it('promotes to corroborated when story_key is set and corroborations >= 2, regardless of tier', () => {
    expect(computeRung({ trustTier: 3, storyKey: 'story-1', corroborations: 2 })).toBe('corroborated');
    expect(computeRung({ trustTier: 1, storyKey: 'story-1', corroborations: 3 })).toBe('corroborated');
  });

  it('does not promote when corroborations is 1 (reporter alone)', () => {
    expect(computeRung({ trustTier: 1, storyKey: 'story-1', corroborations: 1 })).toBe('reported');
    expect(computeRung({ trustTier: 3, storyKey: 'story-1', corroborations: 1 })).toBe('rumor');
  });

  it('ignores a nonzero corroborations count when story_key is null', () => {
    expect(computeRung({ trustTier: 3, storyKey: null, corroborations: 5 })).toBe('rumor');
  });
});

// EXECUTOR_PAPER_LOW_TIER (paper-only data-collection test). The relaxation is an
// explicit input, never read from the environment here: the pipeline decides whether
// it may apply (paper process only) and passes it in.
describe('computeRungDetailed with relaxLowTier', () => {
  it.each([3, 4])('relaxes a single-source tier %i item from rumor to reported, and says so', (tier) => {
    expect(computeRungDetailed({ trustTier: tier, storyKey: null, corroborations: 0, relaxLowTier: true })).toEqual({
      rung: 'reported', lowTierRelaxedFrom: tier,
    });
    expect(computeRungDetailed({ trustTier: tier, storyKey: 's', corroborations: 1, relaxLowTier: true })).toEqual({
      rung: 'reported', lowTierRelaxedFrom: tier,
    });
  });

  it('never relaxes tier 5 (unverified): it stays rumor', () => {
    expect(computeRungDetailed({ trustTier: 5, storyKey: null, corroborations: 0, relaxLowTier: true })).toEqual({
      rung: 'rumor', lowTierRelaxedFrom: null,
    });
  });

  it('without the switch (false or absent) tier 3/4 stay rumor', () => {
    for (const relaxLowTier of [false, undefined]) {
      expect(computeRungDetailed({ trustTier: 4, storyKey: null, corroborations: 0, relaxLowTier })).toEqual({
        rung: 'rumor', lowTierRelaxedFrom: null,
      });
      expect(computeRung({ trustTier: 3, storyKey: null, corroborations: 0, relaxLowTier })).toBe('rumor');
    }
  });

  it('does not touch rungs that were not rumor (tier 1/2 reported, corroborated)', () => {
    expect(computeRungDetailed({ trustTier: 1, storyKey: null, corroborations: 0, relaxLowTier: true })).toEqual({
      rung: 'reported', lowTierRelaxedFrom: null,
    });
    expect(computeRungDetailed({ trustTier: 4, storyKey: 's', corroborations: 2, relaxLowTier: true })).toEqual({
      rung: 'corroborated', lowTierRelaxedFrom: null,
    });
  });
});
