// src/fetch/excerpt.ts
//
// Fetches a small, capped excerpt of a news article for the relevance gate and the
// Sonnet stages. Every failure returns null; the caller falls back to the iip snippet.
//
// Known limit: after our DNS check, `fetch` resolves the hostname again, so a
// DNS-rebinding host could answer differently between the check and the request. That is
// accepted for a read-only GET of feed-supplied URLs: the per-hop re-check, the manual
// redirect handling and the body/time caps still bound the damage.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface Article {
  title: string;
  description: string;
  text: string;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 256 * 1024;
const MIN_PARAGRAPH_CHARS = 40;
// The output budget never exceeds 2,000 characters, so the parser never needs more input
// than this. Bounding the input FIRST is what keeps every regex below linear: a
// synchronous regex cannot be interrupted by AbortSignal.
const MAX_OUTPUT_CHARS = 2000;
const MAX_HTML_CHARS = 64 * 1024;
const MAX_FIELD_RAW_CHARS = 2048;
const TAG_BODY = '[^<>]{0,2000}'; // a '<' inside a tag body is not a tag body
const USER_AGENT = 'executor-module/1.0 (news excerpt fetch)';
const BOILERPLATE_TAGS = ['script', 'style', 'noscript', 'svg', 'template', 'nav', 'header', 'footer', 'aside', 'form', 'iframe'];

// ---------------------------------------------------------------- address checks

export function isPublicAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPublicAddress(mapped[1]);

  const version = isIP(addr);
  if (version === 4) {
    const [a, b, c] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false; // "this" network, private, loopback
    if (a === 169 && b === 254) return false; // link-local, incl. the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT, which includes Tailscale
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18.0.0/15
    if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (version === 6) {
    const parts = addr.split(':');
    const first = parts[0] === '' ? 0 : parseInt(parts[0], 16);
    const second = parts[1] === undefined || parts[1] === '' ? 0 : parseInt(parts[1], 16);
    if (first === 0) return false; // ::, ::1 and the rest of ::/16
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfec0) return false; // fec0::/10 deprecated site-local
    if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    if (first === 0x2001 && second === 0x0db8) return false; // documentation 2001:db8::/32
    if (first === 0x2002) return false; // 6to4 2002::/16 (embeds an arbitrary IPv4)
    if (first === 0x0064 && second === 0xff9b) return false; // NAT64 64:ff9b::/32 (covers /96)
    return true;
  }
  return false;
}

async function defaultLookup(host: string): Promise<string[]> {
  const results = await dnsLookup(host, { all: true });
  return results.map((r) => r.address);
}

/**
 * Settles with `p`, or rejects as soon as `signal` aborts. The abort listener is always
 * removed, so nothing leaks. Used for DNS, fetch and every body read, none of which can be
 * trusted to honour the signal themselves.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

async function hostIsPublic(
  hostname: string,
  lookupImpl: (host: string) => Promise<string[]>,
  signal: AbortSignal
): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return isPublicAddress(host);
  const addresses = await raceAbort(Promise.resolve().then(() => lookupImpl(host)), signal);
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null; // never send or honour embedded credentials
    return url;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- fetching

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!res.body) return (await raceAbort(res.text(), signal)).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done || !value) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    // Not awaited: cancel() can itself wait on a stalled source.
    reader.cancel().catch(() => undefined);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

export async function fetchArticle(
  url: string | null,
  opts: {
    maxChars: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    lookupImpl?: (host: string) => Promise<string[]>;
  }
): Promise<Article | null> {
  if (!url) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookupImpl = opts.lookupImpl ?? defaultLookup;
  // One signal covers every hop, every DNS lookup and the body read, so the TOTAL time is bounded.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = parseHttpUrl(current);
      if (parsed === null) return null;
      if (!(await hostIsPublic(parsed.hostname, lookupImpl, signal))) return null;

      const res = await raceAbort(
        Promise.resolve().then(() =>
          fetchImpl(parsed.toString(), {
            redirect: 'manual',
            signal,
            headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
          })
        ),
        signal
      );

      if (res.status >= 300 && res.status < 400) {
        try {
          await raceAbort(Promise.resolve(res.body?.cancel()), signal);
        } catch {
          // a redirect body we cannot cancel is not worth failing over, but do not wait on it
        }
        const location = res.headers.get('location');
        if (!location) return null;
        current = new URL(location, parsed).toString();
        continue;
      }
      if (res.status !== 200) return null;
      const contentType = res.headers.get('content-type') ?? '';
      if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return null;

      const html = await readCapped(res, MAX_BODY_BYTES, signal);
      return extractArticle(html, opts.maxChars);
    }
    return null; // more than MAX_REDIRECTS redirects
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ extraction

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,10});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const codePoint = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || isSurrogate) return '';
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Callers only pass input that is already length-bounded.
const TAG_RE = new RegExp(`<${TAG_BODY}>`, 'g');
const TAIL_RE = new RegExp(`<${TAG_BODY}$`);

function stripTags(html: string): string {
  return html.replace(TAG_RE, ' ').replace(TAIL_RE, ' ');
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readMeta(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const tag of html.match(new RegExp(`<meta\\b${TAG_BODY}>`, 'gi')) ?? []) {
    const attrs = new Map<string, string>();
    // Runs only over one tag of at most ~2,000 characters.
    const attrRe = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag)) !== null) {
      attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) {
      meta.set(key, cleanText(decodeEntities(clip(content, MAX_FIELD_RAW_CHARS))));
    }
  }
  return meta;
}

function clip(text: string, length: number): string {
  if (text.length <= length) return text;
  let head = text.slice(0, length);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head;
}

/** NaN, negative and non-numeric budgets fail closed to 0; anything above 2,000 is clamped. */
function normaliseCap(maxChars: number): number {
  if (typeof maxChars !== 'number' || Number.isNaN(maxChars)) return 0;
  return Math.min(MAX_OUTPUT_CHARS, Math.max(0, Math.floor(maxChars)));
}

/** Spends the character budget on title first, then description, then text. */
function fit(title: string, description: string, text: string, maxChars: number): Article {
  const cap = normaliseCap(maxChars);
  const fittedTitle = clip(title, cap);
  const fittedDescription = clip(description, cap - fittedTitle.length);
  const fittedText = clip(text, cap - fittedTitle.length - fittedDescription.length);
  return {
    title: fittedTitle,
    description: fittedDescription,
    text: fittedText,
    truncated:
      fittedTitle.length < title.length ||
      fittedDescription.length < description.length ||
      fittedText.length < text.length,
  };
}

/** Removes <!-- ... --> with indexOf only; an unclosed comment drops to the end. Linear. */
function stripComments(html: string): string {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const open = html.indexOf('<!--', pos);
    if (open === -1) {
      out.push(html.slice(pos));
      break;
    }
    out.push(html.slice(pos, open), ' ');
    const close = html.indexOf('-->', open + 4);
    if (close === -1) break;
    pos = close + 3;
  }
  return out.join('');
}

/**
 * Removes every <tag ...> ... </tag> element, dropping to the end of the (already bounded)
 * input when a closer is missing. Each regex scan only moves forward, so the total work is
 * linear in the input.
 */
function removeElements(html: string, tag: string): string {
  const openRe = new RegExp(`<${tag}\\b${TAG_BODY}>`, 'gi');
  const closeRe = new RegExp(`<\\/${tag}\\b`, 'gi');
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos;
    const open = openRe.exec(html);
    if (open === null) {
      out.push(html.slice(pos));
      break;
    }
    out.push(html.slice(pos, open.index), ' ');
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(html);
    if (close === null) break; // unclosed: drop everything after it
    const gt = html.indexOf('>', close.index);
    if (gt === -1) break;
    pos = gt + 1;
  }
  return out.join('');
}

export function extractArticle(rawHtml: string, maxChars: number): Article {
  const cap = normaliseCap(maxChars);
  // Order matters. (1) Cut the input to the body cap so every pass below is linear in a
  // known size. (2) Strip comments and every script/style/boilerplate element FIRST, on that
  // full input: modern news pages put >64 KB of JSON/CSS in <head>, and clipping before
  // stripping would leave only code. (3) Only then clip the cleaned text to 64 KB (the 2,000
  // character output budget never needs more) before any title/meta/paragraph regex runs.
  // Trade-off, accepted: an UNCLOSED <script>/<style> swallows the rest of the document (as
  // browsers parse it too), so that page yields an empty or partial article.
  let cleaned = stripComments(clip(typeof rawHtml === 'string' ? rawHtml : '', MAX_BODY_BYTES));
  for (const tag of BOILERPLATE_TAGS) cleaned = removeElements(cleaned, tag);
  const html = clip(cleaned, MAX_HTML_CHARS);

  let title = '';
  const titleOpen = new RegExp(`<title\\b${TAG_BODY}>`, 'i').exec(html);
  if (titleOpen) {
    const from = titleOpen.index + titleOpen[0].length;
    const closeRe = /<\/title\b/gi;
    closeRe.lastIndex = from;
    const close = closeRe.exec(html);
    const raw = html.slice(from, close ? close.index : html.length);
    title = cleanText(decodeEntities(stripTags(clip(raw, MAX_FIELD_RAW_CHARS))));
  }

  const meta = readMeta(html);
  const description = clip(meta.get('og:description') ?? meta.get('description') ?? '', MAX_FIELD_RAW_CHARS);

  const body = html; // boilerplate was already removed above

  // One forward pass over paragraph open/close tokens: text between an opener and the next
  // token (a closer or another opener) is one paragraph, so unclosed <p> still reads.
  const paragraphs: string[] = [];
  const tokenRe = new RegExp(`<(\\/?)p\\b${TAG_BODY}>`, 'gi');
  let used = 0;
  let start = -1;
  const take = (end: number): boolean => {
    const paragraph = cleanText(decodeEntities(stripTags(body.slice(start, end))));
    if (paragraph.length >= MIN_PARAGRAPH_CHARS) {
      paragraphs.push(paragraph);
      used += paragraph.length + 1;
    }
    return used > cap; // already more than the budget can hold
  };
  let done = false;
  let m: RegExpExecArray | null;
  while (!done && (m = tokenRe.exec(body)) !== null) {
    if (start >= 0) done = take(m.index);
    start = m[1] ? -1 : m.index + m[0].length;
  }
  if (!done && start >= 0) take(body.length);

  return fit(title, description, paragraphs.join(' '), cap);
}

export function articleToText(a: Article): string {
  return [
    a.title && `Title: ${a.title}`,
    a.description && `Site description: ${a.description}`,
    a.text && `Excerpt: ${a.text}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

/** Fallback excerpt built from the iip headline and snippet when no page was fetched. */
export function snippetArticle(headline: string, snippet: string | null, maxChars: number): Article {
  return fit(headline, '', snippet ?? '', maxChars);
}
