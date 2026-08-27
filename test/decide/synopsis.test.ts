import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { synopsize } from '../../src/decide/synopsis.js';

describe('synopsize (real Haiku call)', () => {
  it('produces a non-empty summary of a headline and snippet', async () => {
    const client = new Anthropic();
    const summary = await synopsize(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced today that the national unemployment rate declined to 3.9%, beating economist expectations of 4.1%, driven by strong hiring in the services sector.'
    );

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
    expect(summary.toLowerCase()).toMatch(/unemploy|labor|job/);
  }, 20000);

  it('produces a summary from headline alone when snippet is null', async () => {
    const client = new Anthropic();
    const summary = await synopsize(client, 'State Department announces new sanctions on shipping firms', null);

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
  }, 20000);
});
