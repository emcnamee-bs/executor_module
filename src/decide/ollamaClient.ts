import type Database from 'better-sqlite3';
import { recordOllamaError } from './ledger.js';

export interface OllamaChatOptions {
  /** JSON schema (or "json") that constrains the model's output. */
  format?: object;
  /** Optional system message, sent first. */
  system?: string;
  temperature?: number;
  /** Context window in tokens (Ollama `num_ctx`). */
  numCtx?: number;
  /** Maximum tokens to generate (Ollama `num_predict`). */
  numPredict?: number;
  /** How long Ollama keeps the model loaded: a duration string like "10m", or seconds (0 unloads at once). */
  keepAlive?: string | number;
  /** Set false for qwen3-family models, which otherwise emit a (slow) thinking trace. */
  think?: boolean;
}

export interface OllamaChatResult {
  content: string;
  loadMs: number;
  promptEvalCount: number;
  evalCount: number;
  totalMs: number;
  doneReason: string | null;
}

export interface OllamaClient {
  chat(model: string, prompt: string, options?: { format?: object }): Promise<string>;
  chatDetailed(model: string, prompt: string, options?: OllamaChatOptions): Promise<OllamaChatResult>;
}

interface OllamaChatResponse {
  message?: { content?: string };
  load_duration?: number;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

const NANOS_PER_MS = 1_000_000;

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** Bound on the startup /api/tags probe (a local, instant call when Ollama is healthy). */
const TAGS_TIMEOUT_MS = 10_000;

/**
 * Startup check (final review I6): the profile's gate model must already be pulled.
 * Without it every gated item gets a 404, each one an Ollama error, and five of those
 * trip the ollama-errors breaker. Refuse to start instead, naming the fix. Fails closed
 * when Ollama cannot be asked at all.
 */
export async function assertOllamaModelAvailable(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  let names: string[];
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    names = (data.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => typeof n === 'string');
  } catch (err) {
    throw new Error(
      `refusing to start: could not list Ollama models at ${baseUrl}/api/tags to confirm gate model ${model}: ${(err as Error).message}`
    );
  }
  const wanted = model.includes(':') ? [model] : [model, `${model}:latest`];
  if (!names.some((n) => wanted.includes(n))) {
    throw new Error(
      `refusing to start: gate model ${model} is not available in Ollama at ${baseUrl}; run \`ollama pull ${model}\` on this host first`
    );
  }
}

export function createOllamaClient(
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
  db?: Database.Database
): OllamaClient {
  async function chatDetailed(
    model: string,
    prompt: string,
    options?: OllamaChatOptions
  ): Promise<OllamaChatResult> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (options?.system !== undefined) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });

    const ollamaOptions: Record<string, number> = {};
    if (options?.temperature !== undefined) ollamaOptions.temperature = options.temperature;
    if (options?.numCtx !== undefined) ollamaOptions.num_ctx = options.numCtx;
    if (options?.numPredict !== undefined) ollamaOptions.num_predict = options.numPredict;

    const body = {
      model,
      messages,
      stream: false,
      ...(options?.format ? { format: options.format } : {}),
      ...(Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
      ...(options?.keepAlive !== undefined ? { keep_alive: options.keepAlive } : {}),
      ...(options?.think !== undefined ? { think: options.think } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = `Ollama request to ${baseUrl} for model ${model} failed to connect: ${(err as Error).message}`;
      if (db) recordOllamaError(db, model, message);
      throw new Error(message);
    }
    if (!res.ok) {
      const text = await res.text();
      const message = `Ollama request for model ${model} failed: ${res.status} ${text}`;
      if (db) recordOllamaError(db, model, message);
      throw new Error(message);
    }
    let data: OllamaChatResponse;
    try {
      data = (await res.json()) as OllamaChatResponse;
    } catch (err) {
      const message = `Ollama returned a non-JSON response body for model ${model}: ${(err as Error).message}`;
      if (db) recordOllamaError(db, model, message);
      throw new Error(message);
    }
    if (typeof data.message?.content !== 'string') {
      const message = `Ollama returned no message content for model ${model}: ${JSON.stringify(data)}`;
      if (db) recordOllamaError(db, model, message);
      throw new Error(message);
    }
    return {
      content: data.message.content,
      loadMs: Math.round((data.load_duration ?? 0) / NANOS_PER_MS),
      promptEvalCount: data.prompt_eval_count ?? 0,
      evalCount: data.eval_count ?? 0,
      totalMs: Math.round((data.total_duration ?? 0) / NANOS_PER_MS),
      doneReason: data.done_reason ?? null,
    };
  }

  return {
    async chat(model, prompt, options) {
      return (await chatDetailed(model, prompt, options)).content;
    },
    chatDetailed,
  };
}
