// src/decide/sizing.ts
import type { BandMarket } from './kalshi.js';
import { RUNG_STAKES, type Rung } from './rung.js';

const SETTLEMENT_CENTS = 100;
const MAX_SPREAD_CENTS = 5;
const MIN_DEPTH_CONTRACTS = 1;
const MIN_PRICE_CENTS = 10;
const MAX_PRICE_CENTS = 90;
const MIN_EDGE_CENTS = 0.5;
const MAX_NOTIONAL_CENTS_PER_TRADE = 1000;
const MAX_TOTAL_EXPOSURE_CENTS = 4000;
const DEFAULT_BAND_WIDTH_PTS = 0.2;

export interface SizingInput {
  bands: BandMarket[];
  rung: Rung;
  direction: 'up' | 'down';
  magnitudePts: number;
  currentTotalExposureCents: number;
}

export interface SizingResult {
  wouldTrade: boolean;
  marketTicker: string | null;
  side: 'yes' | 'no' | null;
  contracts: number;
  entryPriceCents: number | null;
  notionalCents: number;
  edgeCents: number | null;
  reason: string;
}

export interface BandCandidate {
  ticker: string;
  side: 'yes' | 'no';
  askCents: number;
  spreadCents: number;
  depthContracts: number;
  fairPriceCents: number;
  edgeCents: number;
}

export interface GateVerdict {
  ok: boolean;
  reason: string;
}

export interface CurvePoint {
  centerPts: number;
  probability: number;
}

/** Pure microstructure/edge gate over one already-priced candidate. */
export function gateCandidate(candidate: BandCandidate): GateVerdict {
  if (candidate.askCents < MIN_PRICE_CENTS || candidate.askCents > MAX_PRICE_CENTS) {
    return {
      ok: false,
      reason: `price ${candidate.askCents}c outside tradeable range [${MIN_PRICE_CENTS},${MAX_PRICE_CENTS}]`,
    };
  }
  if (candidate.spreadCents > MAX_SPREAD_CENTS) {
    return { ok: false, reason: `spread ${candidate.spreadCents}c exceeds ${MAX_SPREAD_CENTS}c` };
  }
  if (candidate.depthContracts < MIN_DEPTH_CONTRACTS) {
    return { ok: false, reason: `depth ${candidate.depthContracts} below minimum ${MIN_DEPTH_CONTRACTS}` };
  }
  if (candidate.edgeCents < MIN_EDGE_CENTS) {
    return { ok: false, reason: `edge ${candidate.edgeCents.toFixed(2)}c below minimum ${MIN_EDGE_CENTS}c` };
  }
  return { ok: true, reason: 'clears all gates' };
}

export function typicalBandWidthPts(bands: BandMarket[]): number {
  const widths = bands
    .filter((b): b is BandMarket & { floorStrike: number; capStrike: number } =>
      b.floorStrike !== null && b.capStrike !== null
    )
    .map((b) => b.capStrike - b.floorStrike);
  if (widths.length === 0) return DEFAULT_BAND_WIDTH_PTS;
  return widths.reduce((a, w) => a + w, 0) / widths.length;
}

function bandMidpointPts(band: BandMarket, widthPts: number): number {
  if (band.floorStrike !== null && band.capStrike !== null) {
    return (band.floorStrike + band.capStrike) / 2;
  }
  if (band.floorStrike !== null) {
    return band.floorStrike + widthPts / 2;
  }
  if (band.capStrike !== null) {
    return band.capStrike - widthPts / 2;
  }
  throw new Error(`band ${band.ticker} has neither floorStrike nor capStrike`);
}

function bandYesProbability(band: BandMarket): number | null {
  if (band.yesAskCents === null || band.yesBidCents === null) return null;
  return (band.yesAskCents + band.yesBidCents) / 200;
}

export function buildProbabilityCurve(bands: BandMarket[], widthPts: number): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (const b of bands) {
    const p = bandYesProbability(b);
    if (p === null) continue;
    points.push({ centerPts: bandMidpointPts(b, widthPts), probability: p });
  }
  return points.sort((a, b) => a.centerPts - b.centerPts);
}

function interpolateProbability(curve: CurvePoint[], targetPts: number): number {
  if (curve.length === 0) return 0;
  if (targetPts <= curve[0].centerPts) return curve[0].probability;
  const last = curve[curve.length - 1];
  if (targetPts >= last.centerPts) return last.probability;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (targetPts >= a.centerPts && targetPts <= b.centerPts) {
      const t = (targetPts - a.centerPts) / (b.centerPts - a.centerPts);
      return a.probability + t * (b.probability - a.probability);
    }
  }
  return 0;
}

function kellyFraction(fairPriceCents: number, askCents: number): number {
  if (!(askCents > 0 && askCents < SETTLEMENT_CENTS)) return 0;
  const fraction = (fairPriceCents - askCents) / (SETTLEMENT_CENTS - askCents);
  return Math.max(0, fraction);
}

export function buildCandidatesForBand(
  band: BandMarket,
  curve: CurvePoint[],
  widthPts: number,
  signedMagnitudePts: number
): BandCandidate[] {
  const targetPts = bandMidpointPts(band, widthPts) - signedMagnitudePts;
  const fairProbability = interpolateProbability(curve, targetPts);
  const fairPriceCents = Math.round(fairProbability * 100);
  const candidates: BandCandidate[] = [];

  if (band.yesAskCents !== null && band.yesBidCents !== null) {
    candidates.push({
      ticker: band.ticker,
      side: 'yes',
      askCents: band.yesAskCents,
      spreadCents: band.yesAskCents - band.yesBidCents,
      depthContracts: band.yesAskSizeContracts,
      fairPriceCents,
      edgeCents: fairPriceCents - band.yesAskCents,
    });
  }

  // The NO side of a binary Kalshi market is the complement of the same book:
  // no_ask = 100 - yes_bid (consuming the NO ask fills the resting YES bid).
  if (band.yesBidCents !== null && band.yesAskCents !== null) {
    const noAskCents = SETTLEMENT_CENTS - band.yesBidCents;
    const noFairPriceCents = SETTLEMENT_CENTS - fairPriceCents;
    candidates.push({
      ticker: band.ticker,
      side: 'no',
      askCents: noAskCents,
      spreadCents: band.yesAskCents - band.yesBidCents,
      depthContracts: band.yesBidSizeContracts,
      fairPriceCents: noFairPriceCents,
      edgeCents: noFairPriceCents - noAskCents,
    });
  }

  return candidates;
}

export function evaluateSizing(input: SizingInput): SizingResult {
  const decline = (reason: string): SizingResult => ({
    wouldTrade: false,
    marketTicker: null,
    side: null,
    contracts: 0,
    entryPriceCents: null,
    notionalCents: 0,
    edgeCents: null,
    reason,
  });

  const stake = RUNG_STAKES[input.rung];
  if (stake <= 0) {
    return decline(`rung is ${input.rung}, stake ${stake} -- never trades`);
  }

  const widthPts = typicalBandWidthPts(input.bands);
  const curve = buildProbabilityCurve(input.bands, widthPts);
  if (curve.length === 0) {
    return decline('no band has a usable two-sided price; cannot build a fair-value curve');
  }

  const signedMagnitudePts = input.direction === 'up' ? input.magnitudePts : -input.magnitudePts;

  const remainingExposureCents = MAX_TOTAL_EXPOSURE_CENTS - input.currentTotalExposureCents;
  if (remainingExposureCents <= 0) {
    return decline(`total exposure cap reached (${input.currentTotalExposureCents}c of ${MAX_TOTAL_EXPOSURE_CENTS}c)`);
  }

  let best: BandCandidate | null = null;
  let lastGateFailureReason: string | null = null;

  for (const band of input.bands) {
    if (band.status !== 'active') continue;
    for (const candidate of buildCandidatesForBand(band, curve, widthPts, signedMagnitudePts)) {
      const verdict = gateCandidate(candidate);
      if (!verdict.ok) {
        lastGateFailureReason = verdict.reason;
        continue;
      }

      const kelly = kellyFraction(candidate.fairPriceCents, candidate.askCents);
      if (kelly <= 0) {
        lastGateFailureReason = 'zero Kelly fraction';
        continue;
      }

      if (best === null || candidate.edgeCents > best.edgeCents) {
        best = candidate;
      }
    }
  }

  if (best === null) {
    return decline(lastGateFailureReason ?? 'no band cleared the tradeability/edge gates after the fair-value shift');
  }

  const kelly = kellyFraction(best.fairPriceCents, best.askCents);
  const byCeiling = Math.floor(MAX_NOTIONAL_CENTS_PER_TRADE / best.askCents);
  const byExposureRemaining = Math.floor(remainingExposureCents / best.askCents);
  const byKellyStake = Math.floor(byCeiling * kelly * stake);
  const contracts = Math.max(0, Math.min(byKellyStake, best.depthContracts, byExposureRemaining));

  if (contracts <= 0) {
    return decline('sized to zero contracts after Kelly/stake/depth/exposure clamps');
  }

  const notionalCents = contracts * best.askCents;

  return {
    wouldTrade: true,
    marketTicker: best.ticker,
    side: best.side,
    contracts,
    entryPriceCents: best.askCents,
    notionalCents,
    edgeCents: best.edgeCents,
    reason: `${contracts} contracts, ${best.edgeCents.toFixed(2)}c edge, stake ${stake}`,
  };
}
