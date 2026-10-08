import type Anthropic from '@anthropic-ai/sdk';
import type Database from 'better-sqlite3';
import { recordAiCall, sha12, type AiStage } from '../ailog/aiLog.js';

export const SONNET_MODEL = 'claude-sonnet-5';

export interface StructuredCall {
  client: Anthropic;
  db: Database.Database;
  trade: string;
  itemId: string | null;
  stage: AiStage;
  maxTokens: number;
  system: string;
  user: string;
  schema: object;
  excerptSource: 'page' | 'snippet' | null;
  tripwireHit: boolean;
  summarize: (parsed: unknown) => { verdict: string; reasoning: string | null };
}

/**
 * One structured Sonnet call with the three guarantees every model call in this
 * module needs: a truncation guard, a parseable-output guard, and exactly one
 * `ai_calls` row per call (including failures) written BEFORE the caller acts on the
 * result, so a crash after the model answered still leaves the evidence.
 */
export async function callStructured(call: StructuredCall): Promise<unknown> {
  const messages = [{ role: 'user' as const, content: call.user }];
  const requestJson = JSON.stringify({
    system: call.system,
    messages,
    schema: call.schema,
    max_tokens: call.maxTokens,
  });
  const base = {
    trade: call.trade,
    itemId: call.itemId,
    stage: call.stage,
    provider: 'anthropic' as const,
    model: SONNET_MODEL,
    promptSha: sha12(call.system),
    requestJson,
    excerptSource: call.excerptSource,
    tripwireHit: call.tripwireHit,
    loadMs: null,
  };
  const started = Date.now();

  let response: any;
  try {
    response = await call.client.messages.parse({
      model: SONNET_MODEL,
      max_tokens: call.maxTokens,
      ...(call.system ? { system: call.system } : {}),
      messages,
      output_config: { format: { type: 'json_schema', schema: call.schema } } as any,
    });
  } catch (err) {
    recordAiCall(call.db, {
      ...base,
      rawOutput: null,
      parsedJson: null,
      reasoning: null,
      verdict: null,
      wallMs: Date.now() - started,
      promptTokens: null,
      outputTokens: null,
      stopReason: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const text = Array.isArray(response.content)
    ? response.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
    : null;
  const parsed = response.parsed_output ?? null;
  const common = {
    ...base,
    rawOutput: text,
    parsedJson: parsed === null ? null : JSON.stringify(parsed),
    wallMs: Date.now() - started,
    promptTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    stopReason: response.stop_reason ?? null,
  };

  if (response.stop_reason === 'max_tokens') {
    const message = `Sonnet ${call.stage} response was truncated at max_tokens`;
    recordAiCall(call.db, { ...common, reasoning: null, verdict: null, error: message });
    throw new Error(message);
  }
  if (parsed === null) {
    const message = `Sonnet did not return parseable structured output for the ${call.stage} step`;
    recordAiCall(call.db, { ...common, reasoning: null, verdict: null, error: message });
    throw new Error(message);
  }

  let summary: { verdict: string; reasoning: string | null };
  try {
    summary = call.summarize(parsed);
  } catch {
    summary = { verdict: 'unsummarizable', reasoning: null };
  }
  recordAiCall(call.db, { ...common, reasoning: summary.reasoning, verdict: summary.verdict, error: null });
  return parsed;
}
