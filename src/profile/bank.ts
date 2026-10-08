export const MAX_BANK_TOKENS = 600;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

const HEADERS = ['TRADE:', 'SETTLES ON:', 'MOVES THE PRICE:', 'SETTLEMENT-SENSITIVE FACTS:', 'IGNORE:'] as const;

interface Section {
  header: string;
  lines: string[];
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const header = HEADERS.find((h) => line.startsWith(h));
    if (header) {
      current = { header, lines: [line.slice(header.length).trim()] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

function countItems(section: Section): number {
  const bullets = section.lines.filter((l) => /^\s*-\s+\S/.test(l)).length;
  if (bullets > 0) return bullets;
  return section.lines
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/**
 * Deterministic gate on a generated knowledge bank. The bank is NOT reviewed by a
 * human before use (operator decision), so this is the only check between a model's
 * output and every item the gate will ever screen: wrong shape fails the build.
 */
export function validateBank(text: string): void {
  const tokens = estimateTokens(text);
  if (tokens > MAX_BANK_TOKENS) {
    throw new Error(`bank is about ${tokens} tokens, over the ${MAX_BANK_TOKENS} limit`);
  }
  const sections = splitSections(text);
  const order = sections.map((s) => s.header);
  if (order.join('|') !== HEADERS.join('|')) {
    throw new Error(
      `bank must contain exactly these headers in order: ${HEADERS.join(' ')}; found: ${order.join(' ') || 'none'}`
    );
  }
  const firstHeader = Math.min(
    ...HEADERS.map((h) => text.search(new RegExp(`^${h}`, 'm'))).filter((i) => i >= 0),
    text.length
  );
  if (text.slice(0, firstHeader).trim().length > 0) {
    throw new Error('bank has text before the first header; only the five headed sections are allowed');
  }
  const by = (h: string): Section => sections.find((s) => s.header === h)!;
  for (const h of ['TRADE:', 'SETTLES ON:']) {
    if (by(h).lines.join('').trim().length === 0) {
      throw new Error(`bank section ${h} is empty`);
    }
  }
  for (const h of ['MOVES THE PRICE:', 'SETTLEMENT-SENSITIVE FACTS:', 'IGNORE:']) {
    const n = countItems(by(h));
    if (n < 3) {
      throw new Error(`bank section ${h} has ${n} item(s), needs at least 3`);
    }
  }
}
