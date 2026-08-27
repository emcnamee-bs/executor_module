import Anthropic from '@anthropic-ai/sdk';

export async function synopsize(
  client: Anthropic,
  headline: string,
  snippet: string | null
): Promise<string> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Summarize what this news item is actually about, in 2-3 plain sentences. Do not speculate beyond what the text says, and do not add commentary about its significance.\n\n${sourceText}`,
      },
    ],
  });

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text'
  );
  if (!textBlock) {
    throw new Error('Haiku returned no text content for the synopsis');
  }
  const summary = textBlock.text.trim();
  if (summary.length === 0) {
    throw new Error('Haiku returned an empty synopsis');
  }
  return summary;
}
