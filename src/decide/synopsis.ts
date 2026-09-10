import type { OllamaClient } from './ollamaClient.js';

export async function synopsize(
  client: OllamaClient,
  headline: string,
  snippet: string | null
): Promise<string> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const content = await client.chat(
    'qwen2.5:3b-instruct-q4_K_M',
    `Summarize what this news item is actually about, in 2-3 plain sentences. Do not speculate beyond what the text says, and do not add commentary about its significance.\n\n${sourceText}`
  );

  const summary = content.trim();
  if (summary.length === 0) {
    throw new Error('Local model returned an empty synopsis');
  }
  return summary;
}
