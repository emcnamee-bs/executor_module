// scripts/perp-backtest.ts
// Price-rules-only backtest on FRED S&P 500 + VIX history. Read-only; no orders, no model calls.
// Usage: npm run perp-backtest -- [--years 15] [--every 5] [--hold 5]
import { DEFAULT_CONFIG } from '../src/perp/config.js';
import { fetchFredRows } from '../src/perp/collectors/fred.js';
import { joinBars, simulatePriceRules } from '../src/perp/backtest/priceRules.js';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
  const years = arg('years', 15);
  const every = arg('every', 5);
  const hold = arg('hold', 5);
  const [sp, vix] = await Promise.all([fetchFredRows('SP500'), fetchFredRows('VIXCLS')]);
  const cutoff = new Date();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  const bars = joinBars(sp, vix).filter((b) => b.date >= cutoff.toISOString().slice(0, 10));
  console.log(`bars=${bars.length} from ${bars[0]?.date} to ${bars[bars.length - 1]?.date}; enter every ${every} bars, hold <= ${hold} bars`);
  for (const side of ['long', 'short'] as const) {
    const { summary } = simulatePriceRules(bars, { cfg: DEFAULT_CONFIG, side, entryEveryDays: every, maxHoldDays: hold });
    console.log(side.toUpperCase(), JSON.stringify({
      trades: summary.n,
      stopOutOrLiquidatedPct: +(summary.stopOutRate * 100).toFixed(1),
      avgMarginReturnPct: +(summary.avgMarginReturn * 100).toFixed(2),
      worstMarginReturnPct: +(summary.worstMarginReturn * 100).toFixed(1),
      touched3pctDrawdownPct: +(summary.touchedSoftRate * 100).toFixed(1),
      weeksWith5pctAdverseMovePct: +(summary.weeklyDrop5Rate * 100).toFixed(1),
    }));
  }
  console.log('NOTE: close-to-close, price rules only (stops, governor, 3% drawdown frequency). The news rules cannot be backtested on this data.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
