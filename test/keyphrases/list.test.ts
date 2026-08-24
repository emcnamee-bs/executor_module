import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadKeyphrases, saveKeyphrases } from '../../src/keyphrases/list.js';

function tempFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'keyphrases-test-'));
  const file = path.join(dir, 'keyphrases.json');
  writeFileSync(file, content, 'utf-8');
  return file;
}

describe('loadKeyphrases', () => {
  it('loads a valid list of 2+ word phrases', () => {
    const file = tempFile(JSON.stringify(['trump approval rating', 'new poll released']));
    expect(loadKeyphrases(file)).toEqual(['trump approval rating', 'new poll released']);
  });

  it('warns and skips a phrase with fewer than 2 words', () => {
    const file = tempFile(JSON.stringify(['trump', 'trump approval rating']));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadKeyphrases(file);
    expect(result).toEqual(['trump approval rating']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('loads an empty list', () => {
    const file = tempFile('[]');
    expect(loadKeyphrases(file)).toEqual([]);
  });

  it('throws if the file does not exist', () => {
    expect(() => loadKeyphrases('/nonexistent/path/keyphrases.json')).toThrow();
  });

  it('throws on malformed JSON', () => {
    const file = tempFile('{not valid json');
    expect(() => loadKeyphrases(file)).toThrow(/not valid JSON/);
  });

  it('throws if the parsed content is not an array', () => {
    const file = tempFile(JSON.stringify({ not: 'an array' }));
    expect(() => loadKeyphrases(file)).toThrow(/must be a JSON array/);
  });

  it('throws if an entry is not a string', () => {
    const file = tempFile(JSON.stringify(['valid phrase here', 42]));
    expect(() => loadKeyphrases(file)).toThrow(/non-string entry/);
  });
});

describe('saveKeyphrases', () => {
  it('writes a list that loadKeyphrases can read back', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'keyphrases-test-'));
    const file = path.join(dir, 'keyphrases.json');
    saveKeyphrases(file, ['trump approval rating', 'new poll released']);
    expect(loadKeyphrases(file)).toEqual(['trump approval rating', 'new poll released']);
  });
});
