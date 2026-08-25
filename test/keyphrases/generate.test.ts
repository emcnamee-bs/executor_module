import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  refineKeyphrases,
  runGenerator,
  validateKeyphraseOutput,
} from '../../src/keyphrases/generate.js';

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
  it('rejects when the Anthropic client is misconfigured', async () => {
    const client = new Anthropic({ apiKey: 'sk-ant-invalid-test-key-000000000000000000' });
    await expect(refineKeyphrases(client, ['trump approval rating'])).rejects.toThrow();
  }, 30000);
});

describe('validateKeyphraseOutput', () => {
  it('returns the array unchanged for a well-formed structured output', () => {
    expect(validateKeyphraseOutput({ keyphrases: ['trump approval rating', 'new poll'] })).toEqual([
      'trump approval rating',
      'new poll',
    ]);
  });

  it('accepts an empty keyphrases array', () => {
    expect(validateKeyphraseOutput({ keyphrases: [] })).toEqual([]);
  });

  it.each([
    ['null parsed_output', null],
    ['undefined parsed_output', undefined],
    ['a non-object parsed_output', 'keyphrases'],
    ['a missing keyphrases key', { phrases: ['trump approval rating'] }],
    ['keyphrases that is not an array', { keyphrases: 'trump approval rating' }],
    ['keyphrases containing a number', { keyphrases: ['trump approval rating', 42] }],
    ['keyphrases containing null', { keyphrases: [null] }],
    ['keyphrases containing a nested object', { keyphrases: [{ phrase: 'trump approval rating' }] }],
  ])('throws on %s rather than returning garbage a write could persist', (_label, value) => {
    expect(() => validateKeyphraseOutput(value)).toThrow(
      /invalid keyphrase list shape/
    );
  });
});

describe('runGenerator (write-guard control flow)', () => {
  function tempListFile(phrases: string[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'generate-test-'));
    const file = path.join(dir, 'keyphrases.json');
    writeFileSync(file, JSON.stringify(phrases, null, 2) + '\n', 'utf-8');
    return file;
  }

  it('leaves the keyphrase file BYTE-IDENTICAL when refinement fails', async () => {
    const file = tempListFile(['trump approval rating']);
    const before = readFileSync(file, 'utf-8');

    const client = new Anthropic({ apiKey: 'sk-ant-invalid-test-key-000000000000000000' });
    const result = await runGenerator(client, file);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    const after = readFileSync(file, 'utf-8');
    expect(after).toBe(before);
    expect(after).toBe(JSON.stringify(['trump approval rating'], null, 2) + '\n');
  }, 30000);

  // The counterpart that makes the test above mean something: without it, a
  // runGenerator that never wrote anything at all would still pass "file untouched".
  it('does write the refined list to the file on success (real Sonnet call)', async () => {
    const file = tempListFile(['trump approval rating']);

    const client = new Anthropic();
    const result = await runGenerator(client, file);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    const written = JSON.parse(readFileSync(file, 'utf-8'));
    expect(Array.isArray(written)).toBe(true);
    // Seeded with exactly one phrase; the refine prompt asks Sonnet to extend the
    // list, so anything past 1 proves the file was genuinely rewritten.
    expect(written.length).toBeGreaterThan(1);
    expect(written.length).toBe(result.count);
    for (const phrase of written) {
      expect(typeof phrase).toBe('string');
    }
  }, 60000);
});
