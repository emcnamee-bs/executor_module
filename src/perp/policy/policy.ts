// src/perp/policy/policy.ts
import type { PerpConfig } from '../config.js';
import { stopFraction } from '../quant/formulas.js';
import type { GovernorOutput } from '../risk/governor.js';
import type { RiskState } from '../risk/state.js';
import { eventSoon, inEventWindow, minutesToClose, MS_PER_MIN } from '../time/windows.js';
import type { Action, Direction, ExitRule, ImpactAssessment, PositionState, Side, Snapshot } from '../types.js';

export type NewItem = ImpactAssessment & { movedSincePublish: number | null };

export interface PolicyInput {
  nowMs: number;
  cfg: PerpConfig;
  snapshot: Snapshot;
  position: PositionState | null;
  /** Signed decayed news pressure now (positive = bullish) and 12 hours ago. */
  pressureNow: number;
  pressure12hAgo: number;
  /** Items that arrived since the previous evaluation. */
  newItems: NewItem[];
  governors: Record<Side, GovernorOutput>;
  /** Leverage a new 1-contract position would have (price x contracts / subaccount equity); null if unknown. */
  realizedLeverage: number | null;
  /** Broker distance to liquidation as a fraction of price; only meaningful while positioned. */
  liqDistance: number | null;
  /** Best mark in the last 7 days in the position's favour (max for a long, min for a short). */
  weeklyExtreme: number | null;
  risk: RiskState;
  prevBreachStreak: number;
}

export interface PolicyOutput {
  action: Action;
  /** Consecutive evaluations with adverse pressure at or beyond the exit threshold. */
  breachStreak: number;
}

export function entryThreshold(side: Side, cfg: PerpConfig): number {
  return side === 'long' ? cfg.pEntryLong : cfg.pEntryLong * cfg.shortBar;
}

const adverseDirection = (side: Side): Direction => (side === 'long' ? 'down' : 'up');
const favourableDirection = (side: Side): Direction => (side === 'long' ? 'up' : 'down');
/** Pressure in the position's favour: positive is good for the side. */
const aligned = (side: Side, p: number): number => (side === 'long' ? p : -p);
const fmtPct = (x: number): string => `${(x * 100).toFixed(2)}%`;

export function decide(inp: PolicyInput): PolicyOutput {
  return inp.position === null ? decideFlat(inp) : decideInPosition(inp, inp.position);
}

function decideInPosition(inp: PolicyInput, pos: PositionState): PolicyOutput {
  const { cfg, nowMs, snapshot } = inp;
  const gov = inp.governors[pos.side];
  // Bad pressure data must never suppress the price/margin/shock rules: treat it as neutral.
  const pNow = Number.isFinite(inp.pressureNow) ? inp.pressureNow : 0;
  const pPrev = Number.isFinite(inp.pressure12hAgo) ? inp.pressure12hAgo : 0;
  const liqDistance = inp.liqDistance !== null && Number.isFinite(inp.liqDistance) ? inp.liqDistance : null;
  const adverseNow = -aligned(pos.side, pNow);
  const adversePrev = -aligned(pos.side, pPrev);
  const breachStreak = adverseNow >= cfg.pExit ? inp.prevBreachStreak + 1 : 0;
  const currentStop = pos.stopBps / 10_000;

  const close = (rule: ExitRule, reason: string): PolicyOutput => ({
    action: { kind: 'close', rule, reasons: [reason] },
    breachStreak,
  });
  const hold = (reason: string): PolicyOutput => ({ action: { kind: 'hold', reasons: [reason] }, breachStreak });

  // Nothing can be traded while the market is closed; the exchange-side trigger stays in force.
  if (!snapshot.perp.marketOpen) return hold('market closed; exchange trigger remains in force');

  // Stale data: do not act on it; the exchange-side trigger stays in force.
  const ageMs = Math.max(nowMs - snapshot.tsMs, snapshot.freshness.perpAgeMs);
  if (ageMs > cfg.staleSnapshotMs) return hold('stale data; exchange trigger remains in force');

  // Rule 2: margin guard.
  if (liqDistance !== null && liqDistance < 2 * currentStop) {
    return close('margin_guard', `liquidation distance ${fmtPct(liqDistance)} < 2 x stop ${fmtPct(currentStop)}`);
  }

  // Rule 3: credible, novel, adverse shock closes the position.
  const against = inp.newItems.filter((i) => i.direction === adverseDirection(pos.side));
  const shock = against.find(
    (i) => i.bucket === 'shock' && i.novelty === 'new' && i.confidence >= cfg.shockConfidence && i.credibility >= cfg.shockCredibility
  );
  if (shock) return close('shock', `adverse shock item ${shock.itemId}: ${shock.rationale}`);

  // Rule 4: slow bleed needs price AND news: drawdown from the weekly extreme, persistent adverse pressure.
  const mark = snapshot.perp.mark;
  const ref = inp.weeklyExtreme;
  const drawdown =
    ref === null || ref <= 0 ? 0 : pos.side === 'long' ? (ref - mark) / ref : (mark - ref) / ref;
  if (drawdown >= cfg.softDrawdown && adverseNow >= cfg.pExit && adverseNow >= adversePrev) {
    return close(
      'slow_bleed',
      `drawdown ${fmtPct(drawdown)} from weekly extreme with adverse pressure ${fmtPct(adverseNow)} not decaying (12h ago ${fmtPct(adversePrev)})`
    );
  }

  // Rule 5: cumulative adverse pressure for two consecutive evaluations.
  if (breachStreak >= 2) {
    return close('pressure', `adverse pressure ${fmtPct(adverseNow)} >= exit threshold ${fmtPct(cfg.pExit)} for ${breachStreak} evaluations`);
  }

  // Weekly close: flat unless the aligned pressure is strong.
  const mtc = minutesToClose(nowMs, snapshot.perp.nextCloseTsMs);
  if (mtc !== null && mtc >= 0 && mtc <= cfg.weekendFlatMinutes) {
    const holdAt = cfg.weekendHoldMult * entryThreshold(pos.side, cfg);
    if (aligned(pos.side, pNow) < holdAt) {
      return close('weekend', `${mtc.toFixed(0)} min to weekly close and aligned pressure ${fmtPct(aligned(pos.side, pNow))} < ${fmtPct(holdAt)}`);
    }
  }

  // Rule 6: tighten on a credible adverse "major" item or ahead of a high-impact release.
  const majorAdverse = against.some(
    (i) => i.bucket === 'major' && i.novelty === 'new' && i.confidence >= cfg.shockConfidence && i.credibility >= cfg.shockCredibility
  );
  const releaseSoon = eventSoon(nowMs, snapshot.events, cfg.eventTightenMinutes);
  // Soonest qualifying release: the tightening must outlast it, not expire when it starts.
  const soonestEventMs = snapshot.events
    .filter((e) => e.impact === 'high' && e.tsMs > nowMs && e.tsMs - nowMs <= cfg.eventTightenMinutes * MS_PER_MIN)
    .reduce<number | null>((m, e) => (m === null || e.tsMs < m ? e.tsMs : m), null);
  if (majorAdverse || releaseSoon) {
    const tightenFrac = Math.max(cfg.tightenFloor, cfg.tightenSigmaDayMult * gov.sigmaDay);
    if (tightenFrac < currentStop - 1e-9) {
      return {
        action: {
          kind: 'set_stop',
          stopFrac: tightenFrac,
          holdMs:
            majorAdverse || soonestEventMs === null
              ? cfg.tightenHoldMinutes * MS_PER_MIN
              : soonestEventMs - nowMs + cfg.tightenHoldMinutes * MS_PER_MIN,
          reasons: [majorAdverse ? 'adverse major item: tighten stop' : 'high-impact release ahead: tighten stop'],
        },
        breachStreak,
      };
    }
    return hold('already tightened ahead of risk');
  }

  // A deliberate tightening is held until it expires.
  if (pos.tightenedUntilMs !== null && nowMs < pos.tightenedUntilMs) return hold('stop tightened; holding until it expires');

  // Keep the exchange trigger in sync with the current volatility, but never widen it from fallback volatility.
  if (gov.sigmaSource === 'default') return hold('no volatility estimate; stop re-sync skipped');
  const desired = stopFraction(gov.sigmaWeek, pos.leverage, cfg);
  if (Math.abs(desired - currentStop) >= cfg.resyncMinChange) {
    return {
      action: { kind: 'set_stop', stopFrac: desired, holdMs: null, reasons: [`re-sync stop ${fmtPct(currentStop)} -> ${fmtPct(desired)}`] },
      breachStreak,
    };
  }
  return hold('no exit rule fired');
}

function decideFlat(inp: PolicyInput): PolicyOutput {
  const { cfg, nowMs, snapshot, risk } = inp;
  const hold = (...reasons: string[]): PolicyOutput => ({ action: { kind: 'hold', reasons }, breachStreak: 0 });

  if (risk.halted) return hold(`halted: ${risk.haltReason ?? 'unknown'}`);
  const ageMs = Math.max(nowMs - snapshot.tsMs, snapshot.freshness.perpAgeMs);
  if (ageMs > cfg.staleSnapshotMs) return hold(`stale data (${Math.round(ageMs / 1000)}s old)`);
  if (!snapshot.perp.marketOpen) return hold('market closed');
  const mtc = minutesToClose(nowMs, snapshot.perp.nextCloseTsMs);
  if (mtc !== null && mtc <= cfg.weekendFlatMinutes) return hold('inside the weekly-close window');
  if (inEventWindow(nowMs, snapshot.events, cfg.noTradeMinutesAroundEvents)) {
    return hold('inside the no-trade window around a scheduled release');
  }

  const sides: Side[] = [];
  if (cfg.allowLong) sides.push('long');
  if (cfg.allowShort) sides.push('short');
  const gov = inp.governors[sides[0] ?? 'long'];
  if (gov.sigmaSource === 'default') return hold('no volatility estimate (VIX and realized sigma unavailable)');
  const realizedLeverage = inp.realizedLeverage;
  if (realizedLeverage === null || !(Number.isFinite(realizedLeverage) && realizedLeverage > 0)) {
    return hold('realized leverage unknown or invalid');
  }
  if (!Number.isFinite(inp.pressureNow)) return hold('news pressure unknown or invalid');

  const reasons: string[] = [];
  for (const side of sides) {
    const g = inp.governors[side];
    if (g.leverageEff < cfg.minLeverage) {
      reasons.push(`${side}: governed leverage ${g.leverageEff.toFixed(2)}x below minimum ${cfg.minLeverage}x`);
      continue;
    }
    if (realizedLeverage > g.leverageEff * cfg.entryLeverageSlack) {
      reasons.push(`${side}: realized leverage ${realizedLeverage.toFixed(2)}x exceeds governed ${g.leverageEff.toFixed(2)}x (fund more collateral)`);
      continue;
    }
    if (nowMs < risk.cooldownUntilMs[side]) {
      reasons.push(`${side}: cooling down until ${new Date(risk.cooldownUntilMs[side]).toISOString()}`);
      continue;
    }
    const threshold = entryThreshold(side, cfg) * risk.thresholdMult[side];
    const alignedP = aligned(side, inp.pressureNow);
    if (alignedP < threshold) {
      reasons.push(`${side}: pressure ${fmtPct(alignedP)} below threshold ${fmtPct(threshold)}`);
      continue;
    }
    const minConf = side === 'long' ? cfg.confLong : cfg.confShort;
    const trigger = inp.newItems.find((i) => i.direction === favourableDirection(side) && i.novelty === 'new' && i.confidence >= minConf);
    if (!trigger) {
      reasons.push(`${side}: no new item with confidence >= ${minConf} in its direction`);
      continue;
    }
    const lateLimit = cfg.latenessMaxFrac * cfg.bucketMove[trigger.bucket];
    if (trigger.movedSincePublish === null || !Number.isFinite(trigger.movedSincePublish)) {
      reasons.push(`${side}: item ${trigger.itemId} has no valid price move since publish; cannot check lateness`);
      continue;
    }
    if (trigger.movedSincePublish > lateLimit) {
      reasons.push(`${side}: late, market already moved ${fmtPct(trigger.movedSincePublish)} (> ${fmtPct(lateLimit)})`);
      continue;
    }
    return {
      action: {
        kind: 'open',
        side,
        leverage: realizedLeverage,
        stopFrac: stopFraction(g.sigmaWeek, realizedLeverage, cfg),
        triggerItemId: trigger.itemId,
        reasons: [`${side} entry: pressure ${fmtPct(alignedP)} >= ${fmtPct(threshold)}; item ${trigger.itemId}: ${trigger.rationale}`],
      },
      breachStreak: 0,
    };
  }
  return hold(...(reasons.length > 0 ? reasons : ['no side allowed by config']));
}
