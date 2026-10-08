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
// Invisible characters removed outright (they can hide inside a tag name), and line/paragraph
// separators that become a space.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const LINE_SEPARATORS = /[\u2028\u2029]/g;
// Every C0 control character except newline (0x0A), plus DEL and the C1 block (incl. U+0085).
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const ANY_ARTICLE_TAG = /<\s*\/?\s*article\b/i;

/** Normalise FIRST so no encoding trick can survive into tag removal. */
function normalise(text: string): string {
  return text.replace(INVISIBLE_CHARS, '').replace(LINE_SEPARATORS, ' ').replace(CONTROL_CHARS, ' ');
}

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
  const requested = Number.isNaN(maxChars) ? 0 : Math.floor(maxChars);
  const cap = Math.min(Math.max(0, requested), MAX_SOURCE_CHARS);
  let cleaned = removeArticleTags(normalise(text)).trim();
  // Belt and braces: if anything tag-like survived, defuse every `<` (same length).
  if (ANY_ARTICLE_TAG.test(cleaned)) cleaned = cleaned.replace(/</g, '\u2039');

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
    regex: new RegExp(
      [
        String.raw`\b(?:ignore|disregard|forget|override)\b[^.]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your)\b[^.]{0,25}?\b(?:instructions?|directions?|directives?)\b`,
        String.raw`\b(?:ignore|disregard|forget)\s+(?:everything|anything|all)\s+(?:above|before|previous|prior)\b`,
        String.raw`\b(?:ignore|disregard|forget)\s+(?:what|everything)\s+you\s+(?:were|are|have\s+been)\s+told\b`,
        String.raw`\b(?:do\s+not|don't|never)\s+follow\s+(?:your|the\s+previous|the\s+above|previous|prior)\s+(?:instructions?|directions?)\b`,
        String.raw`\bforget\s+everything\b(?:\s+\S+){0,4}?\s+(?:above|before|previous|you\s+were\s+told|instructions?)\b`,
      ].join('|'),
      'i',
    ),
  },
  {
    name: 'system-notice',
    regex: /\bsystem\s+(?:notice|prompt|message|override|instructions?)\b|<\/?system>|\[\/?system\]|#{2,}\s*system\b/i,
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
  // Remove invisible characters and collapse all whitespace (incl. newlines) so split phrases match.
  const flat = text.replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ');
  return INJECTION_PATTERNS.filter((p) => p.regex.test(flat)).map((p) => p.name);
}
