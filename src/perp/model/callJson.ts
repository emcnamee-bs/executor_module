// src/perp/model/callJson.ts
import type Database from 'better-sqlite3';
import type { ZodType } from 'zod';

export class SpendCapError extends Error {}

// USD per million tokens. An unlisted model is costed high so the cap errs early, never at zero.
export const MODEL_PRICES: Record<string, { inUsdPerMTok: number; outUsdPerMTok: number }> = {
  'claude-haiku-5-5': { inUsdPerMTok: 0.1, outUsdPerMTok: 0.5 },
  'claude-sonnet-5-5': { inUsdPerMTok: 2, outUsdPerMTok: 10 },
};
const UNKNOWN_PRICE = { inUsdPerMTok: 3, outUsdPerMTok: 15 };

export function modelCostUsd(model: string, inTok: number, outTok: number): number {
  const p = MODEL_PRICES[model] ?? UNKNOWN_PRICE;
  return (inTok * p.inUsdPerMTok + outTok * p.outUsdPerMTok) / 1_000_000;
}

export function ensureModelCallsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      called_at_ms INTEGER NOT NULL,
      stage TEXT NOT NULL,
      model TEXT NOT NULL,
      item_id TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS model_calls_ts ON model_calls (called_at_ms);
  `);
}

/** Model spend recorded so far on the UTC day containing `nowMs`. */
export function modelSpendTodayUsd(db: Database.Database, nowMs: number): number {
  ensureModelCallsTable(db);
  const dayStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM model_calls WHERE called_at_ms >= ? AND called_at_ms < ?')
    .get(dayStart, dayStart + 86_400_000) as { s: number };
  return row.s;
}

export interface CallJsonArgs<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: { messages: { create: (...args: any[]) => Promise<any> } };
  db: Database.Database;
  model: string;
  stage: string;
  itemId: string | null;
  system: string;
  user: string;
  jsonSchema: object;
  schema: ZodType<T>;
  maxTokens: number;
  dailyUsdCap: number;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * One structured model call: fails closed over the daily cap (no request), validates the reply against a zod
 * schema, and writes exactly one `model_calls` row per attempted request (ok or error) before returning/throwing.
 */
export async function callJson<T>(a: CallJsonArgs<T>): Promise<T> {
  ensureModelCallsTable(a.db);
  const now = a.now ?? (() => Date.now());
  if (!Number.isFinite(a.dailyUsdCap) || a.dailyUsdCap <= 0) {
    throw new SpendCapError(`invalid daily cap ${String(a.dailyUsdCap)}: must be a finite number > 0`);
  }
  const spent = modelSpendTodayUsd(a.db, now());
  if (!(spent < a.dailyUsdCap)) {
    throw new SpendCapError(`model daily spend cap reached: $${spent.toFixed(4)} of $${a.dailyUsdCap.toFixed(2)} today (UTC)`);
  }

  let inTok = 0;
  let outTok = 0;
  const record = (ok: boolean, error: string | null): void => {
    a.db
      .prepare(
        'INSERT INTO model_calls (called_at_ms, stage, model, item_id, prompt_tokens, output_tokens, cost_usd, ok, error) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      .run(now(), a.stage, a.model, a.itemId, inTok, outTok, modelCostUsd(a.model, inTok, outTok), ok ? 1 : 0, error);
  };

  try {
    const res = await a.client.messages.create(
      {
        model: a.model,
        max_tokens: a.maxTokens,
        system: a.system,
        messages: [{ role: 'user', content: a.user }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: a.jsonSchema } },
      },
      { timeout: a.timeoutMs ?? 60_000 }
    );
    inTok = res?.usage?.input_tokens ?? 0;
    outTok = res?.usage?.output_tokens ?? 0;
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      throw new Error(`model reply ended with stop_reason ${res.stop_reason}`);
    }
    const text = ((res.content ?? []) as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (text.length === 0) throw new Error('model reply had no text content');
    const parsed = a.schema.parse(JSON.parse(text));
    record(true, null);
    return parsed;
  } catch (err) {
    record(false, (err instanceof Error ? err.message : String(err)).slice(0, 500));
    throw err;
  }
}
