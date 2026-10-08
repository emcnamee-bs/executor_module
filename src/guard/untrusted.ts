// src/guard/untrusted.ts
//
// The only door by which web text may enter a model prompt, plus a deterministic
// tripwire for text addressed to an AI reviewer. See the design spec, section 8.

/** Absolute ceiling on characters of input taken from one source into one request. */
export const MAX_SOURCE_CHARS = 2000;

const TRUNCATION_MARKER = '…[truncated]';

// `>?` is optional so an unterminated `</article` is also removed; `\b` keeps
// `<articles>` and `<article-list>`-style words from being eaten as the wrapper tag.
const ARTICLE_TAG = /<\s*\/?\s*article\b[^>]*>?/gi;
// Every C0 control character except newline (0x0A), plus DEL.
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

function removeArticleTags(text: string): string {
  // Replace with a space and repeat until stable so a split tag such as
  // `<arti<article>cle>` cannot re-form after one pass.
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(ARTICLE_TAG, ' ');
  } while (current !== previous);
  return current;
}

function cut(text: string, length: number): string {
  let head = text.slice(0, length);
  const last = head.charCodeAt(head.length - 1);
  // Never leave half of a surrogate pair at the cut.
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head;
}

/**
 * Wraps untrusted web text for a prompt. The text between the tags is guaranteed to
 * (a) contain no `<article>` / `</article>` tag, (b) contain no control characters other
 * than newline, and (c) be at most `min(maxChars, MAX_SOURCE_CHARS)` characters,
 * including the visible truncation marker when it was cut.
 */
export function wrapUntrusted(text: string, maxChars: number = MAX_SOURCE_CHARS): string {
  const cap = Math.min(Math.max(0, Math.floor(maxChars)), MAX_SOURCE_CHARS);
  const cleaned = removeArticleTags(text).replace(CONTROL_CHARS, ' ').trim();

  let body: string;
  if (cleaned.length <= cap) {
    body = cleaned;
  } else if (cap > TRUNCATION_MARKER.length) {
    body = cut(cleaned, cap - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  } else {
    body = cut(cleaned, cap);
  }
  return `<article>\n${body}\n</article>`;
}

interface InjectionPattern {
  name: string;
  regex: RegExp;
}

// Ordered; detectInjection returns names in this order. Each pattern targets text that
// is ADDRESSED TO a reviewing model, not text that merely contains a trigger word.
const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    name: 'ignore-instructions',
    regex: /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your)\b[^.\n]{0,25}?\binstructions?\b/i,
  },
  {
    name: 'system-notice',
    regex: /\bsystem\s+(?:notice|prompt|message|override|instructions?)\b/i,
  },
  {
    name: 'must-answer',
    regex: /\byou\s+(?:must|should|have\s+to|are\s+required\s+to)\s+(?:now\s+)?(?:answer|respond|reply|output|return|mark|classify|say)\b/i,
  },
  {
    name: 'addressed-to-reviewer',
    regex:
      /\b(?:note|message|instructions?|attention|notice)\s+(?:to|for)\s+(?:the\s+)?(?:reviewing\s+|screening\s+)?(?:system|model|reviewer|ai|llm|ai\s+assistant|language\s+model)\b|\breviewing\s+system\b/i,
  },
  {
    name: 'relevance-assignment',
    regex: /["']?\brelevant["']?\s*[:=]\s*["']?(?:true|false)\b/i,
  },
  {
    // A colon or dash is required: "new instructions from air traffic control" is news.
    name: 'new-instructions',
    regex: /\bnew\s+instructions?\s*[:\-–—]|\bfollow\s+(?:these|the|my)\s+(?:new\s+)?instructions\b/i,
  },
  {
    name: 'as-an-ai',
    regex: /\bas\s+an?\s+(?:ai|llm|language\s+model)\b/i,
  },
];

/** Names of the deterministic tripwire patterns that `text` matches, in fixed order. */
export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.name);
}
