import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_KEYPHRASES_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/keyphrases.json'
);

function countWords(phrase: string): number {
  return phrase.trim().split(/\s+/).filter(Boolean).length;
}

export function loadKeyphrases(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `keyphrases file not found or unreadable at ${filePath}: ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `keyphrases file at ${filePath} is not valid JSON: ${(err as Error).message}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `keyphrases file at ${filePath} must be a JSON array, got ${typeof parsed}`
    );
  }

  const result: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      throw new Error(
        `keyphrases file at ${filePath} contains a non-string entry: ${JSON.stringify(entry)}`
      );
    }
    if (countWords(entry) < 2) {
      console.warn(`[keyphrases] skipping phrase with fewer than 2 words: ${JSON.stringify(entry)}`);
      continue;
    }
    result.push(entry);
  }
  return result;
}

export function saveKeyphrases(filePath: string, phrases: string[]): void {
  fs.writeFileSync(filePath, JSON.stringify(phrases, null, 2) + '\n', 'utf-8');
}
