import { describe, it, expect } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { refineKeyphrases } from '../../src/keyphrases/generate.js';

describe('refineKeyphrases (real Sonnet call)', () => {
  it('returns a non-empty list of >=2-word phrase strings given a small seed list', async () => {
    const client = new Anthropic();
    const result = await refineKeyphrases(client, ['trump approval rating']);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    for (const phrase of result) {
      expect(typeof phrase).toBe('string');
      expect(phrase.trim().split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(2);
    }
  }, 30000);

  it('returns a non-empty list when starting from an empty seed list', async () => {
    const client = new Anthropic();
    const result = await refineKeyphrases(client, []);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  }, 30000);
});

describe('refineKeyphrases (failure path)', () => {
  it('rejects when the Anthropic client is misconfigured, so main() would never call saveKeyphrases', async () => {
    const client = new Anthropic({ apiKey: 'sk-ant-invalid-test-key-000000000000000000' });
    await expect(refineKeyphrases(client, ['trump approval rating'])).rejects.toThrow();
  }, 30000);
});
