import fs from 'node:fs';
import type { TradeProfile } from './profile.js';

export function loadIipSourceIds(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`IIP sources file unreadable at ${file}: ${(err as Error).message}`);
  }
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*-\s*id:\s*([A-Za-z0-9_]+)\s*$/.exec(line);
    if (m) ids.push(m[1]);
  }
  if (ids.length === 0 && text.trim().length > 0) {
    throw new Error(`IIP sources file has no source ids (expected "- id: <name>" entries): ${file}`);
  }
  return ids;
}

export function assertDirectSourcesKnown(profile: Pick<TradeProfile, 'name' | 'directSources'>, known: string[]): void {
  const unknown = profile.directSources.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `trade ${profile.name} lists directSources that are not configured iip sources: ${unknown.join(', ')}`
    );
  }
}
