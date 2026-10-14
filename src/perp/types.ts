// src/perp/types.ts
export type Side = 'long' | 'short';
export type Direction = 'up' | 'down' | 'neutral';
export type Bucket = 'minor' | 'moderate' | 'major' | 'shock';
export type Horizon = 'intraday' | 'days' | 'week';

export type ExitRule =
  | 'trailing_stop' // exchange-side trailing trigger fired
  | 'liquidated'
  | 'margin_guard'
  | 'shock'
  | 'slow_bleed'
  | 'pressure'
  | 'weekend'
  | 'operator';

/** What the impact extractor concluded about one news item (plan 2 produces it). */
export interface ImpactAssessment {
  itemId: string;
  /** When the bot received the item; used for pressure decay. */
  receivedAtMs: number;
  /** Source publish time; used for the lateness check. */
  publishedAtMs: number;
  direction: Direction;
  bucket: Bucket;
  horizon: Horizon;
  credibility: number; // 0..1
  novelty: 'new' | 'known';
  alreadyPriced: 'yes' | 'no' | 'unclear';
  confidence: number; // 0..1
  rationale: string;
}

export interface PositionState {
  side: Side;
  contracts: number;
  entryPrice: number;
  entryTimeMs: number;
  /** Best mark since entry: the highest for a long, the lowest for a short. */
  extreme: number;
  /** Realized leverage at entry: notional / subaccount equity. */
  leverage: number;
  /** Distance of the exchange-side trailing stop, in basis points of the watermark. */
  stopBps: number;
  /** While set and in the future, the stop was deliberately tightened and must not be widened. */
  tightenedUntilMs: number | null;
}

export interface ScheduledEvent {
  tsMs: number;
  name: string;
  impact: 'high' | 'medium';
}

export interface MacroPoint {
  value: number;
  /** Absolute change vs the previous observation, null when unknown. */
  change1d: number | null;
  /** ISO date or timestamp of the observation. */
  asOf: string;
}

export interface Snapshot {
  tsMs: number;
  perp: {
    bid: number;
    ask: number;
    mark: number;
    marketOpen: boolean;
    /** Next scheduled close (ms epoch), null when the exchange does not say. */
    nextCloseTsMs: number | null;
    fundingEstimate: number | null;
  };
  returns: { d1: number | null; d5: number | null };
  realizedWeeklySigma: number | null;
  macro: Record<string, MacroPoint>;
  events: ScheduledEvent[];
  kalshiEvents: Array<{ ticker: string; yesProb: number }>;
  freshness: { perpAgeMs: number; macroAgeMs: number | null };
}

export type Action =
  | { kind: 'hold'; reasons: string[] }
  | { kind: 'open'; side: Side; leverage: number; stopFrac: number; triggerItemId: string; reasons: string[] }
  | { kind: 'close'; rule: ExitRule; reasons: string[] }
  | { kind: 'set_stop'; stopFrac: number; holdMs: number | null; reasons: string[] };
