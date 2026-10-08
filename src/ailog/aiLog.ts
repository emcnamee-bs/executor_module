// src/ailog/aiLog.ts
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export type AiStage = 'build_keyphrases' | 'build_bank' | 'gate' | 'triage' | 'decide';

export interface AiCallRecord {
  trade: string;
  itemId: string | null;
  stage: AiStage;
  provider: 'ollama' | 'anthropic';
  model: string;
  promptSha: string;
  requestJson: string;
  rawOutput: string | null;
  parsedJson: string | null;
  reasoning: string | null;
  verdict: string | null;
  excerptSource: 'page' | 'snippet' | null;
  tripwireHit: boolean;
  wallMs: number | null;
  loadMs: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  error: string | null;
}

/** First 12 hex characters of sha256(text): groups AI calls by prompt version. */
export function sha12(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/**
 * Writes exactly one `ai_calls` row and returns its id. Every model call must go
 * through this, including failures (with `error` set) and calls whose result is later
 * discarded. Callers write the row BEFORE acting on the result.
 */
export function recordAiCall(db: Database.Database, rec: AiCallRecord): number {
  const info = db
    .prepare(
      `INSERT INTO ai_calls
        (trade, item_id, stage, provider, model, prompt_sha, request_json, raw_output,
         parsed_json, reasoning, verdict, excerpt_source, tripwire_hit, wall_ms, load_ms,
         prompt_tokens, output_tokens, stop_reason, error)
       VALUES
        (@trade, @itemId, @stage, @provider, @model, @promptSha, @requestJson, @rawOutput,
         @parsedJson, @reasoning, @verdict, @excerptSource, @tripwireHit, @wallMs, @loadMs,
         @promptTokens, @outputTokens, @stopReason, @error)`
    )
    .run({ ...rec, tripwireHit: rec.tripwireHit ? 1 : 0 });
  return Number(info.lastInsertRowid);
}
