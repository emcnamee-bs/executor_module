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
}

/**
 * No `confirmed_sources` shortcut exists in this version (deliberate, per the
 * design spec) -- `confirmed` is unreachable. Corroboration promotion always
 * wins over the tier floor when it qualifies, since corroborated (0.5) is
 * never weaker than reported (0.25).
 */
export function computeRung(input: RungInput): Rung {
  const totalDistinctSources = input.storyKey !== null ? input.corroborations : 0;
  if (totalDistinctSources >= 2) {
    return 'corroborated';
  }
  return input.trustTier <= 2 ? 'reported' : 'rumor';
}
