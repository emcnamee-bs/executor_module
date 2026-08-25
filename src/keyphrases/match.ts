import type { Item } from '../item.js';

export interface CompiledPhrase {
  phrase: string;
  regex: RegExp;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the body of a phrase's regex: each word escaped literally, joined by `\s+`.
 *
 * The `\s+` join is load-bearing, not cosmetic. Upstream item text
 * (`Internet_Info_Plug`'s `normalize.py` / `feed.py` / `reddit.py` / `primary.py`)
 * does NOT normalize whitespace, so a real RSS or Reddit snippet routinely carries an
 * embedded newline, a double space, or a non-breaking space at exactly the word
 * boundary a multi-word keyphrase spans. Embedding the phrase's own literal single
 * spaces in the pattern would make every such item silently fail to match, with no
 * warning anywhere — the exact "looks healthy, checks nothing" failure class this
 * project watches for.
 */
function buildPhrasePattern(phrase: string): string {
  return phrase
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join('\\s+');
}

export function compilePhrases(phrases: string[]): CompiledPhrase[] {
  return phrases.map((phrase) => ({
    phrase,
    regex: new RegExp(`(?<!\\w)${buildPhrasePattern(phrase)}(?!\\w)`, 'i'),
  }));
}

export function findMatches(text: string, compiled: CompiledPhrase[]): string[] {
  return compiled.filter(({ regex }) => regex.test(text)).map(({ phrase }) => phrase);
}

export function getMatchableText(item: Item): string {
  if (item.provenance_gaps.includes('synthetic_headline')) {
    return item.snippet ?? '';
  }
  return [item.headline, item.snippet].filter((value): value is string => Boolean(value)).join(' ');
}
