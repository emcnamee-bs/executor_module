// src/paper/exitSpend.ts
//
// EXIT_DAILY_USD_CAP is ALERT-ONLY (spec section 7): going over it pages a human once per UTC day but
// never stops reviews, because stopping would blind the exits exactly when news is heaviest.
import type Database from 'better-sqlite3';

// USD per million tokens. Haiku 5.5's price is the one recorded in anthropicGateClient.ts. An
// unlisted model is costed at a deliberately high rate so the alert errs early, never at zero.
const PRICES: Record<string, { inUsdPerMTok: number; outUsdPerMTok: number }> = {
  'claude-haiku-5-5': { inUsdPerMTok: 0.1, outUsdPerMTok: 0.5 },
  'claude-sonnet-5': { inUsdPerMTok: 3, outUsdPerMTok: 15 },
  'claude-sonnet-5-5': { inUsdPerMTok: 2, outUsdPerMTok: 10 },
};
const UNKNOWN_MODEL_PRICE = { inUsdPerMTok: 3, outUsdPerMTok: 15 };

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function estimateExitSpendUsd(db: Database.Database, nowMs: number): number {
  const day = utcDay(nowMs);
  const rows = db
    .prepare(
      `SELECT model, COALESCE(SUM(prompt_tokens), 0) AS inTok, COALESCE(SUM(output_tokens), 0) AS outTok
         FROM ai_calls WHERE stage = 'exit_review' AND substr(called_at, 1, 10) = ? GROUP BY model`
    )
    .all(day) as Array<{ model: string; inTok: number; outTok: number }>;
  return rows.reduce((total, r) => {
    const p = PRICES[r.model] ?? UNKNOWN_MODEL_PRICE;
    return total + (r.inTok / 1e6) * p.inUsdPerMTok + (r.outTok / 1e6) * p.outUsdPerMTok;
  }, 0);
}

let alertedDay: string | null = null;
export function resetExitBudgetAlertForTests(): void {
  alertedDay = null;
}

export function checkExitBudget(db: Database.Database, dailyUsdCap: number, alert: (m: string) => void, nowMs: number): void {
  try {
    const spent = estimateExitSpendUsd(db, nowMs);
    if (spent <= dailyUsdCap) return;
    const day = utcDay(nowMs);
    if (alertedDay === day) return;
    alertedDay = day;
    alert(`[EXIT-REVIEW BUDGET] estimated spend $${spent.toFixed(2)} today (UTC) is over the $${dailyUsdCap.toFixed(2)} cap. Reviews continue; raise EXIT_DAILY_USD_CAP or check the item volume.`);
  } catch (err) {
    console.error('[exit-review] budget check failed (not fatal):', err instanceof Error ? err.message : String(err));
  }
}
