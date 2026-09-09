import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { createOllamaClient } from '../../src/decide/ollamaClient.js';

describe('createOllamaClient (real local Ollama call)', () => {
  it('returns the model\'s text content for a plain prompt', async () => {
    const client = createOllamaClient();
    const content = await client.chat(
      'qwen2.5:3b-instruct-q4_K_M',
      'Reply with exactly the word: PONG'
    );
    expect(typeof content).toBe('string');
    expect(content.trim().length).toBeGreaterThan(0);
  }, 30000);

  it('honors a JSON format constraint and returns parseable JSON text', async () => {
    const client = createOllamaClient();
    const content = await client.chat(
      'qwen2.5:7b-instruct-q4_K_M',
      'Return a JSON object describing whether 2+2=4 is true, with a boolean field "correct" and a string field "note".',
      {
        format: {
          type: 'object',
          properties: { correct: { type: 'boolean' }, note: { type: 'string' } },
          required: ['correct', 'note'],
          additionalProperties: false,
        },
      }
    );
    const parsed = JSON.parse(content);
    expect(typeof parsed.correct).toBe('boolean');
    expect(typeof parsed.note).toBe('string');
  }, 30000);

  it('throws loudly, naming the model, when the model does not exist', async () => {
    const client = createOllamaClient();
    await expect(
      client.chat('this-model-definitely-does-not-exist:latest', 'hello')
    ).rejects.toThrow(/this-model-definitely-does-not-exist/);
  }, 30000);

  it('throws loudly when the base URL is unreachable', async () => {
    const client = createOllamaClient('http://127.0.0.1:1');
    await expect(client.chat('qwen2.5:3b-instruct-q4_K_M', 'hello')).rejects.toThrow();
  }, 10000);

  it('throws naming Ollama and the model when the response body is not JSON', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>not json</html>');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const client = createOllamaClient(`http://127.0.0.1:${port}`);
      await expect(client.chat('qwen2.5:3b-instruct-q4_K_M', 'hello')).rejects.toThrow(
        /non-JSON response body for model qwen2.5:3b-instruct-q4_K_M/
      );
    } finally {
      server.close();
    }
  });
});
