// src/decide/prepare.ts
//
// The article fetch, injection tripwire and relevance gate for ONE item, shared by the entry path
// and the exit review so neither pays for them twice. Lazy and memoized: nothing runs until the
// first caller asks, and a rejection is memoized too (every caller sees the same failure).
import type Database from 'better-sqlite3';
import type { Item } from '../item.js';
import type { LoadedProfile } from '../profile/profile.js';
import type { OllamaClient } from './ollamaClient.js';
import { runGate } from './gate.js';
import { fetchArticle, articleToText, snippetArticle } from '../fetch/excerpt.js';
import { detectInjection, MAX_SOURCE_CHARS } from '../guard/untrusted.js';

export interface PreparedItem {
  articleText: string;
  excerptSource: 'page' | 'snippet';
  tripwireHit: boolean;
  gate:
    | { kind: 'pass'; reason: string | null }
    | { kind: 'error'; reason: string }
    | { kind: 'irrelevant'; reason: string };
}

export interface PrepareDeps {
  ollamaClient: OllamaClient;
  db: Database.Database;
  profile: LoadedProfile;
  fetchArticle: typeof fetchArticle;
  gateProvider?: 'ollama' | 'anthropic';
  gateModel?: string;
}

export function makePrepare(item: Item, deps: PrepareDeps, isDirect: boolean): () => Promise<PreparedItem> {
  let memo: Promise<PreparedItem> | null = null;
  return () => (memo ??= prepareItem(item, deps, isDirect));
}

async function prepareItem(item: Item, deps: PrepareDeps, isDirect: boolean): Promise<PreparedItem> {
  // One fetch, capped at the per-source ceiling. Gate and triage see the first 800
  // characters of it (capped again inside their wrappers); the decision sees all of
  // it. A direct source IS the resolution data, so its own snippet is the article.
  const fetchedRaw = isDirect ? null : await deps.fetchArticle(item.url, { maxChars: MAX_SOURCE_CHARS });
  // A page that fetched but yielded no text (e.g. JS-rendered) is no article at all:
  // fall back to the headline+snippet rather than feed the models an empty 'page'.
  const fetched = fetchedRaw !== null && articleToText(fetchedRaw).trim() !== '' ? fetchedRaw : null;
  const article = fetched ?? snippetArticle(item.headline, item.snippet, MAX_SOURCE_CHARS);
  const excerptSource: 'page' | 'snippet' = fetched ? 'page' : 'snippet';
  const articleText = articleToText(article);

  // Deterministic injection tripwire over everything a model will read. A hit never
  // drops the item: it bypasses the (flippable) local gate and goes to Sonnet with a
  // warning, because a model that can be talked out of "relevant" is the harmful case.
  const tripwireHit = detectInjection(articleText).length > 0;
  if (tripwireHit) {
    console.warn(`[TRIPWIRE] item=${item.item_id} source=${item.source_id} text contains instruction-like content; bypassing the local gate`);
  }

  if (isDirect || tripwireHit) {
    return { articleText, excerptSource, tripwireHit, gate: { kind: 'pass', reason: null } };
  }

  try {
    const gate = await runGate(
      { ollama: deps.ollamaClient, db: deps.db, profile: deps.profile, provider: deps.gateProvider, model: deps.gateModel },
      { itemId: item.item_id, excerptText: articleText, excerptSource, tripwireHit }
    );
    return {
      articleText, excerptSource, tripwireHit,
      gate: gate.relevant ? { kind: 'pass', reason: gate.reason } : { kind: 'irrelevant', reason: gate.reason },
    };
  } catch (err) {
    // Malformed output (GateError) or an Ollama failure, including a timeout: the gate's own
    // ai_calls row is already written. The caller records the `gate error:` skip.
    const message = err instanceof Error ? err.message : String(err);
    return { articleText, excerptSource, tripwireHit, gate: { kind: 'error', reason: message } };
  }
}
