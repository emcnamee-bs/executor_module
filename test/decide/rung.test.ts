import { describe, it, expect } from 'vitest';
import { computeRung, RUNG_STAKES } from '../../src/decide/rung.js';

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
