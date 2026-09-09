export interface OllamaClient {
  chat(model: string, prompt: string, options?: { format?: object }): Promise<string>;
}

export function createOllamaClient(
  baseUrl: string = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
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
        throw new Error(
          `Ollama request to ${baseUrl} for model ${model} failed to connect: ${(err as Error).message}`
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama request for model ${model} failed: ${res.status} ${body}`);
      }
      const data = (await res.json()) as { message?: { content?: string } };
      if (typeof data.message?.content !== 'string') {
        throw new Error(
          `Ollama returned no message content for model ${model}: ${JSON.stringify(data)}`
        );
      }
      return data.message.content;
    },
  };
}
