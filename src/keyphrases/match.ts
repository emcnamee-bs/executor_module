import type { Item } from '../item.js';

export interface CompiledPhrase {
  phrase: string;
  regex: RegExp;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compilePhrases(phrases: string[]): CompiledPhrase[] {
  return phrases.map((phrase) => ({
    phrase,
    regex: new RegExp(`(?<!\\w)${escapeRegExp(phrase)}(?!\\w)`, 'i'),
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
