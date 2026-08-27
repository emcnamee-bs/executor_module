import Anthropic from '@anthropic-ai/sdk';

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

function validateVerifyOutput(parsed: unknown): VerifyResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Sonnet returned an invalid verify output shape: ${JSON.stringify(parsed)}`);
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.supported !== 'boolean') {
    throw new Error(`Sonnet returned an invalid "supported" field: ${JSON.stringify(p.supported)}`);
  }
  if (typeof p.note !== 'string') {
    throw new Error(`Sonnet returned an invalid "note" field: ${JSON.stringify(p.note)}`);
  }
  return { supported: p.supported, note: p.note };
}

export async function verifySynopsis(
  client: Anthropic,
  headline: string,
  snippet: string | null,
  synopsis: string
): Promise<VerifyResult> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Source text:\n${sourceText}\n\nProposed synopsis:\n${synopsis}\n\nDoes this synopsis accurately represent what the source text actually says, without adding claims the source does not make? Answer supported=true only if the synopsis is a faithful, non-exaggerated summary of the source text. Explain your answer briefly in "note".`,
      },
    ],
    // NOTE: uses a raw JSON schema, not the SDK's zodOutputFormat() helper --
    // slice 2 found zodOutputFormat incompatible with this project's installed
    // zod version (a real SDK defect, see docs/superpowers/sdd ledger history
    // for slice 2). Raw schema sidesteps it entirely.
    output_config: {
      format: { type: 'json_schema', schema: VERIFY_SCHEMA },
    } as Anthropic.Messages.MessageCreateParams['output_config'],
  });

  // Extract the JSON from the response content block
  if (!response.content || response.content.length === 0) {
    throw new Error('Sonnet returned an empty response');
  }

  const contentBlock = response.content[0];
  if (contentBlock.type !== 'text') {
    throw new Error(`Sonnet returned unexpected content type: ${contentBlock.type}`);
  }

  const jsonText = contentBlock.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Failed to parse Sonnet JSON response: ${jsonText}`);
  }

  return validateVerifyOutput(parsed);
}
