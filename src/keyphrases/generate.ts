import Anthropic from '@anthropic-ai/sdk';
import { loadKeyphrases, saveKeyphrases, DEFAULT_KEYPHRASES_PATH } from './list.js';

const MARKET_CONTEXT = `This keyphrase list is used to scan a live news stream for items relevant to the Kalshi market series KXAPRPOTUS ("President RCP approval rating this week"). Each weekly event in this series resolves based on a SNAPSHOT of the President's approval rating as displayed on RealClearPolitics's approval-rating aggregate page (realclearpolling.com/polls/approval/donald-trump/approval-rating), read at a fixed moment (11:00 AM ET on the resolution date). This is not a subjective judgment of the president's standing -- it is literally whatever number that page shows at that instant.

Because of this, TWO categories of news matter equally (do not rank one above the other):
1. Individual poll publications that would feed directly into that RCP average (e.g. a new Rasmussen, Quinnipiac, Economist/YouGov, Morning Consult, or similar poll on presidential approval being released).
2. General political and economic news that could plausibly shift how people respond to approval polls taken in the following days (e.g. major policy actions, economic data releases, significant scandals or controversies, foreign policy developments).

Every keyphrase must be at least 2 words long -- a single word like "Trump" or "poll" would match nearly every news item and produce useless noise. Prefer specific, multi-word phrases that would plausibly appear verbatim in a real news headline or opening sentence (e.g. "Trump approval rating", "new Rasmussen poll", "job approval numbers"), not generic single concepts.`;

// Define the JSON schema directly for structured output
const KEYPHRASE_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    keyphrases: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['keyphrases'],
  additionalProperties: false,
};

export async function refineKeyphrases(
  client: Anthropic,
  currentPhrases: string[]
): Promise<string[]> {
  const response = await client.messages.parse({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    output_config: {
      format: {
        type: 'json_schema',
        schema: KEYPHRASE_JSON_SCHEMA,
      } as any,
    },
    messages: [
      {
        role: 'user',
        content: `${MARKET_CONTEXT}\n\nHere is the current keyphrase list (may be empty on first run):\n${JSON.stringify(currentPhrases, null, 2)}\n\nRevise and extend this list. Keep phrases that are still relevant, remove ones that are stale or too generic, and add new ones you think are missing. Return the complete revised list, not just additions.`,
      },
    ],
  });

  if (!response.parsed_output) {
    throw new Error('Sonnet did not return parseable structured output for the keyphrase list');
  }

  return (response.parsed_output as any).keyphrases;
}

// Intended schedule (NOT installed by this slice -- see
// docs/superpowers/specs/2026-08-24-keyphrase-matching-design.md):
//   Daily via cron, e.g.:
//     0 6 * * * cd /path/to/executor_module && npm run generate-keyphrases >> logs/keyphrases.log 2>&1
//   Or an equivalent systemd timer unit calling the same command once a day.
async function main(): Promise<void> {
  const client = new Anthropic();
  const currentPhrases = loadKeyphrases(DEFAULT_KEYPHRASES_PATH);

  let refined: string[];
  try {
    refined = await refineKeyphrases(client, currentPhrases);
  } catch (err) {
    console.error('[generate-keyphrases] failed, leaving existing list untouched:', err);
    process.exit(1);
    return;
  }

  saveKeyphrases(DEFAULT_KEYPHRASES_PATH, refined);
  console.log(`[generate-keyphrases] wrote ${refined.length} phrases to ${DEFAULT_KEYPHRASES_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
