import { describe, it, expect } from 'vitest';
import { createOllamaClient } from '../../src/decide/ollamaClient.js';
import { synopsize } from '../../src/decide/synopsis.js';

describe('synopsize (real local Qwen call)', () => {
  it('produces a non-empty summary of a headline and snippet', async () => {
    const client = createOllamaClient();
    const summary = await synopsize(
      client,
      'BLS reports unemployment rate fell to 3.9% in July',
      'The Bureau of Labor Statistics announced today that the national unemployment rate declined to 3.9%, beating economist expectations of 4.1%, driven by strong hiring in the services sector.'
    );

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
    expect(summary.toLowerCase()).toMatch(/unemploy|labor|job/);
  }, 30000);

  it('produces a summary from headline alone when snippet is null', async () => {
    const client = createOllamaClient();
    const summary = await synopsize(client, 'State Department announces new sanctions on shipping firms', null);

    expect(typeof summary).toBe('string');
    expect(summary.trim().length).toBeGreaterThan(0);
  }, 30000);
});
