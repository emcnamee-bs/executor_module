// src/perp/startup.ts
import { KalshiMarginBroker, fetchMarginQuote } from './broker/kalshiMarginBroker.js';
import type { KalshiMarginClient } from './broker/kalshiMarginClient.js';
import { DEFAULT_PAPER_CONFIG, PaperBroker } from './broker/paper.js';
import type { Broker } from './broker/types.js';

export type PerpMode = 'paper' | 'demo' | 'live';
export interface ModeConfig {
  mode: PerpMode;
  subaccount: number | null;
  /** The market ticker whose prices drive decisions: the demo exchange lists the perp with a "1" suffix. */
  marketTicker: string;
}
export type MarginClientLike = Pick<KalshiMarginClient, 'get' | 'post' | 'put' | 'del'>;

/** Start guards (spec section 8): paper by default; demo/live only with a dedicated subaccount; live only with an exact opt-in. */
export function resolveMode(env: NodeJS.ProcessEnv, ticker: string): ModeConfig {
  const mode = env.PERP_MODE ?? 'paper';
  if (mode !== 'paper' && mode !== 'demo' && mode !== 'live') {
    throw new Error(`PERP_MODE must be paper, demo or live, got ${JSON.stringify(mode)}`);
  }
  if (mode === 'paper') return { mode, subaccount: null, marketTicker: ticker };

  const raw = env.PERP_SUBACCOUNT;
  const sub = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(sub) || sub < 1 || sub > 63) {
    throw new Error('PERP_SUBACCOUNT must be an integer 1-63 for demo/live (the primary account 0 is never used)');
  }
  if (mode === 'demo') {
    for (const k of ['KALSHI_DEMO_API_KEY_ID', 'KALSHI_DEMO_PRIVATE_KEY_PATH']) {
      if (!env[k]) throw new Error(`${k} is required for demo mode`);
    }
    return { mode, subaccount: sub, marketTicker: env.PERP_DEMO_TICKER || `${ticker}1` };
  }
  if (env.PERP_LIVE !== `${ticker}:${sub}`) {
    throw new Error(`live mode requires PERP_LIVE=${ticker}:${sub} exactly`);
  }
  return { mode, subaccount: sub, marketTicker: ticker };
}

export function createBroker(
  mode: ModeConfig,
  d: { env: NodeJS.ProcessEnv; ticker: string; prodClient: MarginClientLike | null; demoClient: MarginClientLike | null; now: () => number }
): { broker: Broker; paper: PaperBroker | null } {
  if (mode.mode === 'paper') {
    const prodClient = d.prodClient;
    if (prodClient === null) throw new Error('paper mode needs the production client (it reads live prices; GET only)');
    const equity = Number(d.env.PERP_PAPER_EQUITY_USD ?? DEFAULT_PAPER_CONFIG.startEquityUsd);
    if (!Number.isFinite(equity) || equity <= 0) throw new Error('PERP_PAPER_EQUITY_USD must be a positive number of dollars');
    const paper = new PaperBroker(
      () => fetchMarginQuote(prodClient, d.ticker, d.now()),
      { ...DEFAULT_PAPER_CONFIG, startEquityUsd: equity },
      d.now
    );
    return { broker: paper, paper };
  }

  const triggerMode = d.env.PERP_TRIGGER_MODE ?? 'isolated';
  if (triggerMode !== 'isolated' && triggerMode !== 'cross') throw new Error('PERP_TRIGGER_MODE must be isolated or cross');
  const slippage = Number(d.env.PERP_SLIPPAGE_FRAC ?? 0.002);
  if (!Number.isFinite(slippage) || slippage <= 0 || slippage > 0.02) throw new Error('PERP_SLIPPAGE_FRAC must be between 0 and 0.02');
  const client = mode.mode === 'demo' ? d.demoClient : d.prodClient;
  if (client === null) throw new Error(mode.mode === 'demo' ? 'demo mode needs a demo client' : 'live mode needs the production client');
  const broker = new KalshiMarginBroker(
    client,
    { env: mode.mode === 'demo' ? 'demo' : 'prod', ticker: mode.marketTicker, subaccount: mode.subaccount, triggerMode, slippageFrac: slippage },
    { now: d.now }
  );
  return { broker, paper: null };
}
