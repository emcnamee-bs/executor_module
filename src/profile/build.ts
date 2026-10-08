import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { openLedger } from '../decide/ledger.js';
import { callStructured, SONNET_MODEL } from '../decide/structured.js';
import { validateBank } from './bank.js';
import { TRADES_ROOT, ProfileSchema, type MarketStructure, type TradeProfile } from './profile.js';
import {
  GENERIC_KEYPHRASE_RULES,
  GENERIC_LIST_SIZE_AND_STYLE,
  KEYPHRASE_JSON_SCHEMA,
  buildKeyphrasePrompt,
  dedupeKeyphrases,
} from '../keyphrases/generate.js';
import { loadKeyphrases, countWords } from '../keyphrases/list.js';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const MIN_GENERATED_KEYPHRASES = 150;
const MIN_REUSED_KEYPHRASES = 20;
const LIVE_LEDGER_PATH = 'data/decisions.db';
const LIVE_CONSUMER_GROUP = 'execmod';
// Must stay in step with ProfileSchema in profile.ts: a profile that fails these would be unloadable.
const LEDGER_PATH_RE = /^data\/([a-z0-9-]+\/)?[A-Za-z0-9._-]+\.db$/;
const CONSUMER_GROUP_RE = /^[A-Za-z0-9_-]{1,60}$/;
const SERIES_RE = /^[A-Z0-9]{3,40}$/;
const DIRECT_SOURCE_RE = /^[a-z0-9_]+$/;
const MAX_SCHEMA_ERROR_CHARS = 500;
const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    settlement: { type: 'string' },
    decideContext: { type: 'string' },
    magnitudeUnit: { type: 'string' },
    maxMagnitude: { type: 'number' },
    bank: { type: 'string' },
  },
  required: ['title', 'settlement', 'decideContext', 'magnitudeUnit', 'maxMagnitude', 'bank'],
  additionalProperties: false,
};

export interface SeriesSpec {
  seriesTicker: string;
  title: string;
  rulesText: string;
  strikeTypes: Array<string | null>;
  marketCount: number;
  sampleSubtitles: string[];
}

export async function fetchSeriesSpec(seriesTicker: string, fetchImpl: typeof fetch = fetch): Promise<SeriesSpec> {
  const get = async (url: string): Promise<any> => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Kalshi fetch failed: ${res.status} ${url}`);
    return res.json();
  };
  const events = await get(`${KALSHI_API_BASE}/events?series_ticker=${encodeURIComponent(seriesTicker)}&status=open`);
  if (!events.events || events.events.length === 0) {
    throw new Error(`no open event for series ${seriesTicker}`);
  }
  const active = [...events.events].sort((a: any, b: any) => (a.strike_date ?? '').localeCompare(b.strike_date ?? ''))[0];
  const markets = await get(`${KALSHI_API_BASE}/markets?event_ticker=${encodeURIComponent(active.event_ticker)}&status=open&limit=1000`);
  const list: any[] = markets.markets ?? [];
  if (list.length === 0) throw new Error(`event ${active.event_ticker} has no open markets`);
  const withRules = list.find((m) => m.rules_primary) ?? list[0];
  return {
    seriesTicker,
    title: active.title ?? seriesTicker,
    rulesText: [withRules.rules_primary, withRules.rules_secondary].filter(Boolean).join(' ').slice(0, 1500),
    strikeTypes: list.map((m) => (m.strike_type ?? null) as string | null),
    marketCount: list.length,
    sampleSubtitles: list.slice(0, 6).map((m) => String(m.yes_sub_title ?? m.ticker)),
  };
}

export function deriveStructure(strikeTypes: Array<string | null>, marketCount: number): MarketStructure {
  const set = new Set(strikeTypes);
  if (set.has('custom')) return 'capture';
  if (marketCount === 1 && strikeTypes.length === 1 && strikeTypes[0] === null) return 'binary';
  if (set.has('between')) return 'band';
  const threshold = ['greater', 'greater_or_equal', 'less'];
  if (strikeTypes.length > 0 && strikeTypes.every((t) => t !== null && threshold.includes(t))) return 'threshold';
  return 'capture';
}

const BANK_SYSTEM = `You prepare the knowledge bank that a small local model uses to screen news for one Kalshi trade. Reply with the requested JSON fields.

"bank" must use EXACTLY this layout (plain text, these five headers in this order, nothing else), about 350-500 tokens in total:
TRADE: <one line naming what the trade is about>
SETTLES ON: <one line: the resolution source and rule>
MOVES THE PRICE:
- <category>: <comma-separated concrete examples>
(at least 5 bullets; cover supply, demand, scheduled releases, policy, geopolitics, weather or whatever genuinely moves THIS quantity, written as categories with examples so an article that never names the quantity can still be matched)
SETTLEMENT-SENSITIVE FACTS: <comma-separated facts about how the resolution source behaves that affect how news translates into the number>
IGNORE: <comma-separated look-alike topics that are NOT relevant (at least 4)>

"title" is one question line for the market, "settlement" is 1-3 sentences from the rules text, "decideContext" is 1-3 sentences telling an analyst what quantity they are estimating the effect on and how the market resolves, "magnitudeUnit" is the unit of the settlement quantity (for example pts, %, USD/gal, count), and "maxMagnitude" is a generous positive sanity ceiling on how far one news item could plausibly move that quantity in that unit.`;

/**
 * True when `target` is the live ledger by name (case-insensitive: macOS volumes usually
 * are) or by identity (same device and inode, e.g. a hard link or a symlink to it).
 */
function isLiveLedger(target: string, live: string): boolean {
  if (target.toLowerCase() === live.toLowerCase()) return true;
  try {
    const t = fs.statSync(target);
    const l = fs.statSync(live);
    return t.ino === l.ino && t.dev === l.dev;
  } catch {
    return false; // one of them does not exist yet
  }
}

/**
 * The live trade's profile (trades/kxaprpotus/) is hand-pinned and committed: its decide
 * prompt, magnitude ceiling, ledger and consumer group are reviewed values. A plain
 * `build-trade --series KXAPRPOTUS` would otherwise replace it with a freshly generated,
 * unreviewed profile on a NEW ledger and group (the defaults), which a live start would
 * accept once the build itself had created that ledger. Refuse to replace any existing
 * profile that is pinned to the live ledger or the live group unless the operator passes
 * --allow-live-ledger. Only a positive identification refuses: an unreadable profile.json
 * is left to the normal build (such a profile cannot start anyway).
 */
function assertNotPinnedLiveProfile(dir: string): void {
  let existing: { ledgerPath?: unknown; consumerGroup?: unknown };
  try {
    existing = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf-8'));
  } catch {
    return;
  }
  const ledger = typeof existing?.ledgerPath === 'string' ? existing.ledgerPath : '';
  const group = typeof existing?.consumerGroup === 'string' ? existing.consumerGroup : '';
  if (ledger.toLowerCase() === LIVE_LEDGER_PATH || group === LIVE_CONSUMER_GROUP) {
    throw new Error(
      `refusing to replace the hand-pinned live profile at ${dir} (ledgerPath ${ledger}, consumerGroup ${group}); ` +
        `it is committed and reviewed, not regenerated. Pass --allow-live-ledger only if you really mean to rebuild it.`
    );
  }
}

/**
 * Best-effort recovery at the start of a build: if the target dir is missing but a
 * `.old-<name>-*` exists (a swap that died between its two renames), restore it; then
 * remove stale `.old-<name>-*` / `.build-<name>-*` dirs for THIS profile only.
 */
function sweepStaleDirs(
  tradesRoot: string,
  name: string,
  rename: typeof fs.renameSync,
  tryRm: (p: string) => void
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(tradesRoot);
  } catch {
    return; // no trades dir yet
  }
  const stale = new RegExp(`^\\.(old|build)-${name}-[0-9a-f]{8}$`);
  const mine = entries.filter((e) => stale.test(e)).sort();
  const target = path.join(tradesRoot, name);
  let restored = false;
  let keepOlds = false;
  if (!fs.existsSync(target)) {
    const olds = mine.filter((e) => e.startsWith('.old-'));
    // Restore only when the choice is unambiguous (final review M6): with several
    // copies the random suffixes say nothing about which is newest or intact.
    if (olds.length > 1) {
      keepOlds = true;
      console.warn(
        `[build-trade] profile ${name} is missing and ${olds.length} previous copies exist (${olds.join(', ')}); ` +
          `restoring none and leaving them in ${tradesRoot}: restore one by hand if needed`
      );
    }
    const candidate = olds.length === 1 ? olds[0] : undefined;
    if (candidate) {
      try {
        rename(path.join(tradesRoot, candidate), target);
        restored = true;
        console.warn(`[build-trade] restored previous profile ${name} from ${candidate} (an earlier build was interrupted)`);
      } catch (err) {
        console.warn(`[build-trade] could not restore ${candidate}: ${(err as Error).message}`);
        return; // leave everything in place for a human
      }
    }
  }
  for (const e of mine) {
    if (restored && !fs.existsSync(path.join(tradesRoot, e))) continue;
    if (keepOlds && e.startsWith('.old-')) continue;
    tryRm(path.join(tradesRoot, e));
  }
}

export interface BuildOptions {
  seriesTicker: string;
  directSources: string[];
  reuseKeyphrasesFile?: string;
  ledgerPath?: string;
  consumerGroup?: string;
  gateModel?: string;
  tradesRoot?: string;
  repoRoot?: string;
  allowLiveLedger?: boolean;
}

export async function buildTradeProfile(
  opts: BuildOptions,
  deps: { client: Anthropic; fetchImpl?: typeof fetch; now?: () => Date; rename?: typeof fs.renameSync; rm?: typeof fs.rmSync }
): Promise<{ dir: string; profile: TradeProfile }> {
  const now = deps.now ?? (() => new Date());
  const rename = deps.rename ?? fs.renameSync;
  const rm = deps.rm ?? fs.rmSync;
  // Cleanup must never change the build's outcome: a leftover dir is reported, not thrown.
  const tryRm = (p: string): void => {
    try {
      rm(p, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[build-trade] could not remove ${p} (safe to delete by hand): ${(err as Error).message}`);
    }
  };
  const name = opts.seriesTicker.toLowerCase();
  const tradesRoot = opts.tradesRoot ?? TRADES_ROOT;
  const repoRoot = opts.repoRoot ?? path.resolve(tradesRoot, '..');
  const ledgerPath = opts.ledgerPath ?? `data/${name}/decisions.db`;
  const consumerGroup = opts.consumerGroup ?? `execmod-${name}`;

  // Validate everything user-supplied BEFORE any network call, model call or file write.
  if (!SERIES_RE.test(opts.seriesTicker)) {
    throw new Error(`invalid series ticker ${JSON.stringify(opts.seriesTicker)}: use uppercase letters and digits (3-40 characters)`);
  }
  if (!LEDGER_PATH_RE.test(ledgerPath) || ledgerPath.includes('..')) {
    throw new Error(`invalid ledger path ${JSON.stringify(ledgerPath)}: must look like data/<file>.db or data/<trade>/<file>.db (lowercase trade dir, no "..")`);
  }
  if (!CONSUMER_GROUP_RE.test(consumerGroup)) {
    throw new Error(`invalid consumer group ${JSON.stringify(consumerGroup)}: use letters, digits, "_" and "-" (1-60 characters)`);
  }
  for (const id of opts.directSources) {
    if (!DIRECT_SOURCE_RE.test(id)) {
      throw new Error(`invalid --direct source id ${JSON.stringify(id)}: use lowercase letters, digits and underscores`);
    }
  }
  if (!opts.allowLiveLedger && isLiveLedger(path.resolve(repoRoot, ledgerPath), path.resolve(repoRoot, LIVE_LEDGER_PATH))) {
    throw new Error(
      `refusing to open the live ledger ${LIVE_LEDGER_PATH} (as ${ledgerPath}) for build logging; pass --allow-live-ledger to write the build ai_calls rows into it`
    );
  }

  if (!opts.allowLiveLedger) assertNotPinnedLiveProfile(path.join(tradesRoot, name));

  sweepStaleDirs(tradesRoot, name, rename, tryRm);

  const spec = await fetchSeriesSpec(opts.seriesTicker, deps.fetchImpl);
  const structure = deriveStructure(spec.strikeTypes, spec.marketCount);

  const absLedger = path.resolve(repoRoot, ledgerPath);
  fs.mkdirSync(path.dirname(absLedger), { recursive: true });
  const db = openLedger(absLedger);
  try {
    const specText = JSON.stringify(spec, null, 2);
    let generated: any = null;
    let profile: TradeProfile | null = null;
    let lastError = '';
    const generatedAt = now().toISOString();
    for (let attempt = 0; attempt < 2 && generated === null; attempt++) {
      const user =
        `Market series spec from Kalshi:\n${specText}` +
        (lastError ? `\n\nYour previous bank was rejected: ${lastError}. Fix it and return the full JSON again.` : '');
      const parsed = (await callStructured({
        client: deps.client, db, trade: name, itemId: null, stage: 'build_bank', maxTokens: 4096,
        system: BANK_SYSTEM, user, schema: PROFILE_SCHEMA, excerptSource: null, tripwireHit: false,
        summarize: (p) => ({ verdict: 'bank', reasoning: String((p as any).title ?? '') }),
      })) as any;
      try {
        validateBank(parsed.bank);
        if (typeof parsed.maxMagnitude !== 'number' || !(parsed.maxMagnitude > 0) || !Number.isFinite(parsed.maxMagnitude)) {
          throw new Error('maxMagnitude must be a positive finite number');
        }
        if (typeof parsed.magnitudeUnit !== 'string' || parsed.magnitudeUnit.trim() === '') {
          throw new Error('magnitudeUnit must be a non-empty string');
        }
        // The assembled profile must pass the SAME schema the loader enforces, or the
        // build would "succeed" and write a profile the process refuses to start with.
        const candidate = {
          name,
          seriesTicker: spec.seriesTicker,
          title: parsed.title,
          settlement: parsed.settlement,
          gateModel: opts.gateModel ?? 'qwen2.5:7b-instruct-q4_K_M',
          gateKeepAlive: '10m',
          decideContext: parsed.decideContext,
          directSources: opts.directSources,
          marketStructure: structure,
          magnitudeUnit: parsed.magnitudeUnit,
          maxMagnitude: parsed.maxMagnitude,
          ledgerPath,
          consumerGroup,
          generatedAt,
          generatorModel: SONNET_MODEL,
        };
        const checked = ProfileSchema.safeParse(candidate);
        if (!checked.success) {
          // Field names and limits only: zod messages do not echo the offending value.
          const detail = checked.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
          throw new Error(`profile fields invalid (${detail})`.slice(0, MAX_SCHEMA_ERROR_CHARS));
        }
        profile = checked.data;
        generated = parsed;
      } catch (err) {
        lastError = (err as Error).message.slice(0, MAX_SCHEMA_ERROR_CHARS);
      }
    }
    if (generated === null || profile === null) {
      throw new Error(`generated bank/profile failed validation twice: ${lastError}`);
    }

    let keyphrases: string[];
    if (opts.reuseKeyphrasesFile) {
      keyphrases = loadKeyphrases(opts.reuseKeyphrasesFile);
      if (keyphrases.length < MIN_REUSED_KEYPHRASES) {
        throw new Error(`reused keyphrase file has ${keyphrases.length} usable phrases; need at least ${MIN_REUSED_KEYPHRASES}`);
      }
    } else {
      const marketContext =
        `This keyphrase list is used to scan a live news stream for items relevant to the Kalshi market series ${spec.seriesTicker} ("${generated.title}"). ` +
        `It resolves as follows: ${generated.settlement}\n\n${GENERIC_KEYPHRASE_RULES}`;
      const parsed = (await callStructured({
        client: deps.client, db, trade: name, itemId: null, stage: 'build_keyphrases', maxTokens: 8192,
        system: '', user: buildKeyphrasePrompt(marketContext, [], GENERIC_LIST_SIZE_AND_STYLE), schema: KEYPHRASE_JSON_SCHEMA,
        excerptSource: null, tripwireHit: false,
        summarize: (p) => ({ verdict: `phrases:${(p as any).keyphrases?.length ?? 0}`, reasoning: null }),
      })) as { keyphrases: string[] };
      // Same rule the loader applies (it drops phrases under 2 words), so the count is what the loader will see.
      keyphrases = dedupeKeyphrases(parsed.keyphrases).filter((p) => countWords(p) >= 2);
      if (keyphrases.length < MIN_GENERATED_KEYPHRASES) {
        throw new Error(`generated keyphrase list has ${keyphrases.length} usable (2+ word) phrases; need at least ${MIN_GENERATED_KEYPHRASES}`);
      }
    }

    // Stage the COMPLETE profile in a temp dir inside tradesRoot (same filesystem), then swap
    // whole directories: old -> .old-*, staged -> target. If the second rename fails the old
    // directory is renamed back, so an existing profile is never left half-replaced.
    const dir = path.join(tradesRoot, name);
    const suffix = crypto.randomBytes(4).toString('hex');
    const staged = path.join(tradesRoot, `.build-${name}-${suffix}`);
    const old = path.join(tradesRoot, `.old-${name}-${suffix}`);
    fs.mkdirSync(staged, { recursive: true });
    let keepOld = false;
    try {
      fs.writeFileSync(path.join(staged, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
      fs.writeFileSync(path.join(staged, 'keyphrases.json'), JSON.stringify(keyphrases, null, 2) + '\n');
      fs.writeFileSync(path.join(staged, 'bank.md'), generated.bank.endsWith('\n') ? generated.bank : generated.bank + '\n');
      const bankText = fs.readFileSync(path.join(staged, 'bank.md'), 'utf-8');
      fs.writeFileSync(
        path.join(staged, 'bank.meta.json'),
        JSON.stringify({ sha256: crypto.createHash('sha256').update(bankText).digest('hex'), generatedAt: profile.generatedAt, model: SONNET_MODEL }, null, 2) + '\n'
      );
      const hadOld = fs.existsSync(dir);
      if (hadOld) rename(dir, old);
      try {
        rename(staged, dir);
      } catch (err) {
        if (hadOld) {
          try {
            rename(old, dir);
          } catch (restoreErr) {
            keepOld = true; // never delete the only copy of the old profile
            console.error(`[build-trade] could not restore the previous profile; it is at ${old}:`, (restoreErr as Error).message);
          }
        }
        throw err;
      }
    } finally {
      tryRm(staged);
      if (!keepOld) tryRm(old);
    }
    return { dir, profile };
  } finally {
    db.close();
  }
}
