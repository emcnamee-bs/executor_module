// src/perp/intake/prefilter.ts
//
// The code gate in front of the Haiku gate (spec sections 1-4). Pure rules over cheap features: source class, a weighted
// macro lexicon over headline and snippet, near-duplicate suppression, a per-strong-topic cooldown, and hourly caps.
// `prefilter` never mutates its state; the caller commits a pass with `recordPass` once it acts on the verdict.
import { readFileSync } from 'node:fs';
import { z } from 'zod';

export type SourceClass = 'official_macro' | 'market_wire' | 'press' | 'social' | 'unknown';
export type DropReason = 'source_class_drop' | 'low_score' | 'duplicate' | 'cooldown' | 'haiku_cap';

export interface Verdict {
  pass: boolean;
  reason: 'pass' | DropReason;
  sourceClass: SourceClass;
  score: number;
  hits: string[];
  strongHits: string[];
  dupOf?: string;
}

export type PrefilterItem = { item_id: string; source_id: string; headline: string; snippet: string | null };

export const PATTERN_WEIGHTS = { strong: 3, medium: 1, negative: -2 } as const;
const MIN_DEDUP_TOKENS = 4;
const HOUR_MS = 3_600_000;

const PatternSchema = z.object({ id: z.string().min(1), regex: z.string().min(1) }).strict();
const ConfigSchema = z
  .object({
    version: z.number().int(),
    threshold: z.number().int().min(1).max(10),
    marketWireThreshold: z.number().int().min(1).max(10),
    scoreCap: z.number().int().min(1).max(100),
    headlineWeight: z.number().int().min(1),
    snippetWeight: z.number().int().min(1),
    dedupWindowMs: z.number().int().min(60_000),
    dedupJaccard: z.number().min(0.1).max(1),
    cooldownMs: z.number().int().min(0),
    haikuPerHour: z.number().int().min(1),
    sonnetPerHour: z.number().int().min(1),
    sources: z.record(z.enum(['official_macro', 'market_wire', 'press', 'social'])),
    patterns: z.object({ strong: z.array(PatternSchema), medium: z.array(PatternSchema), negative: z.array(PatternSchema) }).strict(),
  })
  .strict();

export interface CompiledPattern { id: string; kind: 'strong' | 'medium' | 'negative'; weight: number; re: RegExp }
export type PrefilterConfig = z.infer<typeof ConfigSchema> & { compiled: CompiledPattern[] };

export interface PassedRecord { atMs: number; itemId: string; tokens: Set<string>; strongHits: string[] }
export interface PrefilterState { passed: PassedRecord[]; passAtMs: number[]; sonnetAtMs: number[] }

export function loadPrefilterConfig(file: string): PrefilterConfig {
  const parsed = ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const compiled: CompiledPattern[] = [];
  for (const kind of ['strong', 'medium', 'negative'] as const) {
    for (const p of parsed.patterns[kind]) {
      try {
        compiled.push({ id: p.id, kind, weight: PATTERN_WEIGHTS[kind], re: new RegExp(p.regex, 'i') });
      } catch (err) {
        throw new Error(`prefilter pattern "${p.id}" has an invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { ...parsed, compiled };
}

/** PERP_PREFILTER: unset, empty or "on" => on; "off" => off (the kill switch); anything else is a configuration error. */
export function resolvePrefilterSetting(env: NodeJS.ProcessEnv): boolean {
  const v = env.PERP_PREFILTER;
  if (v === undefined || v === '' || v === 'on') return true;
  if (v === 'off') return false;
  throw new Error(`PERP_PREFILTER must be "on" or "off", got ${JSON.stringify(v)}`);
}

export function createPrefilterState(): PrefilterState {
  return { passed: [], passAtMs: [], sonnetAtMs: [] };
}

export function scoreText(headline: string, snippet: string | null, cfg: PrefilterConfig): { score: number; hits: string[]; strongHits: string[] } {
  const h = headline ?? '';
  const s = snippet ?? '';
  let total = 0;
  const hits: string[] = [];
  const strongHits: string[] = [];
  for (const p of cfg.compiled) {
    const inHead = p.re.test(h);
    const inSnip = !inHead && s !== '' && p.re.test(s);
    if (!inHead && !inSnip) continue;
    total += p.weight * (inHead ? cfg.headlineWeight : cfg.snippetWeight);
    hits.push(p.id);
    if (p.kind === 'strong') strongHits.push(p.id);
  }
  return { score: Math.max(0, Math.min(cfg.scoreCap, total)), hits, strongHits };
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'its', 'his', 'her', 'their', 'will',
  'would', 'after', 'over', 'into', 'amid', 'says', 'say', 'said', 'about', 'than', 'more', 'new', 'not', 'but', 'you', 'your', 'our', 'they', 'them',
]);

export function tokenize(headline: string): Set<string> {
  const out = new Set<string>();
  for (const t of headline.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Timestamps strictly inside the trailing hour. */
export function countLastHour(timestamps: number[], nowMs: number): number {
  let n = 0;
  for (const t of timestamps) if (nowMs - t < HOUR_MS) n += 1;
  return n;
}

export function sourceClassOf(sourceId: string, cfg: PrefilterConfig): SourceClass {
  return cfg.sources[sourceId] ?? 'unknown';
}

export function prefilter(item: PrefilterItem, cfg: PrefilterConfig, state: PrefilterState, nowMs: number): Verdict {
  const sourceClass = sourceClassOf(item.source_id, cfg);
  if (sourceClass === 'social') return { pass: false, reason: 'source_class_drop', sourceClass, score: 0, hits: [], strongHits: [] };
  const { score, hits, strongHits } = scoreText(item.headline, item.snippet, cfg);
  const base = { sourceClass, score, hits, strongHits };
  if (sourceClass === 'official_macro') return { ...base, pass: true, reason: 'pass' };

  const need = sourceClass === 'market_wire' ? cfg.marketWireThreshold : cfg.threshold;
  if (score < need) return { ...base, pass: false, reason: 'low_score' };

  const tokens = tokenize(item.headline);
  if (tokens.size >= MIN_DEDUP_TOKENS) {
    for (const p of state.passed) {
      if (nowMs - p.atMs > cfg.dedupWindowMs || p.tokens.size < MIN_DEDUP_TOKENS) continue;
      if (jaccard(tokens, p.tokens) >= cfg.dedupJaccard) return { ...base, pass: false, reason: 'duplicate', dupOf: p.itemId };
    }
  }

  if (strongHits.length > 0) {
    for (const p of state.passed) {
      if (nowMs - p.atMs > cfg.cooldownMs) continue;
      if (strongHits.every((h) => p.strongHits.includes(h))) return { ...base, pass: false, reason: 'cooldown', dupOf: p.itemId };
    }
  }

  const used = countLastHour(state.passAtMs, nowMs);
  if (used >= cfg.haikuPerHour) {
    const floor = Math.min(cfg.scoreCap, cfg.threshold + (used - cfg.haikuPerHour + 1));
    if (score < floor) return { ...base, pass: false, reason: 'haiku_cap' };
  }
  return { ...base, pass: true, reason: 'pass' };
}

/** Commit a passing verdict into the state (dedup memory and the hourly Haiku count) and prune what no window needs. */
export function recordPass(state: PrefilterState, item: PrefilterItem, verdict: Verdict, nowMs: number, cfg: PrefilterConfig): void {
  if (verdict.pass && verdict.sourceClass !== 'official_macro') {
    state.passed.push({ atMs: nowMs, itemId: item.item_id, tokens: tokenize(item.headline), strongHits: verdict.strongHits });
    state.passAtMs.push(nowMs);
  }
  const keepFrom = nowMs - Math.max(cfg.dedupWindowMs, cfg.cooldownMs);
  state.passed = state.passed.filter((p) => p.atMs >= keepFrom);
  state.passAtMs = state.passAtMs.filter((t) => nowMs - t < HOUR_MS);
  state.sonnetAtMs = state.sonnetAtMs.filter((t) => nowMs - t < HOUR_MS);
}
