// test/fetch/excerpt.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  fetchArticle,
  extractArticle,
  articleToText,
  snippetArticle,
  isPublicAddress,
} from '../../src/fetch/excerpt.js';

const ARTICLE_HTML = `<!doctype html><html><head>
<title>Low water on the Mississippi limits barge traffic &amp; shipping</title>
<meta property="og:description" content="Drought-lowered river levels are forcing tow restrictions.">
<meta name="description" content="A plain meta description that should lose to og:description.">
<style>.x{color:red}</style><script>var tracking = "do not include me";</script></head>
<body>
<nav><p>Home | World | Politics | Sports navigation links should be dropped entirely</p></nav>
<header><p>Site header paragraph that is long enough to pass the minimum length filter</p></header>
<article>
<p>The Coast Guard on Tuesday restricted tow sizes between Memphis and Vicksburg as the river fell to its lowest autumn level in four years.</p>
<p>Operators said it&#8217;s likely to delay petroleum-product barges headed north.</p>
<p>Short.</p>
</article>
<footer><p>Copyright footer paragraph that is also long enough to pass the minimum length filter</p></footer>
</body></html>`;

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

const HOSTS: Record<string, string[]> = {
  'news.example.com': ['93.184.216.34'],
  'other.example.com': ['93.184.216.35'],
  'evil.example.com': ['10.0.0.5'],
  'mixed.example.com': ['93.184.216.34', '192.168.1.9'],
};
const lookupImpl = async (host: string): Promise<string[]> => HOSTS[host] ?? [];

describe('extractArticle', () => {
  it('extracts title, og:description and the first readable paragraphs, dropping boilerplate', () => {
    const a = extractArticle(ARTICLE_HTML, 2000);
    expect(a.title).toBe('Low water on the Mississippi limits barge traffic & shipping');
    expect(a.description).toBe('Drought-lowered river levels are forcing tow restrictions.');
    expect(a.text).toContain('The Coast Guard on Tuesday restricted tow sizes');
    expect(a.text).toContain('it’s likely to delay petroleum-product barges');
    for (const dropped of ['navigation', 'tracking', 'Copyright', 'Site header', 'Short.', 'color:red']) {
      expect(a.text + a.title + a.description).not.toContain(dropped);
    }
    expect(a.truncated).toBe(false);
  });

  it('falls back to <meta name="description"> when there is no og:description', () => {
    const html = '<html><head><title>T</title><meta content="Plain description" name="description"></head><body></body></html>';
    expect(extractArticle(html, 500).description).toBe('Plain description');
  });

  it('never exceeds the cap and marks truncation; the three parts sum to exactly the cap when content is longer', () => {
    const a = extractArticle(ARTICLE_HTML, 120);
    expect(a.title.length + a.description.length + a.text.length).toBe(120);
    expect(a.truncated).toBe(true);
  });

  it('gives the whole budget to the title first, then description, then text', () => {
    const a = extractArticle(ARTICLE_HTML, 10);
    expect(a.title.length).toBe(10);
    expect(a.description).toBe('');
    expect(a.text).toBe('');
  });

  it('decodes named, decimal and hex entities', () => {
    const html =
      '<html><head><title>A &amp; B &lt;ok&gt; &quot;q&quot; &#39;s&#39;</title></head><body>' +
      '<p>It&#8217;s &#x2019;fine&nbsp;here, said the minister &mdash; and the long paragraph continues on.</p></body></html>';
    const a = extractArticle(html, 1000);
    expect(a.title).toBe('A & B <ok> "q" \'s\'');
    expect(a.text).toContain('It’s ’fine here, said the minister — and');
  });

  it('keeps an unknown entity as written and ignores an invalid numeric one', () => {
    const a = extractArticle('<html><head><title>X &bogus; Y &#1114112; Z</title></head></html>', 100);
    expect(a.title).toBe('X &bogus; Y Z');
  });

  it('does not throw on malformed HTML and still reads unclosed paragraphs', () => {
    const html =
      '<html><title>Broken<body><p>First unclosed paragraph that is definitely longer than forty characters <b>bold ' +
      '<p>Second paragraph also long enough to pass the filter okay <div><<<';
    expect(() => extractArticle(html, 500)).not.toThrow();
    const a = extractArticle(html, 500);
    expect(a.text).toContain('First unclosed paragraph');
    expect(a.text).toContain('Second paragraph also long enough');
  });

  it('drops everything after an unclosed <script>', () => {
    const html = '<html><body><script>var x = 1; <p>hidden paragraph long enough to pass the minimum length filter</p>';
    expect(extractArticle(html, 500).text).toBe('');
  });

  it('returns empty parts for empty input', () => {
    expect(extractArticle('', 100)).toEqual({ title: '', description: '', text: '', truncated: false });
  });

  it('does not leave a lone surrogate when the cap falls inside an emoji', () => {
    const html = `<html><head><title>${'😀'.repeat(50)}</title></head></html>`;
    const a = extractArticle(html, 51);
    expect(a.title.length).toBeLessThanOrEqual(51);
    expect(a.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('articleToText / snippetArticle', () => {
  it('renders labelled parts and omits empty ones', () => {
    expect(articleToText({ title: 'T', description: 'D', text: 'X', truncated: false })).toBe(
      'Title: T\nSite description: D\nExcerpt: X'
    );
    expect(articleToText({ title: 'T', description: '', text: 'X', truncated: false })).toBe('Title: T\nExcerpt: X');
    expect(articleToText({ title: '', description: '', text: '', truncated: false })).toBe('');
  });

  it('builds a fallback article from an iip headline and snippet, capped', () => {
    const a = snippetArticle('Headline here', 'Snippet text goes on and on', 20);
    expect(a.title).toBe('Headline here');
    expect(a.title.length + a.description.length + a.text.length).toBe(20);
    expect(a.truncated).toBe(true);
    expect(snippetArticle('H', null, 100)).toEqual({ title: 'H', description: '', text: '', truncated: false });
  });
});

describe('isPublicAddress', () => {
  it.each([
    ['93.184.216.34', true],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['127.255.0.9', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['172.32.0.1', true],
    ['192.168.0.1', false],
    ['169.254.169.254', false],
    ['0.0.0.0', false],
    ['100.64.0.1', false],
    ['100.127.255.255', false],
    ['100.128.0.1', true],
    ['224.0.0.1', false],
    ['::', false],
    ['::1', false],
    ['fc00::1', false],
    ['fd12:3456::1', false],
    ['fe80::1', false],
    ['febf::1', false],
    ['ff02::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:93.184.216.34', true],
    ['not-an-ip', false],
    ['', false],
  ])('%s -> %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('fetchArticle', () => {
  it('returns an Article for a public host and fetches with manual redirects and a signal', async () => {
    const fetchImpl = vi.fn(async (_u: any, _i?: any) => htmlResponse(ARTICLE_HTML));
    const a = await fetchArticle('https://news.example.com/story', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl });
    expect(a?.title).toContain('Low water on the Mississippi');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1];
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns null for a null url without fetching', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchArticle(null, { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/passwd', 'ftp://news.example.com/x', 'javascript:alert(1)', 'data:text/html,<p>x</p>', 'not a url'])(
    'rejects the scheme/URL %s without fetching',
    async (url) => {
      const fetchImpl = vi.fn();
      expect(await fetchArticle(url, { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it('rejects a host that resolves to a private address, and a host with ANY private address, without fetching', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchArticle('http://evil.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(await fetchArticle('http://mixed.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(await fetchArticle('http://unknown.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.1:8080/x',
    'http://[::1]/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://100.64.1.1/',
  ])('rejects the IP-literal URL %s without fetching or resolving', async (url) => {
    const fetchImpl = vi.fn();
    const lookup = vi.fn();
    expect(await fetchArticle(url, { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl: lookup as any })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a redirect hop to a private address (re-checked on every hop)', async () => {
    const fetchImpl = vi.fn(async (u: any) => {
      if (String(u).startsWith('https://news.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      }
      return htmlResponse(ARTICLE_HTML);
    });
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to a hostname that resolves privately', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'http://evil.example.com/x' } }));
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a relative redirect to another public host', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (u: any) => {
      urls.push(String(u));
      return urls.length === 1
        ? new Response(null, { status: 302, headers: { location: '/final' } })
        : htmlResponse(ARTICLE_HTML);
    });
    const a = await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl });
    expect(a).not.toBeNull();
    expect(urls).toEqual(['https://news.example.com/a', 'https://news.example.com/final']);
  });

  it('gives up after 3 redirects (4 requests in total)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://other.example.com/next' } }));
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('returns null for a redirect with no Location header', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
  });

  it('stops reading an unbounded body at about 256 KB', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('<p>' + 'a'.repeat(64 * 1024 - 3));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk); // never closes: an infinite response
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }));
    const a = await fetchArticle('https://news.example.com/big', { maxChars: 500, fetchImpl: fetchImpl as any, lookupImpl });
    expect(a).not.toBeNull();
    expect(pulled).toBeLessThanOrEqual(512 * 1024);
  });

  it.each([
    ['non-HTML content type', () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['text/plain', () => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } })],
    ['404', () => htmlResponse('<p>nope</p>', { status: 404 })],
    ['500', () => htmlResponse('<p>nope</p>', { status: 500 })],
  ])('returns null for %s', async (_name, make) => {
    const fetchImpl = vi.fn(async () => make());
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
  });

  it('returns null when the request times out', async () => {
    const fetchImpl = vi.fn(
      (_u: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const started = Date.now();
    const a = await fetchArticle('https://news.example.com/slow', { maxChars: 800, timeoutMs: 50, fetchImpl: fetchImpl as any, lookupImpl });
    expect(a).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns null when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
  });

  it('returns null when the DNS lookup throws', async () => {
    const fetchImpl = vi.fn();
    const lookup = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl: lookup })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('applies the cap end to end', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse(ARTICLE_HTML));
    const a = await fetchArticle('https://news.example.com/a', { maxChars: 120, fetchImpl: fetchImpl as any, lookupImpl });
    expect(a!.title.length + a!.description.length + a!.text.length).toBeLessThanOrEqual(120);
    expect(a!.truncated).toBe(true);
  });
});

// ------------------------------------------------------------- fix round 1 regressions

describe('extractArticle is linear on adversarial bodies (sync regex cannot be aborted)', () => {
  const CAP = 256 * 1024;
  const bodies: Array<[string, string]> = [
    ['<title> + many "<"', '<title>' + '<'.repeat(250000)],
    ['many "<p "', '<p '.repeat(80000)],
    ['many "<meta "', '<meta '.repeat(40000)],
    ['many "<!--"', '<!--'.repeat(60000)],
    ['many "<script>"', '<script>'.repeat(30000)],
    ['many "<nav>"', '<nav>'.repeat(50000)],
    ['many "<svg>"', '<svg>'.repeat(50000)],
    ['many "<p>"', '<p>'.repeat(80000)],
  ];
  it.each(bodies)('%s finishes in under 250 ms', (_name, body) => {
    const html = body.slice(0, CAP);
    const started = Date.now();
    extractArticle(html, 800);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('does not extract a <title> or meta that sits inside an HTML comment', () => {
    const html = '<html><head><!-- <title>Hidden</title><meta name="description" content="Hidden desc"> --><title>Real</title></head></html>';
    const a = extractArticle(html, 500);
    expect(a.title).toBe('Real');
    expect(a.description).toBe('');
  });

  it('caps a huge title before processing it', () => {
    const a = extractArticle('<title>' + 'x'.repeat(100000) + '</title>', 2000);
    expect(a.title.length).toBeLessThanOrEqual(2000);
  });
});

describe('maxChars fails closed', () => {
  it.each([NaN, -5, -Infinity, 0])('%s gives an empty valid article', (cap) => {
    const a = extractArticle(ARTICLE_HTML, cap);
    expect(a.title + a.description + a.text).toBe('');
    expect(snippetArticle('Headline', 'snippet', cap).title).toBe('');
  });
  it('clamps Infinity and huge values to 2000', () => {
    const big = `<title>${'t'.repeat(1500)}</title><p>${'p'.repeat(5000)}</p>`;
    for (const cap of [Infinity, 1e9]) {
      const a = extractArticle(big, cap);
      expect(a.title.length + a.description.length + a.text.length).toBeLessThanOrEqual(2000);
    }
    const s = snippetArticle('h'.repeat(3000), null, Infinity);
    expect(s.title.length).toBe(2000);
  });
});

describe('isPublicAddress extra reserved ranges', () => {
  it.each([
    '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9',
    'fec0::1', 'febf::1', '2001:db8::1', '2002:5db8:d822::1', '64:ff9b::808:808',
  ])('%s is blocked', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it.each(['192.0.1.1', '198.20.0.1', '198.51.101.1', '203.0.114.1', '2001:db9::1', '2003::1'])('%s stays public', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe('fetchArticle hardening', () => {
  it('rejects URLs with credentials without fetching', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchArticle('https://user:pw@news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(await fetchArticle('https://user@news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null promptly when the DNS lookup never resolves', async () => {
    const fetchImpl = vi.fn();
    const hang = () => new Promise<string[]>(() => undefined);
    const started = Date.now();
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, timeoutMs: 50, fetchImpl: fetchImpl as any, lookupImpl: hang })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null promptly when a body emits one chunk then stalls', async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(new TextEncoder().encode('<p>start'));
          return;
        }
        return new Promise(() => undefined); // never yields again
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }));
    const started = Date.now();
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, timeoutMs: 80, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns null when a body drips one byte at a time past the timeout', async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        timer = setInterval(() => c.enqueue(new TextEncoder().encode('a')), 5);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } }));
    const started = Date.now();
    expect(await fetchArticle('https://news.example.com/a', { maxChars: 800, timeoutMs: 80, fetchImpl: fetchImpl as any, lookupImpl })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    clearInterval(timer);
  });

  it('cancels the body of a redirect response before following it', async () => {
    let cancelled = false;
    const mkRedirect = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise(() => undefined);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: '/final' } }
      );
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? mkRedirect() : htmlResponse(ARTICLE_HTML)));
    const a = await fetchArticle('https://news.example.com/a', { maxChars: 800, fetchImpl: fetchImpl as any, lookupImpl });
    expect(a).not.toBeNull();
    expect(cancelled).toBe(true);
  });
});
