import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { openLedger } from '../decide/ledger.js';
import { callStructured, SONNET_MODEL } from '../decide/structured.js';
import { validateBank } from './bank.js';
import { TRADES_ROOT, type MarketStructure, type TradeProfile } from './profile.js';
import {
  GENERIC_KEYPHRASE_RULES,
  GENERIC_LIST_SIZE_AND_STYLE,
  KEYPHRASE_JSON_SCHEMA,
  buildKeyphrasePrompt,
  dedupeKeyphrases,
} from '../keyphrases/generate.js';
import { loadKeyphrases } from '../keyphrases/list.js';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const MIN_GENERATED_KEYPHRASES = 150;
const MIN_REUSED_KEYPHRASES = 20;
const LIVE_LEDGER_PATH = 'data/decisions.db';
// Must stay in step with ProfileSchema in profile.ts: a profile that fails these would be unloadable.
const LEDGER_PATH_RE = /^data\/([a-z0-9-]+\/)?[A-Za-z0-9._-]+\.db$/;
const CONSUMER_GROUP_RE = /^[A-Za-z0-9_-]{1,60}$/;
const SERIES_RE = /^[A-Z0-9]{3,40}$/;
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
  const active = [...events.events].sort((a: any, b: any) => a.strike_date.localeCompare(b.strike_date))[0];
  const markets = await get(`${KALSHI_API_BASE}/markets?event_ticker=${encodeURIComponent(active.event_ticker)}&status=open`);
  const list: any[] = markets.markets ?? [];
  if (list.length === 0) throw new Error(`event ${active.event_ticker} has no open markets`);
  return {
    seriesTicker,
    title: active.title ?? seriesTicker,
    rulesText: [list[0].rules_primary, list[0].rules_secondary].filter(Boolean).join(' ').slice(0, 1500),
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
  deps: { client: Anthropic; fetchImpl?: typeof fetch; now?: () => Date }
): Promise<{ dir: string; profile: TradeProfile }> {
  const now = deps.now ?? (() => new Date());
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
  if (ledgerPath === LIVE_LEDGER_PATH && !opts.allowLiveLedger) {
    throw new Error(
      `refusing to open the live ledger ${LIVE_LEDGER_PATH} for build logging; pass --allow-live-ledger to write the build ai_calls rows into it`
    );
  }

  const spec = await fetchSeriesSpec(opts.seriesTicker, deps.fetchImpl);
  const structure = deriveStructure(spec.strikeTypes, spec.marketCount);

  const absLedger = path.resolve(repoRoot, ledgerPath);
  fs.mkdirSync(path.dirname(absLedger), { recursive: true });
  const db = openLedger(absLedger);
  try {
    const specText = JSON.stringify(spec, null, 2);
    let generated: any = null;
    let lastError = '';
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
        generated = parsed;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    if (generated === null) {
      throw new Error(`generated bank failed validation twice: ${lastError}`);
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
      keyphrases = dedupeKeyphrases(parsed.keyphrases);
      if (keyphrases.length < MIN_GENERATED_KEYPHRASES) {
        throw new Error(`generated keyphrase list has ${keyphrases.length} phrases; need at least ${MIN_GENERATED_KEYPHRASES}`);
      }
    }

    const profile: TradeProfile = {
      name,
      seriesTicker: spec.seriesTicker,
      title: generated.title,
      settlement: generated.settlement,
      gateModel: opts.gateModel ?? 'qwen2.5:7b-instruct-q4_K_M',
      gateKeepAlive: '10m',
      decideContext: generated.decideContext,
      directSources: opts.directSources,
      marketStructure: structure,
      magnitudeUnit: generated.magnitudeUnit,
      maxMagnitude: generated.maxMagnitude,
      ledgerPath,
      consumerGroup,
      generatedAt: now().toISOString(),
      generatorModel: SONNET_MODEL,
    };

    // Write everything to a temp directory first, then move files into place, so a
    // failure above (or while writing) leaves any existing profile byte-identical.
    const dir = path.join(tradesRoot, name);
    const tmp = path.join(tradesRoot, `.build-${name}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      fs.writeFileSync(path.join(tmp, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
      fs.writeFileSync(path.join(tmp, 'keyphrases.json'), JSON.stringify(keyphrases, null, 2) + '\n');
      fs.writeFileSync(path.join(tmp, 'bank.md'), generated.bank.endsWith('\n') ? generated.bank : generated.bank + '\n');
      const bankText = fs.readFileSync(path.join(tmp, 'bank.md'), 'utf-8');
      fs.writeFileSync(
        path.join(tmp, 'bank.meta.json'),
        JSON.stringify({ sha256: crypto.createHash('sha256').update(bankText).digest('hex'), generatedAt: profile.generatedAt, model: SONNET_MODEL }, null, 2) + '\n'
      );
      fs.mkdirSync(dir, { recursive: true });
      for (const file of fs.readdirSync(tmp)) {
        fs.renameSync(path.join(tmp, file), path.join(dir, file));
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { dir, profile };
  } finally {
    db.close();
  }
}
