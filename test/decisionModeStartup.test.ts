// test/decisionModeStartup.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDecisionMode } from '../src/startup.js';

const paper = { name: 'kxwti', ledgerPath: 'data/kxwti/decisions.db', consumerGroup: 'execmod-kxwti' };
const env = (over: Record<string, string | undefined> = {}) => ({ KALSHI_DRY_RUN: 'true', ...over }) as NodeJS.ProcessEnv;

describe('resolveDecisionMode', () => {
  it('is classic when DECISION_MODE is unset, empty or "classic", whatever else is set', () => {
    for (const v of [undefined, '', 'classic']) expect(resolveDecisionMode(paper, env({ DECISION_MODE: v }), false)).toBe('classic');
    expect(resolveDecisionMode(paper, { EXECUTOR_LIVE_TRADE: 'KXAPRPOTUS' } as NodeJS.ProcessEnv, false)).toBe('classic');
  });

  it('"unified" on a dry-run paper unit with the exit review on is unified', () => {
    expect(resolveDecisionMode(paper, env({ DECISION_MODE: 'unified' }), true)).toBe('unified');
  });

  it('refuses every unsafe combination', () => {
    expect(() => resolveDecisionMode(paper, env({ DECISION_MODE: 'both' }), true)).toThrow(/"classic" or "unified"/);
    expect(() => resolveDecisionMode(paper, env({ DECISION_MODE: 'unified', KALSHI_DRY_RUN: undefined }), true)).toThrow(/KALSHI_DRY_RUN/);
    expect(() => resolveDecisionMode(paper, env({ DECISION_MODE: 'unified', KALSHI_DRY_RUN: 'false' }), true)).toThrow(/KALSHI_DRY_RUN/);
    expect(() => resolveDecisionMode(paper, env({ DECISION_MODE: 'unified', EXECUTOR_LIVE_TRADE: 'KXAPRPOTUS' }), true)).toThrow(/live unit/);
    expect(() => resolveDecisionMode({ ...paper, ledgerPath: 'data/decisions.db' }, env({ DECISION_MODE: 'unified' }), true)).toThrow(/live ledger/);
    expect(() => resolveDecisionMode({ ...paper, consumerGroup: 'execmod' }, env({ DECISION_MODE: 'unified' }), true)).toThrow(/live ledger/);
    expect(() => resolveDecisionMode(paper, env({ DECISION_MODE: 'unified' }), false)).toThrow(/EXIT_REVIEW=on/);
  });
});
