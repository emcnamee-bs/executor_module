// src/perp/quant/pressure.ts
import type { PerpConfig } from '../config.js';
import type { ImpactAssessment } from '../types.js';

const MS_PER_DAY = 86_400_000;

const finite01 = (x: number): number | null => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null);

/**
 * Signed expected index move (fraction) that one item adds to the news pressure at arrival.
 * Positive = bullish. Any non-finite credibility/confidence yields 0, never NaN.
 */
export function itemWeight(a: ImpactAssessment, cfg: PerpConfig): number {
  const sign = a.direction === 'up' ? 1 : a.direction === 'down' ? -1 : 0;
  const cred = finite01(a.credibility);
  const conf = finite01(a.confidence);
  if (cred === null || conf === null) return 0;
  return sign * cfg.bucketMove[a.bucket] * cred * conf * cfg.noveltyWeight[a.novelty] * cfg.pricedWeight[a.alreadyPriced];
}

interface Entry {
  weight: number;
  receivedAtMs: number;
  tauMs: number;
  rationale: string;
}

/** Signed news pressure: a sum of item weights, each decaying exponentially from the moment it was received. */
export class PressureBook {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly cfg: PerpConfig) {}

  /**
   * Returns false (and changes nothing) when this item id was already added, its receive time is not
   * finite, or its decay constant is not a finite positive number (unknown horizon / zero factor).
   * A non-finite weight (e.g. unknown bucket) is stored as 0 so it can never poison the sum.
   */
  add(a: ImpactAssessment): boolean {
    if (this.entries.has(a.itemId)) return false;
    if (!Number.isFinite(a.receivedAtMs)) return false;
    const tauMs = this.cfg.tauDays * MS_PER_DAY * this.cfg.horizonTauFactor[a.horizon];
    if (!Number.isFinite(tauMs) || tauMs <= 0) return false;
    const w = itemWeight(a, this.cfg);
    this.entries.set(a.itemId, {
      weight: Number.isFinite(w) ? w : 0,
      receivedAtMs: a.receivedAtMs,
      tauMs,
      rationale: a.rationale,
    });
    return true;
  }

  /** One entry's decayed contribution at `tMs`; 0 if it has not been received yet. Entries are finite by construction. */
  private contribution(e: Entry, tMs: number): number {
    if (e.receivedAtMs > tMs) return 0;
    return e.weight * Math.exp(-(tMs - e.receivedAtMs) / e.tauMs);
  }

  /** Pressure as of time `tMs`: only items already received by then, each decayed to `tMs`. 0 if `tMs` is not finite. */
  at(tMs: number): number {
    if (!Number.isFinite(tMs)) return 0;
    let p = 0;
    for (const e of this.entries.values()) p += this.contribution(e, tMs);
    return p;
  }

  top(tMs: number, n: number): Array<{ itemId: string; contribution: number; rationale: string }> {
    if (!Number.isFinite(tMs)) return [];
    const rows: Array<{ itemId: string; contribution: number; rationale: string }> = [];
    for (const [itemId, e] of this.entries) {
      if (e.receivedAtMs > tMs) continue;
      rows.push({ itemId, contribution: this.contribution(e, tMs), rationale: e.rationale });
    }
    rows.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
    return rows.slice(0, n);
  }

  /** Drops items received before `beforeMs`; returns how many were removed. */
  prune(beforeMs: number): number {
    let removed = 0;
    for (const [id, e] of this.entries) {
      if (e.receivedAtMs < beforeMs) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
