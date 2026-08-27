import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { verifySynopsis } from '../../src/decide/verify.js';

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
