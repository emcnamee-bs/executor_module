import Anthropic from '@anthropic-ai/sdk';
import { loadKeyphrases, saveKeyphrases, DEFAULT_KEYPHRASES_PATH } from './list.js';

const APPROVAL_INTRO = `This keyphrase list is used to scan a live news stream for items relevant to the Kalshi market series KXAPRPOTUS ("President RCP approval rating this week"). Each weekly event in this series resolves based on a SNAPSHOT of the President's approval rating as displayed on RealClearPolitics's approval-rating aggregate page (realclearpolling.com/polls/approval/donald-trump/approval-rating), read at a fixed moment (11:00 AM ET on the resolution date). This is not a subjective judgment of the president's standing -- it is literally whatever number that page shows at that instant.

Because of this, TWO categories of news matter equally (do not rank one above the other):
1. Individual poll publications that would feed directly into that RCP average (e.g. a new Rasmussen, Quinnipiac, Economist/YouGov, Morning Consult, or similar poll on presidential approval being released).
2. General political and economic news that could plausibly shift how people respond to approval polls taken in the following days (e.g. major policy actions, economic data releases, significant scandals or controversies, foreign policy developments).`;

export const KEYPHRASE_RULES = `Every keyphrase must be at least 2 words long -- a single word like "Trump" or "poll" would match nearly every news item and produce useless noise. Prefer specific, multi-word phrases that would plausibly appear verbatim in a real news headline or opening sentence (e.g. "Trump approval rating", "new Rasmussen poll", "job approval numbers"), not generic single concepts.

HOW PHRASES ARE MATCHED: case-insensitive, whole words, and the words must appear CONTIGUOUSLY and in order in the item's title or first paragraph. A phrase no headline would ever contain verbatim is dead weight, so every phrase must be something a real headline or release page would actually say.`;

const MARKET_CONTEXT = APPROVAL_INTRO + '\n\n' + KEYPHRASE_RULES;

const LIST_SIZE_AND_STYLE = `SIZE AND STYLE OF THE LIST:
- Return at least 200 phrases (aim for 250 to 350). Coverage matters more than brevity: a missed poll release is a missed trade, while a stray extra match only costs a cheap downstream filter.
- Be verbose in VARIETY, not padding. Cover each topic in several distinct phrasings: the way a headline writer would put it, the way a poll-release page title would put it (pollster plus "poll" plus dates or "approval" wording), and the way a wire-service opening sentence would put it.
- Mix lengths: keep the short 2-word anchors, and add many more specific 3 to 5 word phrases (e.g. "Economist/YouGov poll shows approval", "job approval rating among independents", "approval rating hits new low").
- Cover every major pollster and aggregator by name (including Economist/YouGov, Gallup, Quinnipiac, Emerson, Rasmussen, Morning Consult, Reuters/Ipsos, AP-NORC, TIPP, Silver Bulletin, RealClearPolitics, Marquette, Harvard-Harris, Atlas Intel, Echelon, Pew, Fox, CNN, NBC, CBS) combined with approval/disapproval/job-performance wording.
- Cover subgroup and issue-approval phrasings (independents, Republicans, Democrats, swing voters, economy, inflation, immigration, foreign policy, Iran, tariffs) and movement words (slips, climbs, hits new low, rebounds, steady, underwater, net approval).
- Do not drop a phrase merely because it is long; only drop ones that are stale, near-duplicates, or would match unrelated news.`;

/**
 * Market-neutral counterparts of KEYPHRASE_RULES and LIST_SIZE_AND_STYLE, used for every
 * trade other than the approval market. The approval versions above name RealClearPolitics,
 * pollsters and approval wording; sending those to Sonnet for a gas-price or CPI market
 * would steer its list toward the wrong subject.
 */
export const GENERIC_KEYPHRASE_RULES = `Every keyphrase must be at least 2 words long -- a single word would match nearly every news item and produce useless noise. Prefer specific, multi-word phrases that would plausibly appear verbatim in a real news headline or opening sentence, not generic single concepts.

HOW PHRASES ARE MATCHED: case-insensitive, whole words, and the words must appear CONTIGUOUSLY and in order in the item's title or first paragraph. A phrase no headline would ever contain verbatim is dead weight, so every phrase must be something a real headline or release page would actually say.`;

export const GENERIC_LIST_SIZE_AND_STYLE = `SIZE AND STYLE OF THE LIST:
- Return at least 200 phrases (aim for 250 to 350). Coverage matters more than brevity: a missed relevant news item is a missed trade, while a stray extra match only costs a cheap downstream filter.
- Be verbose in VARIETY, not padding. Cover each topic in several distinct phrasings: the way a headline writer would put it, the way a data-release or agency page title would put it, and the way a wire-service opening sentence would put it.
- Mix lengths: keep the short 2-word anchors, and add many more specific 3 to 5 word phrases.
- Cover the named sources, agencies, indices and data releases that publish or move the quantity this market settles on, combined with the wording a headline would use for rises, falls and surprises.
- Cover the drivers of the quantity (supply, demand, policy, scheduled releases, geopolitics, weather, or whatever genuinely moves it) in several phrasings each, including news that never names the quantity itself.
- Do not drop a phrase merely because it is long; only drop ones that are stale, near-duplicates, or would match unrelated news.`;

// Define the JSON schema directly for structured output
export const KEYPHRASE_JSON_SCHEMA = {
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

/**
 * Narrows the model's structured output to a genuine `string[]` before anything can
 * write it to `data/keyphrases.json` — the file the ENTIRE consumer pipeline loads at
 * startup. `parsed_output` being present is not proof it has the shape we asked for
 * (it can be `null`, be missing `keyphrases`, or carry non-string elements). Without
 * this check the generator would happily persist garbage, and the failure would only
 * surface later, far from its cause, as a `loadKeyphrases()` throw against a
 * git-tracked file.
 */
export function validateKeyphraseOutput(parsedOutput: unknown): string[] {
  const invalid = (): never => {
    throw new Error(
      `Sonnet returned an invalid keyphrase list shape: ${JSON.stringify(parsedOutput)}`
    );
  };

  if (parsedOutput === null || typeof parsedOutput !== 'object') {
    return invalid();
  }

  const keyphrases = (parsedOutput as { keyphrases?: unknown }).keyphrases;
  if (!Array.isArray(keyphrases)) {
    return invalid();
  }
  if (!keyphrases.every((entry) => typeof entry === 'string')) {
    return invalid();
  }

  return keyphrases as string[];
}

export function dedupeKeyphrases(phrases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phrases) {
    const phrase = raw.trim();
    const key = phrase.toLowerCase().replace(/\s+/g, ' ');
    if (phrase.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
  }
  return out;
}

/** The size/style text defaults to the approval market's; pass GENERIC_LIST_SIZE_AND_STYLE for any other trade. */
export function buildKeyphrasePrompt(
  marketContext: string,
  currentPhrases: string[],
  sizeAndStyle: string = LIST_SIZE_AND_STYLE
): string {
  return `${marketContext}\n\n${sizeAndStyle}\n\nHere is the current keyphrase list (may be empty on first run):\n${JSON.stringify(currentPhrases, null, 2)}\n\nRevise and extend this list. Keep phrases that are still relevant, remove ones that are stale or too generic, and add new ones you think are missing. Return the complete revised list, not just additions.`;
}

export async function refineKeyphrases(
  client: Anthropic,
  currentPhrases: string[],
  marketContext?: string
): Promise<string[]> {
  const response = await client.messages.parse({
    model: 'claude-sonnet-5',
    max_tokens: 8192,
    output_config: {
      format: {
        type: 'json_schema',
        schema: KEYPHRASE_JSON_SCHEMA,
      } as any,
    },
    messages: [
      {
        role: 'user',
        content:
          marketContext === undefined
            ? buildKeyphrasePrompt(MARKET_CONTEXT, currentPhrases)
            : buildKeyphrasePrompt(marketContext, currentPhrases, GENERIC_LIST_SIZE_AND_STYLE),
      },
    ],
  });

  if (response.stop_reason === 'max_tokens') {
    throw new Error('Sonnet keyphrase response was truncated at max_tokens');
  }
  if (!response.parsed_output) {
    throw new Error('Sonnet did not return parseable structured output for the keyphrase list');
  }

  return dedupeKeyphrases(validateKeyphraseOutput(response.parsed_output));
}

/**
 * The generator's actual control flow, in a testable function rather than only inside
 * an unexported `main()`: load the current list, refine it, and write the result back
 * ONLY if refinement succeeded. The write-skipping guarantee ("on any failure, leave
 * `data/keyphrases.json` untouched") lives here so a test can drive it and assert the
 * file is byte-identical afterwards — deleting the `catch` or hoisting
 * `saveKeyphrases` above it must turn a test red, not slip through.
 *
 * Deliberately does not call `process.exit` — the CLI entrypoint owns that.
 */
export async function runGenerator(
  client: Anthropic,
  filePath: string
): Promise<{ success: boolean; error?: unknown; count?: number }> {
  const currentPhrases = loadKeyphrases(filePath);

  let refined: string[];
  try {
    refined = await refineKeyphrases(client, currentPhrases);
  } catch (err) {
    return { success: false, error: err };
  }

  saveKeyphrases(filePath, refined);
  return { success: true, count: refined.length };
}

// Intended schedule (NOT installed by this slice -- see
// docs/superpowers/specs/2026-08-24-keyphrase-matching-design.md):
//   Daily via cron, e.g.:
//     0 6 * * * cd /path/to/executor_module && npm run generate-keyphrases >> logs/keyphrases.log 2>&1
//   Or an equivalent systemd timer unit calling the same command once a day.
async function main(): Promise<void> {
  const client = new Anthropic();
  const result = await runGenerator(client, DEFAULT_KEYPHRASES_PATH);

  if (!result.success) {
    console.error(
      '[generate-keyphrases] failed, leaving existing list untouched:',
      result.error
    );
    process.exit(1);
    return;
  }

  console.log(`[generate-keyphrases] wrote ${result.count} phrases to ${DEFAULT_KEYPHRASES_PATH}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
