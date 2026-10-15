// src/perp/lab/sampler.ts
//
// Which dropped item to audit next, and whether the day's budget allows it (spec section 5). All selection is pure given an RNG.
import type Database from 'better-sqlite3';

export type Stratum = 'social' | 'low_score' | 'duplicate' | 'cooldown' | 'haiku_cap';
export const STRATA: readonly Stratum[] = ['social', 'low_score', 'duplicate', 'cooldown', 'haiku_cap'];
export type AuditKind = 'random' | 'boundary';
export interface Candidate { itemId: string; stratum: Stratum; boundary: boolean }

export const BOUNDARY_SHARE = 0.3;
export const CANDIDATE_WINDOW_MS = 3 * 3_600_000;

export function stratumOf(prodReason: string): Stratum | null {
  switch (prodReason) {
    case 'source_class_drop': return 'social';
    case 'low_score': return 'low_score';
    case 'duplicate': return 'duplicate';
    case 'cooldown': return 'cooldown';
    case 'haiku_cap': return 'haiku_cap';
    default: return null;
  }
}

export function isBoundary(row: { class: string; score: number; prod_pass: number; prod_reason: string }, threshold: number): boolean {
  if (row.prod_pass !== 0) return false;
  if (row.class === 'social') return row.score >= threshold;
  return row.prod_reason === 'low_score' && row.score === threshold - 1;
}

/** The most the lab may have spent by now (UTC day): the schedule of cap/24 per hour plus one hourly slice of slack. */
export function pacedAllowanceUsd(capUsd: number, nowMs: number): number {
  const hour = new Date(nowMs).getUTCHours();
  return Math.min(capUsd, (capUsd / 24) * (hour + 2));
}

export function canSpendNow(capUsd: number, spentTodayUsd: number, nowMs: number): boolean {
  return spentTodayUsd < pacedAllowanceUsd(capUsd, nowMs);
}

/** mulberry32: a tiny seeded generator, uniform in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function listCandidates(db: Database.Database, sinceMs: number, threshold: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT i.item_id, i.class, i.score, i.prod_pass, i.prod_reason
         FROM items i LEFT JOIN audits a ON a.item_id = i.item_id
        WHERE a.item_id IS NULL AND i.prod_pass = 0 AND i.received_ms >= ?
        ORDER BY i.received_ms ASC`
    )
    .all(sinceMs) as Array<{ item_id: string; class: string; score: number; prod_pass: number; prod_reason: string }>;
  const out: Candidate[] = [];
  for (const r of rows) {
    const stratum = stratumOf(r.prod_reason);
    if (stratum !== null) out.push({ itemId: r.item_id, stratum, boundary: isBoundary(r, threshold) });
  }
  return out;
}

export function randomAuditCounts(db: Database.Database): Record<Stratum, number> {
  const counts = { social: 0, low_score: 0, duplicate: 0, cooldown: 0, haiku_cap: 0 } as Record<Stratum, number>;
  const rows = db.prepare("SELECT stratum, COUNT(*) AS n FROM audits WHERE kind = 'random' GROUP BY stratum").all() as Array<{ stratum: Stratum; n: number }>;
  for (const r of rows) if (r.stratum in counts) counts[r.stratum] = r.n;
  return counts;
}

export function chooseCandidate(cands: Candidate[], audited: Record<Stratum, number>, rng: () => number): { candidate: Candidate; kind: AuditKind } | null {
  if (cands.length === 0) return null;
  const boundary = cands.filter((c) => c.boundary);
  if (rng() < BOUNDARY_SHARE && boundary.length > 0) {
    return { candidate: boundary[Math.floor(rng() * boundary.length)], kind: 'boundary' };
  }
  // Random sample: equal allocation, so the rare strata (duplicate, cooldown, cap) get data too. Ties go to the earlier stratum.
  let best: Stratum | null = null;
  for (const s of STRATA) {
    if (!cands.some((c) => c.stratum === s)) continue;
    if (best === null || audited[s] < audited[best]) best = s;
  }
  const pool = cands.filter((c) => c.stratum === best);
  return { candidate: pool[Math.floor(rng() * pool.length)], kind: 'random' };
}
