import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { verifySynopsis, validateVerifyOutput } from '../../src/decide/verify.js';

describe('verifySynopsis (real Sonnet call)', () => {
  it('supports a faithful synopsis of the source text', async () => {
    const client = new Anthropic();
    const result = await verifySynopsis(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July, beating expectations.',
      'The unemployment rate dropped to 3.9% in July, according to new BLS data, coming in better than economists expected.'
    );

    expect(result.supported).toBe(true);
    expect(typeof result.note).toBe('string');
  }, 20000);

  it('rejects a synopsis that fabricates a claim the source does not make', async () => {
    const client = new Anthropic();
    const result = await verifySynopsis(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced the national unemployment rate declined to 3.9% in July.',
      'The President announced a major new stimulus package to combat unemployment, sources say.'
    );

    expect(result.supported).toBe(false);
  }, 20000);
});

describe('validateVerifyOutput', () => {
  it('returns the shape unchanged for a well-formed structured output', () => {
    expect(validateVerifyOutput({ supported: true, note: 'faithful summary' })).toEqual({
      supported: true,
      note: 'faithful summary',
    });
  });

  it('accepts supported=false with a note', () => {
    expect(validateVerifyOutput({ supported: false, note: 'fabricated claim' })).toEqual({
      supported: false,
      note: 'fabricated claim',
    });
  });

  it.each([
    ['null parsed_output', null, /invalid verify output shape/],
    ['undefined parsed_output', undefined, /invalid verify output shape/],
    ['a non-object parsed_output', 'supported', /invalid verify output shape/],
    ['a missing supported field', { note: 'no supported field' }, /invalid "supported" field/],
    [
      'a wrong-typed supported field',
      { supported: 'true', note: 'a string, not a boolean' },
      /invalid "supported" field/,
    ],
    ['a missing note field', { supported: true }, /invalid "note" field/],
    [
      'a wrong-typed note field',
      { supported: true, note: 42 },
      /invalid "note" field/,
    ],
  ])('throws on %s rather than returning garbage a decision could act on', (_label, value, expected) => {
    expect(() => validateVerifyOutput(value)).toThrow(expected);
  });
});
