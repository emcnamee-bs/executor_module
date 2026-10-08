export type Rung = 'rumor' | 'reported' | 'corroborated' | 'confirmed';

export const RUNG_STAKES: Record<Rung, number> = {
  rumor: 0.0,
  reported: 0.25,
  corroborated: 0.5,
  confirmed: 1.0,
};

export interface RungInput {
  trustTier: number;
  storyKey: string | null;
  corroborations: number;
  /**
   * EXECUTOR_PAPER_LOW_TIER (time-boxed, paper-only data-collection test): treat a
   * single-source tier 3 or 4 item as `reported` instead of `rumor`. Never read from
   * the environment here; the pipeline passes it in only on a dry-run process.
   */
  relaxLowTier?: boolean;
}

export interface RungResult {
  rung: Rung;
  /** The item's trust tier when the low-tier relaxation changed its rung, else null. */
  lowTierRelaxedFrom: number | null;
}

/**
 * No `confirmed_sources` shortcut exists in this version (deliberate, per the
 * design spec) -- `confirmed` is unreachable. Corroboration promotion always
 * wins over the tier floor when it qualifies, since corroborated (0.5) is
 * never weaker than reported (0.25).
 */
export function computeRung(input: RungInput): Rung {
  return computeRungDetailed(input).rung;
}

/** Tiers the paper low-tier test may lift to `reported`; tier 5 (unverified) never. */
const RELAXABLE_TIERS = new Set([3, 4]);

export function computeRungDetailed(input: RungInput): RungResult {
  const totalDistinctSources = input.storyKey !== null ? input.corroborations : 0;
  if (totalDistinctSources >= 2) {
    return { rung: 'corroborated', lowTierRelaxedFrom: null };
  }
  if (input.trustTier <= 2) return { rung: 'reported', lowTierRelaxedFrom: null };
  if (input.relaxLowTier === true && RELAXABLE_TIERS.has(input.trustTier)) {
    return { rung: 'reported', lowTierRelaxedFrom: input.trustTier };
  }
  return { rung: 'rumor', lowTierRelaxedFrom: null };
}
