// src/perp/lab/features.ts
//
// What the lab records about every item: the production prefilter verdict (the SAME function the bot runs), the lexicon score
// and hits, and what two looser rule variants would have done. Each variant owns its dedup/cap state, so a replay of the same week
// through a different rule set stays internally consistent.
import type { Item } from '../../item.js';
import {
  createPrefilterState, prefilter, recordPass, scoreText, type PrefilterConfig, type PrefilterState, type Verdict,
} from '../intake/prefilter.js';
import type { LabItemRow } from './labDb.js';

export const VARIANT_NAMES = ['strict3', 'loose1', 'social_ok'] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

export function variantConfigs(prod: PrefilterConfig): Record<VariantName, PrefilterConfig> {
  const noSocial = Object.fromEntries(Object.entries(prod.sources).filter(([, c]) => c !== 'social')) as PrefilterConfig['sources'];
  return {
    strict3: prod,
    loose1: { ...prod, threshold: 1 },
    social_ok: { ...prod, sources: noSocial },
  };
}

export interface Evaluator {
  prodCfg: PrefilterConfig;
  prod: PrefilterState;
  variants: Record<Exclude<VariantName, 'strict3'>, { cfg: PrefilterConfig; state: PrefilterState }>;
}

export function makeEvaluator(prodCfg: PrefilterConfig): Evaluator {
  const v = variantConfigs(prodCfg);
  return {
    prodCfg,
    prod: createPrefilterState(),
    variants: { loose1: { cfg: v.loose1, state: createPrefilterState() }, social_ok: { cfg: v.social_ok, state: createPrefilterState() } },
  };
}

export interface Evaluation {
  verdict: Verdict;
  variants: Record<VariantName, boolean>;
  lexScore: number;
  lexHits: string[];
}

type Evaluable = Pick<Item, 'item_id' | 'source_id' | 'headline' | 'snippet'>;

export function evaluate(ev: Evaluator, item: Evaluable, nowMs: number): Evaluation {
  const verdict = prefilter(item, ev.prodCfg, ev.prod, nowMs);
  if (verdict.pass) recordPass(ev.prod, item, verdict, nowMs, ev.prodCfg);
  const lex = scoreText(item.headline, item.snippet, ev.prodCfg);
  const run = (v: { cfg: PrefilterConfig; state: PrefilterState }): boolean => {
    const r = prefilter(item, v.cfg, v.state, nowMs);
    if (r.pass) recordPass(v.state, item, r, nowMs, v.cfg);
    return r.pass;
  };
  return {
    verdict,
    variants: { strict3: verdict.pass, loose1: run(ev.variants.loose1), social_ok: run(ev.variants.social_ok) },
    lexScore: lex.score,
    lexHits: lex.hits,
  };
}

export function toItemRow(item: Item, e: Evaluation, nowMs: number, commit: string, mark: { tsMs: number; mark: number } | null): LabItemRow {
  const published = Date.parse(item.source_publish_ts ?? item.first_seen_ts);
  return {
    item_id: item.item_id,
    received_ms: nowMs,
    published_ms: Number.isFinite(published) ? published : null,
    source_id: item.source_id,
    tier: item.trust_tier,
    headline: item.headline.slice(0, 300),
    snippet: item.snippet === null ? null : item.snippet.slice(0, 1200),
    commit_sha: commit,
    class: e.verdict.sourceClass,
    score: e.lexScore,
    hits: JSON.stringify(e.lexHits),
    prod_pass: e.verdict.pass ? 1 : 0,
    prod_reason: e.verdict.reason,
    dup_of: e.verdict.dupOf ?? null,
    variants: JSON.stringify(e.variants),
    mark_at_ms: mark === null ? null : mark.tsMs,
    mark: mark === null ? null : mark.mark,
  };
}
