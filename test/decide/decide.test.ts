import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { decideTrade, validateDecideOutput } from '../../src/decide/decide.js';

describe('decideTrade (real Sonnet call)', () => {
  it('produces a structured direction/magnitude/should_trade/reasoning judgment', async () => {
    const client = new Anthropic();
    const result = await decideTrade(
      client,
      'BLS reports unemployment rate fell to 3.9% in July, beating expectations',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July.',
      'The unemployment rate dropped to 3.9% in July, beating economist expectations of 4.1%.',
      'reported'
    );

    expect(['up', 'down']).toContain(result.direction);
    expect(typeof result.magnitudePts).toBe('number');
    expect(Number.isFinite(result.magnitudePts)).toBe(true);
    expect(result.magnitudePts).toBeGreaterThanOrEqual(0);
    expect(typeof result.shouldTrade).toBe('boolean');
    expect(typeof result.reasoning).toBe('string');
    expect(result.reasoning.trim().length).toBeGreaterThan(0);
  }, 20000);

  it('is willing to say should_trade=false for an item with no plausible bearing on presidential approval', async () => {
    const client = new Anthropic();
    const result = await decideTrade(
      client,
      'IAEA reports routine equipment maintenance completed at monitoring station',
      'The IAEA confirmed a scheduled maintenance visit to a nuclear monitoring station was completed without incident.',
      'Routine IAEA equipment maintenance was completed without incident.',
      'reported'
    );

    expect(result.shouldTrade).toBe(false);
  }, 20000);
});

describe('validateDecideOutput', () => {
  it('returns the shape unchanged for a well-formed structured output', () => {
    expect(
      validateDecideOutput({
        direction: 'up',
        magnitude_pts: 1.5,
        should_trade: true,
        reasoning: 'a plausible positive move',
      })
    ).toEqual({
      direction: 'up',
      magnitudePts: 1.5,
      shouldTrade: true,
      reasoning: 'a plausible positive move',
    });
  });

  it('accepts direction=down with should_trade=false', () => {
    expect(
      validateDecideOutput({
        direction: 'down',
        magnitude_pts: 0,
        should_trade: false,
        reasoning: 'no real bearing on the market',
      })
    ).toEqual({
      direction: 'down',
      magnitudePts: 0,
      shouldTrade: false,
      reasoning: 'no real bearing on the market',
    });
  });

  it.each([
    ['null parsed_output', null, /invalid decide output shape/],
    ['undefined parsed_output', undefined, /invalid decide output shape/],
    ['a non-object parsed_output', 'up', /invalid decide output shape/],
    [
      'a missing direction field',
      { magnitude_pts: 1, should_trade: true, reasoning: 'x' },
      /invalid direction/,
    ],
    [
      'a wrong-typed direction field',
      { direction: 'sideways', magnitude_pts: 1, should_trade: true, reasoning: 'x' },
      /invalid direction/,
    ],
    [
      'a missing magnitude_pts field',
      { direction: 'up', should_trade: true, reasoning: 'x' },
      /invalid magnitude_pts/,
    ],
    [
      'a wrong-typed magnitude_pts field',
      { direction: 'up', magnitude_pts: '1', should_trade: true, reasoning: 'x' },
      /invalid magnitude_pts/,
    ],
    [
      'a negative magnitude_pts (direction already carries the sign)',
      { direction: 'up', magnitude_pts: -1, should_trade: true, reasoning: 'x' },
      /invalid magnitude_pts/,
    ],
    [
      'a non-finite magnitude_pts',
      { direction: 'up', magnitude_pts: Infinity, should_trade: true, reasoning: 'x' },
      /invalid magnitude_pts/,
    ],
    [
      'a NaN magnitude_pts',
      { direction: 'up', magnitude_pts: NaN, should_trade: true, reasoning: 'x' },
      /invalid magnitude_pts/,
    ],
    [
      'a missing should_trade field',
      { direction: 'up', magnitude_pts: 1, reasoning: 'x' },
      /invalid should_trade/,
    ],
    [
      'a wrong-typed should_trade field',
      { direction: 'up', magnitude_pts: 1, should_trade: 'true', reasoning: 'x' },
      /invalid should_trade/,
    ],
    [
      'a missing reasoning field',
      { direction: 'up', magnitude_pts: 1, should_trade: true },
      /invalid reasoning/,
    ],
    [
      'a wrong-typed reasoning field',
      { direction: 'up', magnitude_pts: 1, should_trade: true, reasoning: 42 },
      /invalid reasoning/,
    ],
    [
      'an empty reasoning field',
      { direction: 'up', magnitude_pts: 1, should_trade: true, reasoning: '   ' },
      /invalid reasoning/,
    ],
  ])('throws on %s rather than returning garbage a decision could act on', (_label, value, expected) => {
    expect(() => validateDecideOutput(value)).toThrow(expected);
  });
});
