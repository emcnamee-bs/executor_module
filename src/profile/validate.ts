import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { compilePhrases, getMatchableText } from '../keyphrases/match.js';
import type { Item } from '../item.js';

/**
 * Validates a trade's keyphrase list against real news.
 *
 * A generated list can contain one over-broad phrase that turns the whole bank into a scanner for the wrong
 * thing (the gold bank's "sanctions on Russia" produced 70% of its hits; the gasoline bank's list never fires on
 * "gasoline prices"). Nothing in build-trade checked a list against the stream it will run on. This replays a
 * list over the iip archive with the executor's own matcher, then asks the production relevance gate whether a
 * sample of each frequent phrase's hits is actually relevant, and recommends dropping phrases the gate rejects.
 */

export interface CorpusItem {
  id: string;
  source: string;
  trustTier: number | null;
  /** Exactly what the executor matches keyphrases against (getMatchableText). */
  text: string;
  ts: string;
}

export interface Corpus {
  items: CorpusItem[];
  /** Span of the archive in days (at least 1), the denominator for hits per day. */
  days: number;
}

export interface PhraseStat {
  phrase: string;
  hits: number;
  /** Fraction of all matched items this phrase matched (items can match several phrases). */
  share: number;
  perDay: number;
  bySource: Record<string, number>;
  itemIds: string[];
}

export interface MatchReport {
  totalItems: number;
  days: number;
  matchedItems: number;
  perPhrase: PhraseStat[];
}

/** Longest alphanumeric run of a phrase, lowercased: a cheap exact prefilter (a phrase cannot match without it). */
function needleOf(phrase: string): string {
  return (phrase.toLowerCase().match(/[a-z0-9]+/g) ?? []).sort((a, b) => b.length - a.length)[0] ?? '';
}

export function matchCorpus(phrases: string[], items: CorpusItem[], days: number, directSources: string[] = []): MatchReport {
  const compiled = compilePhrases(phrases);
  const needles = phrases.map(needleOf);
  const direct = new Set(directSources);
  const stats = new Map<string, PhraseStat>();
  let matchedItems = 0;
  let considered = 0;
  for (const it of items) {
    if (direct.has(it.source)) continue; // direct sources bypass keyphrases, so they say nothing about the list
    considered++;
    const low = it.text.toLowerCase();
    let any = false;
    for (let i = 0; i < compiled.length; i++) {
      if (!low.includes(needles[i]) || !compiled[i].regex.test(it.text)) continue;
      any = true;
      const phrase = compiled[i].phrase;
      let s = stats.get(phrase);
      if (!s) stats.set(phrase, (s = { phrase, hits: 0, share: 0, perDay: 0, bySource: {}, itemIds: [] }));
      s.hits++;
      s.bySource[it.source] = (s.bySource[it.source] ?? 0) + 1;
      s.itemIds.push(it.id);
    }
    if (any) matchedItems++;
  }
  const perPhrase = [...stats.values()].sort((a, b) => b.hits - a.hits || a.phrase.localeCompare(b.phrase));
  for (const s of perPhrase) {
    s.share = matchedItems > 0 ? s.hits / matchedItems : 0;
    s.perDay = s.hits / Math.max(1, days);
  }
  return { totalItems: considered, days, matchedItems, perPhrase };
}

export function selectCandidates(report: MatchReport, opts: { minHits: number; maxCandidates: number }): PhraseStat[] {
  return report.perPhrase.filter((p) => p.hits >= opts.minHits).slice(0, opts.maxCandidates);
}

const h = (s: string): string => createHash('sha1').update(s).digest('hex');

/** Deterministic sample of a phrase's hits, spread round-robin across sources so a dominant source cannot crowd out the rest. */
export function pickSample(stat: PhraseStat, byId: Map<string, CorpusItem>, n: number): CorpusItem[] {
  const bySource = new Map<string, CorpusItem[]>();
  for (const id of stat.itemIds) {
    const it = byId.get(id);
    if (!it) continue;
    (bySource.get(it.source) ?? bySource.set(it.source, []).get(it.source)!).push(it);
  }
  const queues = [...bySource.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, list]) => list.sort((a, b) => h(stat.phrase + '|' + a.id).localeCompare(h(stat.phrase + '|' + b.id))));
  const out: CorpusItem[] = [];
  for (let round = 0; out.length < n; round++) {
    let progressed = false;
    for (const q of queues) {
      if (round < q.length && out.length < n) {
        out.push(q[round]);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

export interface JudgeOptions {
  sampleSize: number;
  concurrency: number;
  maxCalls: number;
}

export interface JudgeResult {
  verdicts: Map<string, boolean[]>;
  callsMade: number;
  errors: number;
  budgetExhausted: boolean;
}

/**
 * Judges a sample of each candidate phrase's hits with `judge` (the production gate in real use). An item sampled by
 * several phrases is judged once. Stops at the call budget, leaving later phrases unjudged (never half-judged).
 * A judge error is skipped: it is neither a pass nor a fail.
 */
export async function judgeCandidates(
  candidates: PhraseStat[],
  byId: Map<string, CorpusItem>,
  judge: (item: CorpusItem) => Promise<boolean>,
  opts: JudgeOptions
): Promise<JudgeResult> {
  const cache = new Map<string, boolean | 'error'>();
  const verdicts = new Map<string, boolean[]>();
  let callsMade = 0;
  let errors = 0;
  let budgetExhausted = false;
  for (const stat of candidates) {
    const sample = pickSample(stat, byId, opts.sampleSize);
    const todo = sample.filter((it) => !cache.has(it.id));
    if (callsMade + todo.length > opts.maxCalls) {
      budgetExhausted = true;
      break;
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const it = todo[next++];
        callsMade++;
        try {
          cache.set(it.id, await judge(it));
        } catch {
          cache.set(it.id, 'error');
          errors++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, todo.length)) }, worker));
    verdicts.set(stat.phrase, sample.map((it) => cache.get(it.id)).filter((v): v is boolean => v !== 'error' && v !== undefined));
  }
  return { verdicts, callsMade, errors, budgetExhausted };
}

export interface PhraseVerdict {
  phrase: string;
  hits: number;
  judged: number;
  passed: number;
  passRate: number;
  action: 'keep' | 'remove';
  reason: string;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'will', 'that', 'this', 'from', 'are', 'was', 'its', 'any', 'all', 'not', 'but', 'has', 'have', 'than', 'who']);
// Crude plural folding is enough here: exports and export, prices and price.
const fold = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const contentWords = (text: string): string[] => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)).map(fold);

/**
 * Builds the 'core phrase' test for a trade: a phrase whose every content word appears in the trade's own title or settlement
 * text is the trade's subject (diesel export ban for a diesel-export-ban trade). Such a phrase is never auto-removed, because
 * a sample of low-quality hits is not a reason to cut the trade off from its own topic; it is flagged for a human to review.
 */
export function makeCoreMatcher(texts: string[]): (phrase: string) => boolean {
  const own = new Set(texts.flatMap(contentWords));
  return (phrase) => {
    const words = contentWords(phrase);
    return words.length > 0 && words.every((w) => own.has(w));
  };
}

export function decideRemovals(
  stats: PhraseStat[],
  verdicts: Map<string, boolean[]>,
  opts: { minJudged: number; maxPassRate: number; protect?: (phrase: string) => boolean }
): PhraseVerdict[] {
  return stats.map((s) => {
    const v = verdicts.get(s.phrase);
    if (!v) return { phrase: s.phrase, hits: s.hits, judged: 0, passed: 0, passRate: 0, action: 'keep', reason: 'not judged (call budget exhausted)' };
    const passed = v.filter(Boolean).length;
    const passRate = v.length > 0 ? passed / v.length : 0;
    const base = { phrase: s.phrase, hits: s.hits, judged: v.length, passed, passRate };
    if (v.length < opts.minJudged) return { ...base, action: 'keep' as const, reason: `only ${v.length} judged (need ${opts.minJudged})` };
    if (passRate < opts.maxPassRate && opts.protect?.(s.phrase)) {
      return { ...base, action: 'keep' as const, reason: `protected phrase (core to the trade, or kept by request), kept although the audit judge passed only ${passed}/${v.length} sampled hits: review by hand` };
    }
    if (passRate < opts.maxPassRate) {
      return { ...base, action: 'remove' as const, reason: `audit judge passed ${passed}/${v.length} sampled hits (< ${Math.round(opts.maxPassRate * 100)}%)` };
    }
    return { ...base, action: 'keep' as const, reason: `audit judge passed ${passed}/${v.length}` };
  });
}

export interface ApplyResult {
  kept: string[];
  removed: string[];
  /** Phrases recommended for removal but kept because dropping them would take the list under the floor. */
  blocked: string[];
}

/** Applies removals without ever taking the list below `floor` phrases: the worst-judged phrases go first. */
export function applyRemovals(phrases: string[], verdicts: PhraseVerdict[], floor: number): ApplyResult {
  const inList = new Set(phrases);
  const wanted = verdicts
    .filter((v) => v.action === 'remove' && inList.has(v.phrase))
    .sort((a, b) => a.passRate - b.passRate || b.hits - a.hits);
  const allowed = Math.max(0, phrases.length - floor);
  const removed = wanted.slice(0, allowed).map((v) => v.phrase);
  const blocked = wanted.slice(allowed).map((v) => v.phrase);
  const drop = new Set(removed);
  return { kept: phrases.filter((p) => !drop.has(p)), removed, blocked };
}

/**
 * Reads the iip archive READ-ONLY (it is a live daemon's only copy of its data; never write to it). Quarantined items
 * are dropped: iip withholds them from the stream the executors consume, so they say nothing about live hit rates.
 */
export function loadCorpusFromIipDb(dbPath: string, opts: { sinceDays?: number } = {}): Corpus {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare('SELECT item_id, source_id, first_seen_ts, payload FROM items WHERE quarantined = 0 ORDER BY first_seen_ts')
      .all() as Array<{ item_id: string; source_id: string; first_seen_ts: string; payload: string }>;
    let items: CorpusItem[] = [];
    for (const r of rows) {
      let p: any;
      try {
        p = JSON.parse(r.payload);
      } catch {
        continue;
      }
      const text = getMatchableText({ provenance_gaps: p.provenance_gaps ?? [], headline: p.headline ?? null, snippet: p.snippet ?? null } as unknown as Item);
      if (!text.trim()) continue;
      items.push({ id: r.item_id, source: r.source_id, trustTier: p.trust_tier ?? null, text, ts: r.first_seen_ts });
    }
    if (opts.sinceDays !== undefined && items.length > 0) {
      const latest = Date.parse(items[items.length - 1].ts);
      const cutoff = latest - opts.sinceDays * 86_400_000;
      items = items.filter((i) => Date.parse(i.ts) >= cutoff);
    }
    const first = items.length > 0 ? Date.parse(items[0].ts) : 0;
    const last = items.length > 0 ? Date.parse(items[items.length - 1].ts) : 0;
    return { items, days: Math.max(1, Math.ceil((last - first) / 86_400_000)) };
  } finally {
    db.close();
  }
}
