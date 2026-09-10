import type Database from 'better-sqlite3';
import { recordOllamaError } from './ledger.js';

export interface OllamaClient {
  chat(model: string, prompt: string, options?: { format?: object }): Promise<string>;
}

export function createOllamaClient(
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
  db?: Database.Database
): OllamaClient {
  return {
    async chat(model, prompt, options) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            ...(options?.format ? { format: options.format } : {}),
          }),
        });
      } catch (err) {
        const message = `Ollama request to ${baseUrl} for model ${model} failed to connect: ${(err as Error).message}`;
        if (db) recordOllamaError(db, model, message);
        throw new Error(message);
      }
      if (!res.ok) {
        const body = await res.text();
        const message = `Ollama request for model ${model} failed: ${res.status} ${body}`;
        if (db) recordOllamaError(db, model, message);
        throw new Error(message);
      }
      let data: { message?: { content?: string } };
      try {
        data = (await res.json()) as { message?: { content?: string } };
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
      return data.message.content;
    },
  };
}
