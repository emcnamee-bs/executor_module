import Anthropic from '@anthropic-ai/sdk';
import type { Rung } from './rung.js';

export interface DecideResult {
  direction: 'up' | 'down';
  magnitudePts: number;
  shouldTrade: boolean;
  reasoning: string;
}

const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['up', 'down'] },
    magnitude_pts: { type: 'number' },
    should_trade: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['direction', 'magnitude_pts', 'should_trade', 'reasoning'],
  additionalProperties: false,
};

const DECIDE_CONTEXT = `You are assessing a news item for its likely effect on the U.S. President's approval rating, as measured by RealClearPolitics's polling average (a Kalshi market resolves weekly on a snapshot of this average).

Estimate:
- direction: "up" if this news plausibly pushes approval higher, "down" if lower.
- magnitude_pts: your best estimate of how many PERCENTAGE POINTS of RCP's approval average this might move, as a NON-NEGATIVE number (direction already carries the sign -- magnitude_pts is always >= 0). Typical single-item moves are small (a fraction of a point to a few points); reserve larger numbers for genuinely major news.
- should_trade: false if this item is too indirect, too old, too speculative, or otherwise not something you'd act on even if the arithmetic above looked favorable. This is your chance to veto a trade regardless of direction/magnitude.
- reasoning: a brief explanation of your judgment.

You are told the story's evidentiary rung for context only (rumor/reported/corroborated/confirmed) -- do not restate or alter it, it is not part of your output.`;

/**
 * Narrows the model's structured output to a genuine `DecideResult` before it can
 * reach the sizing/order-execution stages downstream. `parsed_output` being present
 * is not proof it has the shape we asked for -- it can be `null`, missing fields, or
 * carry a negative `magnitude_pts` (direction already carries the sign, so a negative
 * magnitude is a model error, not a valid "large downward move"). Without this check
 * bad output could flow straight into a real order.
 */
export function validateDecideOutput(parsed: unknown): DecideResult {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Sonnet returned an invalid decide output shape: ${JSON.stringify(parsed)}`);
  }
  const p = parsed as Record<string, unknown>;
  if (p.direction !== 'up' && p.direction !== 'down') {
    throw new Error(`Sonnet returned an invalid direction: ${JSON.stringify(p.direction)}`);
  }
  if (typeof p.magnitude_pts !== 'number' || !Number.isFinite(p.magnitude_pts) || p.magnitude_pts < 0) {
    throw new Error(`Sonnet returned an invalid magnitude_pts: ${JSON.stringify(p.magnitude_pts)}`);
  }
  if (typeof p.should_trade !== 'boolean') {
    throw new Error(`Sonnet returned an invalid should_trade: ${JSON.stringify(p.should_trade)}`);
  }
  if (typeof p.reasoning !== 'string' || p.reasoning.trim().length === 0) {
    throw new Error(`Sonnet returned an invalid reasoning: ${JSON.stringify(p.reasoning)}`);
  }
  return {
    direction: p.direction,
    magnitudePts: p.magnitude_pts,
    shouldTrade: p.should_trade,
    reasoning: p.reasoning,
  };
}

export async function decideTrade(
  client: Anthropic,
  headline: string,
  snippet: string | null,
  synopsis: string,
  rung: Rung
): Promise<DecideResult> {
  const sourceText = [headline, snippet].filter((s): s is string => Boolean(s)).join('\n\n');

  // NOTE: uses client.messages.parse() (not .create()) -- .parse() is what
  // actually populates response.parsed_output for structured output; this
  // was confirmed the hard way in Task 6, which originally used .create()
  // per an earlier draft of this plan and found parsed_output stayed
  // undefined. Use .parse() here from the start.
  const response = await client.messages.parse({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `${DECIDE_CONTEXT}\n\nEvidentiary rung: ${rung}\n\nSource text:\n${sourceText}\n\nSynopsis:\n${synopsis}`,
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: DECIDE_SCHEMA },
    } as Anthropic.Messages.MessageCreateParams['output_config'],
  });

  if (!response.parsed_output) {
    throw new Error('Sonnet did not return parseable structured output for the decide step');
  }

  return validateDecideOutput(response.parsed_output);
}
