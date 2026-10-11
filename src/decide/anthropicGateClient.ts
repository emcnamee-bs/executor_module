import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { recordOllamaError, tripBreaker } from './ledger.js';
import type { OllamaChatOptions, OllamaChatResult, OllamaClient } from './ollamaClient.js';

/**
 * The relevance gate can run on the local Ollama model (the default, unchanged) or on a
 * Claude model. This is the Claude side: it implements the same chat interface the gate
 * already uses, so runGate, the ai_calls log and the ollama-errors breaker keep working
 * as they are. The provider is chosen per process from GATE_PROVIDER, so a paper unit is
 * switched (and switched back) with its own env, and the live unit is untouched.
 */
export type GateProvider = 'ollama' | 'anthropic';

export const DEFAULT_GATE_ANTHROPIC_MODEL = 'claude-haiku-5-5';
/** Per trade (each trade has its own ledger), per UTC day. Haiku 5.5 costs ~$0.0002/call, so this is ~2,600 calls. */
export const DEFAULT_GATE_DAILY_USD_CAP = 0.5;

const GATE_ANTHROPIC_TIMEOUT_MS = 60_000;
const GATE_MAX_TOKENS = 1024; // adaptive thinking counts toward this; measured replies use ~90

// USD per million tokens, prompts up to 100K (the gate sends ~1.5K).
const PRICES: Record<string, { inUsdPerMTok: number; outUsdPerMTok: number }> = {
  'claude-haiku-5-5': { inUsdPerMTok: 0.1, outUsdPerMTok: 0.5 },
};
// A model with no listed price is costed at Haiku 4.5's rate, never at zero, so the cap errs high.
const UNKNOWN_MODEL_PRICE = { inUsdPerMTok: 1, outUsdPerMTok: 5 };

export interface GateConfig {
  provider: GateProvider;
  anthropicModel: string;
  dailyUsdCap: number;
}

export function resolveGateConfig(env: NodeJS.ProcessEnv): GateConfig {
  const provider = env.GATE_PROVIDER ?? 'ollama';
  if (provider !== 'ollama' && provider !== 'anthropic') {
    throw new Error(`GATE_PROVIDER must be "ollama" or "anthropic", got ${JSON.stringify(provider)}`);
  }
  const anthropicModel = env.GATE_ANTHROPIC_MODEL ?? DEFAULT_GATE_ANTHROPIC_MODEL;
  if (provider === 'anthropic' && !(anthropicModel in PRICES)) {
    throw new Error(`GATE_ANTHROPIC_MODEL ${JSON.stringify(anthropicModel)} has no known price; add it to PRICES in anthropicGateClient.ts first`);
  }
  let dailyUsdCap = DEFAULT_GATE_DAILY_USD_CAP;
  const rawCap = env.GATE_DAILY_USD_CAP;
  if (rawCap !== undefined) {
    const n = Number(rawCap);
    if (!/^[0-9]+(\.[0-9]+)?$/.test(rawCap) || !Number.isFinite(n) || n <= 0) {
      throw new Error(`GATE_DAILY_USD_CAP must be a positive number of US dollars, got ${JSON.stringify(rawCap)}`);
    }
    dailyUsdCap = n;
  }
  return { provider, anthropicModel, dailyUsdCap };
}

export function gateCostUsd(model: string, promptTokens: number, outputTokens: number): number {
  const p = PRICES[model] ?? UNKNOWN_MODEL_PRICE;
  return (promptTokens * p.inUsdPerMTok + outputTokens * p.outUsdPerMTok) / 1_000_000;
}

/** Today's (UTC) Claude gate spend recorded in THIS ledger. Local Ollama rows cost nothing and are excluded. */
export function gateSpendTodayUsd(db: Database.Database, now: Date = new Date()): number {
  const dayStart = now.toISOString().slice(0, 10); // called_at is ISO-8601 UTC, so a date prefix compares correctly
  const rows = db
    .prepare(
      `SELECT model, COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(output_tokens), 0) AS o
         FROM ai_calls
        WHERE stage = 'gate' AND provider = 'anthropic' AND called_at >= ?
        GROUP BY model`
    )
    .all(dayStart) as Array<{ model: string; p: number; o: number }>;
  return rows.reduce((sum, r) => sum + gateCostUsd(r.model, r.p, r.o), 0);
}

export interface AnthropicGateOptions {
  dailyUsdCap: number;
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

export function createAnthropicGateClient(
  anthropic: Pick<Anthropic, 'messages'>,
  db: Database.Database,
  options: AnthropicGateOptions
): OllamaClient {
  const effort = options.effort ?? 'medium';
  const timeoutMs = options.timeoutMs ?? GATE_ANTHROPIC_TIMEOUT_MS;

  function fail(model: string, message: string): never {
    recordOllamaError(db, model, message);
    throw new Error(message);
  }

  async function chatDetailed(model: string, prompt: string, chatOptions?: OllamaChatOptions): Promise<OllamaChatResult> {
    // Guardrail: fail closed on cost. Over the cap there is no API call; the breaker trips
    // (halting new decisions on this ledger and alerting a human) and the item is skipped.
    const spent = gateSpendTodayUsd(db);
    if (spent >= options.dailyUsdCap) {
      const message =
        `gate daily spend cap reached: $${spent.toFixed(4)} of $${options.dailyUsdCap.toFixed(2)} today (UTC); ` +
        `raise GATE_DAILY_USD_CAP or wait for the next UTC day, then clear the breaker`;
      tripBreaker(db, 'ollama-errors', message);
      throw new Error(message);
    }

    const started = Date.now();
    let res: any;
    try {
      res = await anthropic.messages.create(
        {
          model,
          max_tokens: GATE_MAX_TOKENS,
          ...(chatOptions?.system !== undefined ? { system: chatOptions.system } : {}),
          messages: [{ role: 'user', content: prompt }],
          // Haiku 5.5 rejects non-default sampling values, so the local gate's temperature is not forwarded.
          output_config: {
            effort,
            ...(chatOptions?.format ? { format: { type: 'json_schema', schema: chatOptions.format } } : {}),
          },
        } as any,
        { timeout: timeoutMs }
      );
    } catch (err) {
      return fail(model, `Anthropic gate request for model ${model} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
      return fail(model, `Anthropic gate request for model ${model} ended with stop_reason ${res.stop_reason}`);
    }
    const text = (res.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('');
    if (text.length === 0) {
      return fail(model, `Anthropic gate request returned no text content for model ${model}`);
    }
    return {
      content: text,
      loadMs: 0,
      promptEvalCount: res.usage?.input_tokens ?? 0,
      evalCount: res.usage?.output_tokens ?? 0,
      totalMs: Date.now() - started,
      doneReason: res.stop_reason ?? null,
    };
  }

  return {
    async chat(model, prompt, chatOptions) {
      return (await chatDetailed(model, prompt, chatOptions)).content;
    },
    chatDetailed,
  };
}
