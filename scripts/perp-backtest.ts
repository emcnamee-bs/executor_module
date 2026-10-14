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
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const bars = joinBars(sp, vix).filter((b) => b.date >= cutoffDate);
  const first = bars[0]?.date;
  console.log(`command: years=${years} every=${every} hold=${hold}`);
  console.log(`window: bars=${bars.length} from ${first} to ${bars[bars.length - 1]?.date}; enter every ${every} bars, hold <= ${hold} bars`);
  // Allow 7 days of slack: the first bar is the first trading day on or after the cutoff.
  const slack = new Date(cutoff);
  slack.setUTCDate(slack.getUTCDate() + 7);
  if (first === undefined || first > slack.toISOString().slice(0, 10)) {
    console.log(`WARNING: the requested ${years} years of history (from ${cutoffDate}) is not available from FRED SP500 (it covers only about the last 10 years); the window above is shorter than requested.`);
  }
  for (const side of ['long', 'short'] as const) {
    const { summary } = simulatePriceRules(bars, { cfg: DEFAULT_CONFIG, side, entryEveryDays: every, maxHoldDays: hold });
    console.log(side.toUpperCase(), JSON.stringify({
      trades: summary.n,
      stopOutOrLiquidatedPct: +(summary.stopOutRate * 100).toFixed(1),
      avgMarginReturnPct: +(summary.avgMarginReturn * 100).toFixed(2),
      worstMarginReturnPct: +(summary.worstMarginReturn * 100).toFixed(1),
      touchedMinus3pctFromEntryByExitPct: +(summary.touchedSoftRate * 100).toFixed(1),
      indexMoveAtExitAdverse5pctPct: +(summary.weeklyDrop5Rate * 100).toFixed(1),
    }));
  }
  console.log(
    [
      'NOTE: close-to-close, price rules only (stops, governor, 3% touch frequency); the news rules cannot be backtested on this data.',
      'Intraday wicks are ignored, so stop-out and liquidation frequencies are UNDERSTATED while exits are modelled at the close (gaps hurt).',
      'Funding and slippage are not modelled.',
      'touchedMinus3pctFromEntryByExitPct: share of trades whose worst close was 3% or more against the ENTRY price (not a drawdown from the peak), up to the exit bar.',
      'indexMoveAtExitAdverse5pctPct: share of trades whose index move AT THE EXIT BAR was 5% or more against the side.',
      'Both rate columns are measured from entry / at the exit bar and are truncated by the stops; they are not market-wide frequencies.',
      'Average margin return is dominated by index drift (positive long, negative short), not by edge.',
    ].join('\n')
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
