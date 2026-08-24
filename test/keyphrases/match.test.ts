import { describe, it, expect } from 'vitest';
import { compilePhrases, findMatches, getMatchableText } from '../../src/keyphrases/match.js';
import type { Item } from '../../src/item.js';

describe('compilePhrases + findMatches', () => {
  it('matches case-insensitively', () => {
    const compiled = compilePhrases(['trump approval rating']);
    expect(findMatches('TRUMP APPROVAL RATING drops', compiled)).toEqual(['trump approval rating']);
  });

  it('respects word boundaries (does not match inside a longer word)', () => {
    const compiled = compilePhrases(['poll release']);
    expect(findMatches('a bipoll release-like event', compiled)).toEqual([]);
  });

  it('matches a phrase containing an apostrophe', () => {
    const compiled = compilePhrases(["trump's approval numbers"]);
    expect(findMatches("New data on trump's approval numbers today", compiled)).toEqual([
      "trump's approval numbers",
    ]);
  });

  it('matches a phrase containing a hyphen', () => {
    const compiled = compilePhrases(['self-driving car poll']);
    expect(findMatches('A new self-driving car poll was released', compiled)).toEqual([
      'self-driving car poll',
    ]);
  });

  it('returns all matched phrases when multiple match', () => {
    const compiled = compilePhrases(['trump approval', 'new poll released']);
    const result = findMatches('trump approval steady after new poll released today', compiled);
    expect(result.sort()).toEqual(['new poll released', 'trump approval'].sort());
  });

  it('returns an empty array when nothing matches', () => {
    const compiled = compilePhrases(['trump approval rating']);
    expect(findMatches('completely unrelated sports news', compiled)).toEqual([]);
  });

  it('safely handles phrases containing regex-special characters', () => {
    const compiled = compilePhrases(['q&a session (live)']);
    expect(findMatches('the q&a session (live) starts soon', compiled)).toEqual([
      'q&a session (live)',
    ]);
  });
});

function baseItem(overrides: Partial<Item> = {}): Item {
  return {
    item_id: '1755999999999-a1b2c3d4e5f6',
    dedup_id: 'dedup-1',
    story_key: null,
    event_type: 'item',
    replay: false,
    source_id: 'bbc_world',
    adapter: 'feed',
    trust_tier: 1,
    headline: 'A real headline',
    snippet: null,
    url: null,
    raw_url: null,
    enrich_url: null,
    author: null,
    lang: null,
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: null,
    first_seen_ts: '2026-08-24T10:01:00Z',
    emitted_ts: '2026-08-24T10:01:05Z',
    latency_ms: 5000,
    is_first_sighting: true,
    corroborations: 0,
    provenance_gaps: [],
    amends_item_id: null,
    amendment_kind: null,
    ...overrides,
  };
}

describe('getMatchableText', () => {
  it('combines headline and snippet for a normal item', () => {
    const item = baseItem({ headline: 'Headline text', snippet: 'Snippet text' });
    expect(getMatchableText(item)).toBe('Headline text Snippet text');
  });

  it('uses headline alone when snippet is null', () => {
    const item = baseItem({ headline: 'Headline only', snippet: null });
    expect(getMatchableText(item)).toBe('Headline only');
  });

  it('uses only snippet for a synthetic-headline item', () => {
    const item = baseItem({
      headline: 'source_x: watched page region changed',
      snippet: 'real page content here',
      provenance_gaps: ['synthetic_headline'],
    });
    expect(getMatchableText(item)).toBe('real page content here');
  });

  it('returns an empty string for a synthetic-headline item with no snippet', () => {
    const item = baseItem({
      headline: 'source_x: watched page region changed',
      snippet: null,
      provenance_gaps: ['synthetic_headline'],
    });
    expect(getMatchableText(item)).toBe('');
  });
});
