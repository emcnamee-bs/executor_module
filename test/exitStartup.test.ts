// test/exitStartup.test.ts
import { describe, it, expect } from 'vitest';
import { resolveExitReview } from '../src/startup.js';

const paper = { name: 'kxwti', ledgerPath: 'data/kxwti/decisions.db', consumerGroup: 'execmod-kxwti' };
const env = (over: Record<string, string | undefined> = {}) => ({ KALSHI_DRY_RUN: 'true', ...over }) as NodeJS.ProcessEnv;

describe('resolveExitReview', () => {
  it('is off when EXIT_REVIEW is unset, empty or "off", whatever else is set', () => {
    for (const v of [undefined, '', 'off']) {
      expect(resolveExitReview(paper, env({ EXIT_REVIEW: v })).enabled).toBe(false);
    }
    expect(resolveExitReview(paper, { EXIT_REVIEW: undefined, EXECUTOR_LIVE_TRADE: 'KXAPRPOTUS' } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it('"on" on a dry-run paper unit enables it with the defaults', () => {
    expect(resolveExitReview(paper, env({ EXIT_REVIEW: 'on' }))).toEqual({
      enabled: true, model: undefined, exitFeeCents: 0, retryMs: 20_000, dailyUsdCap: 5,
    });
  });

  it('reads the optional settings', () => {
    const c = resolveExitReview(paper, env({ EXIT_REVIEW: 'on', EXIT_REVIEW_MODEL: 'claude-haiku-5-5', EXIT_FEE_CENTS: '1.5', EXIT_RETRY_MS: '5000', EXIT_DAILY_USD_CAP: '2' }));
    expect(c).toMatchObject({ model: 'claude-haiku-5-5', exitFeeCents: 1.5, retryMs: 5000, dailyUsdCap: 2 });
  });

  it('refuses every unsafe combination', () => {
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'yes' }))).toThrow(/not "on" or "off"/);
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'on', KALSHI_DRY_RUN: undefined }))).toThrow(/KALSHI_DRY_RUN/);
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'on', KALSHI_DRY_RUN: 'false' }))).toThrow(/KALSHI_DRY_RUN/);
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'on', EXECUTOR_LIVE_TRADE: 'KXAPRPOTUS' }))).toThrow(/live unit/);
    expect(() => resolveExitReview({ ...paper, ledgerPath: 'data/decisions.db' }, env({ EXIT_REVIEW: 'on' }))).toThrow(/live ledger/);
    expect(() => resolveExitReview({ ...paper, consumerGroup: 'execmod' }, env({ EXIT_REVIEW: 'on' }))).toThrow(/live ledger/);
  });

  it('rejects malformed numbers', () => {
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'on', EXIT_FEE_CENTS: '-1' }))).toThrow(/EXIT_FEE_CENTS/);
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'on', EXIT_RETRY_MS: '10' }))).toThrow(/EXIT_RETRY_MS/);
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'on', EXIT_DAILY_USD_CAP: '0' }))).toThrow(/EXIT_DAILY_USD_CAP/);
    expect(() => resolveExitReview(paper, env({ EXIT_REVIEW: 'on', EXIT_DAILY_USD_CAP: 'abc' }))).toThrow(/EXIT_DAILY_USD_CAP/);
  });
});
