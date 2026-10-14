// scripts/perp-verify.ts
// Phase 0 verification. READ-ONLY: GET requests only, no orders, no money movement, no model calls.
// Prints the facts the spec marks "(verify)" so the operator can confirm or correct them.
// Usage: set -a; . ./.env; set +a; npm run perp-verify
import { fetchFredRows } from '../src/perp/collectors/fred.js';
import { KalshiMarginClient, MARGIN_HOSTS } from '../src/perp/broker/kalshiMarginClient.js';
import { ratioSeries } from '../src/perp/backtest/priceRules.js';

const TICKER = process.env.PERP_TICKER ?? 'KXUS500PERP';

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main(): Promise<void> {
  const client = new KalshiMarginClient({ env: 'prod', apiKeyId: must('KALSHI_API_KEY_ID'), privateKeyPath: must('KALSHI_PRIVATE_KEY_PATH') });
  const now = Math.floor(Date.now() / 1000);

  console.log('## 1. Margin access and balance');
  console.log('enabled:', JSON.stringify(await client.get('/margin/enabled')));
  console.log('balance:', JSON.stringify(await client.get('/margin/balance')));

  console.log('\n## 2. Market spec, schedule and risk parameters (confirm hours and the daily break)');
  const { market } = await client.get<{ market: Record<string, unknown> }>(`/margin/markets/${TICKER}`);
  console.log(JSON.stringify({ schedule: market.schedule, price: market.price, leverage_estimates: { long: market.long_leverage_estimates, short: market.short_leverage_estimates }, contract_size: market.contract_size, funding_cap: market.funding_cap }));
  const rp = await client.get<{ liquidation_margin_ratio_threshold: number; queue_entry_margin_ratio_threshold: number; initial_margin_multiplier: Record<string, number> }>('/margin/risk_parameters');
  console.log('risk_parameters:', JSON.stringify({ liquidation: rp.liquidation_margin_ratio_threshold, queueEntry: rp.queue_entry_margin_ratio_threshold, initialMarginMultiplier: rp.initial_margin_multiplier[TICKER] }));

  console.log('\n## 3. Funding history (compare the sign with a known long/short position on demo to settle who pays)');
  console.log(JSON.stringify(await client.get('/margin/funding_rates/historical', { ticker: TICKER })));

  console.log('\n## 4. Does the perp track the S&P 500? ratio of perp daily close to FRED SP500 close (should be ~constant)');
  const candles = await client.get<{ candlesticks: Array<{ end_period_ts: number; price: { close: string | null } }> }>(
    `/margin/markets/${TICKER}/candlesticks`,
    { start_ts: now - 30 * 86400, end_ts: now, period_interval: 1440 }
  );
  const perpCloses = candles.candlesticks
    .filter((c) => c.price?.close !== null && c.price?.close !== undefined)
    .map((c) => ({ date: new Date(c.end_period_ts * 1000).toISOString().slice(0, 10), value: Number(c.price.close) }));
  const sp = await fetchFredRows('SP500');
  console.log(JSON.stringify(ratioSeries(perpCloses, sp)));
  console.log('(each perp candle ends at 00:00 UTC of the listed date and covers the PREVIOUS day: also try matching the previous date)');

  console.log('\n## 5. Demo exchange lists the paper instrument?');
  const demo = await fetch(`${MARGIN_HOSTS.demo}/trade-api/v2/margin/markets?limit=200`).then((r) => r.json() as Promise<{ markets: Array<{ ticker: string }> }>);
  console.log(demo.markets.map((m) => m.ticker).filter((t) => t.includes('US500')));

  console.log('\n## 6. Real-time index probe (is Stooq usable for a fresher S&P/VIX?)');
  const stooq = await fetch('https://stooq.com/q/l/?s=^spx&f=sd2t2c&h&e=csv').then((r) => r.text()).catch((e) => `error: ${String(e)}`);
  console.log(stooq.trim());

  console.log('\n## Operator checklist (record the answers in docs/runbook-perp.md)');
  console.log('[ ] hours and daily break confirmed   [ ] ratio constant => perp tracks S&P   [ ] funding payer confirmed on demo');
  console.log('[ ] liquidation ratio definition confirmed with /margin/risk on a demo position   [ ] isolated vs cross trigger path confirmed');
  console.log('[ ] subaccount isolation confirmed   [ ] demo account + API key created');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
