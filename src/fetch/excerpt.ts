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
const USER_AGENT = 'executor-module/1.0 (news excerpt fetch)';
const BOILERPLATE_TAGS = ['script', 'style', 'noscript', 'svg', 'template', 'nav', 'header', 'footer', 'aside', 'form', 'iframe'];

// ---------------------------------------------------------------- address checks

export function isPublicAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPublicAddress(mapped[1]);

  const version = isIP(addr);
  if (version === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false; // "this" network, private, loopback
    if (a === 169 && b === 254) return false; // link-local, incl. the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT, which includes Tailscale
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (version === 6) {
    const head = addr.split(':')[0];
    const first = head === '' ? 0 : parseInt(head, 16);
    if (first === 0) return false; // ::, ::1 and the rest of ::/16
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    return true;
  }
  return false;
}

async function defaultLookup(host: string): Promise<string[]> {
  const results = await dnsLookup(host, { all: true });
  return results.map((r) => r.address);
}

async function hostIsPublic(hostname: string, lookupImpl: (host: string) => Promise<string[]>): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return isPublicAddress(host);
  const addresses = await lookupImpl(host);
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- fetching

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
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
  // One signal covers every hop and the body read, so the TOTAL time is bounded.
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const parsed = parseHttpUrl(current);
      if (parsed === null) return null;
      if (!(await hostIsPublic(parsed.hostname, lookupImpl))) return null;

      const res = await fetchImpl(parsed.toString(), {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return null;
        current = new URL(location, parsed).toString();
        continue;
      }
      if (res.status !== 200) return null;
      const contentType = res.headers.get('content-type') ?? '';
      if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return null;

      const html = await readCapped(res, MAX_BODY_BYTES);
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
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const codePoint = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const isSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
      if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || isSurrogate) return '';
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/<[^>]*$/, ' ');
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readMeta(html: string): Map<string, string> {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    const attrRe = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag)) !== null) {
      attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, cleanText(decodeEntities(content)));
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

/** Spends the character budget on title first, then description, then text. */
function fit(title: string, description: string, text: string, maxChars: number): Article {
  const cap = Math.max(0, Math.floor(maxChars));
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

export function extractArticle(html: string, maxChars: number): Article {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)(?:<\/title\s*>|$)/i.exec(html);
  const title = titleMatch ? cleanText(decodeEntities(stripTags(titleMatch[1]))) : '';

  const meta = readMeta(html);
  const description = meta.get('og:description') ?? meta.get('description') ?? '';

  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of BOILERPLATE_TAGS) {
    body = body.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  // An unclosed script/style swallows everything after it rather than leaking code as text.
  body = body.replace(/<(?:script|style|noscript)\b[\s\S]*$/i, ' ');

  const paragraphs: string[] = [];
  const paragraphRe = /<p\b[^>]*>([\s\S]*?)(?=<\/p\s*>|<p[\s>]|$)/gi;
  const cap = Math.max(0, Math.floor(maxChars));
  let m: RegExpExecArray | null;
  while ((m = paragraphRe.exec(body)) !== null) {
    const paragraph = cleanText(decodeEntities(stripTags(m[1])));
    if (paragraph.length >= MIN_PARAGRAPH_CHARS) paragraphs.push(paragraph);
    if (paragraphs.join(' ').length > cap) break; // already more than the budget can hold
  }

  return fit(title, description, paragraphs.join(' '), maxChars);
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
