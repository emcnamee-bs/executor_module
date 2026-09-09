import type { OllamaClient } from './ollamaClient.js';

export interface VerifyResult {
  supported: boolean;
  note: string;
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['supported', 'note'],
  additionalProperties: false,
};

export function validateVerifyOutput(parsed: unknown): VerifyResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Local model returned an invalid verify output shape: ${JSON.stringify(parsed)}`);
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.supported !== 'boolean') {
    throw new Error(`Local model returned an invalid "supported" field: ${JSON.stringify(p.supported)}`);
  }
  if (typeof p.note !== 'string') {
    throw new Error(`Local model returned an invalid "note" field: ${JSON.stringify(p.note)}`);
  }
  return { supported: p.supported, note: p.note };
}

export async function verifySynopsis(
  client: OllamaClient,
  headline: string,
  snippet: string | null,
  synopsis: string
): Promise<VerifyResult> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const content = await client.chat(
    'qwen2.5:7b-instruct-q4_K_M',
    `Source text:\n${sourceText}\n\nProposed synopsis:\n${synopsis}\n\nDoes this synopsis accurately represent what the source text actually says, without adding claims the source does not make? Answer supported=true only if the synopsis is a faithful, non-exaggerated summary of the source text. Explain your answer briefly in "note".`,
    { format: VERIFY_SCHEMA }
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Local model did not return parseable JSON for verification: ${content}`);
  }

  return validateVerifyOutput(parsed);
}
