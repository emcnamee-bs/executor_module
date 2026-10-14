// src/perp/backtest/priceRules.ts
import type { PerpConfig } from '../config.js';
import { liquidationDistance, stopFraction } from '../quant/formulas.js';
import { computeGovernor } from '../risk/governor.js';
import type { Side } from '../types.js';

export interface DailyBar {
  date: string;
  close: number;
  vix: number;
}

export interface TradeResult {
  entryDate: string;
  exitDate: string;
  exitReason: 'stop' | 'liquidated' | 'timeout';
  indexReturn: number;
  marginReturn: number;
  leverage: number;
  stopFrac: number;
  touchedSoft: boolean;
}

const TAKER_FEE = 0.000072;

export function joinBars(sp: Array<{ date: string; value: number }>, vix: Array<{ date: string; value: number }>): DailyBar[] {
  const v = new Map(vix.map((r) => [r.date, r.value]));
  const out: DailyBar[] = [];
  for (const r of sp) {
    const x = v.get(r.date);
    if (x !== undefined) out.push({ date: r.date, close: r.value, vix: x });
  }
  return out;
}

export function ratioSeries(a: Array<{ date: string; value: number }>, b: Array<{ date: string; value: number }>): Array<{ date: string; ratio: number }> {
  const m = new Map(b.map((r) => [r.date, r.value]));
  const out: Array<{ date: string; ratio: number }> = [];
  for (const r of a) {
    const d = m.get(r.date);
    if (d !== undefined && d !== 0) out.push({ date: r.date, ratio: r.value / d });
  }
  return out;
}

/**
 * Price-rules-only simulation on daily closes: governed leverage and trailing stop from the entry day's VIX,
 * stop checked on closes and filled at the close (gaps hurt), liquidation by close, timeout otherwise.
 * News rules cannot be backtested on this data.
 */
export function simulatePriceRules(
  bars: DailyBar[],
  p: { cfg: PerpConfig; side: Side; entryEveryDays: number; maxHoldDays: number }
): { trades: TradeResult[]; summary: { n: number; stopOutRate: number; avgMarginReturn: number; worstMarginReturn: number; touchedSoftRate: number; weeklyDrop5Rate: number } } {
  const { cfg, side } = p;
  const dir = side === 'long' ? 1 : -1;
  const trades: TradeResult[] = [];

  for (let i = 0; i + p.maxHoldDays < bars.length; i += p.entryEveryDays) {
    const gov = computeGovernor({ cfg, side, vix: bars[i].vix, realizedWeeklySigma: null });
    if (gov.sigmaSource !== 'vix') continue;
    const leverage = gov.leverageEff;
    const stopFrac = stopFraction(gov.sigmaWeek, leverage, cfg);
    const liqDist = liquidationDistance(leverage, cfg.maintenanceMargin[side]);
    const entry = bars[i].close;
    let extreme = entry;
    let exitIdx = i + p.maxHoldDays;
    let reason: TradeResult['exitReason'] = 'timeout';
    let worstAdverse = 0;

    for (let j = i + 1; j <= i + p.maxHoldDays; j++) {
      const c = bars[j].close;
      const adverse = -dir * (c / entry - 1); // positive = against the position
      worstAdverse = Math.max(worstAdverse, adverse);
      if (adverse >= liqDist) {
        exitIdx = j;
        reason = 'liquidated';
        break;
      }
      extreme = side === 'long' ? Math.max(extreme, c) : Math.min(extreme, c);
      const throughStop = side === 'long' ? c <= extreme * (1 - stopFrac) : c >= extreme * (1 + stopFrac);
      if (throughStop) {
        exitIdx = j;
        reason = 'stop';
        break;
      }
    }

    const indexReturn = bars[exitIdx].close / entry - 1;
    const marginReturn = reason === 'liquidated' ? -1 : Math.max(-1, dir * indexReturn * leverage - 2 * TAKER_FEE * leverage);
    trades.push({
      entryDate: bars[i].date,
      exitDate: bars[exitIdx].date,
      exitReason: reason,
      indexReturn,
      marginReturn,
      leverage,
      stopFrac,
      touchedSoft: worstAdverse >= cfg.softDrawdown,
    });
  }

  const n = trades.length;
  const rate = (f: (t: TradeResult) => boolean): number => (n === 0 ? 0 : trades.filter(f).length / n);
  return {
    trades,
    summary: {
      n,
      stopOutRate: rate((t) => t.exitReason === 'stop' || t.exitReason === 'liquidated'),
      avgMarginReturn: n === 0 ? 0 : trades.reduce((s, t) => s + t.marginReturn, 0) / n,
      worstMarginReturn: n === 0 ? 0 : Math.min(...trades.map((t) => t.marginReturn)),
      touchedSoftRate: rate((t) => t.touchedSoft),
      weeklyDrop5Rate: rate((t) => -dir * t.indexReturn >= 0.05),
    },
  };
}
