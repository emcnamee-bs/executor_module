// scripts/backtest-exit.ts
//
// Replays the news a paper trade's ledger logged against the positions it opened, to show what the exit
// review WOULD have done (spec section 8, step 5). READ-ONLY against the real ledger; model calls (only
// with --run) are logged to an in-memory scratch ledger. Default is a dry run: it spends nothing.
//   npm run backtest-exit -- --trade kxwti                    # dry run: counts planned model calls
//   npm run backtest-exit -- --trade kxwti --run --max-items 40
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { openLedger } from '../src/decide/ledger.js';
import { loadProfile } from '../src/profile/profile.js';
import { fetchCandles, type Candle } from '../src/decide/kalshiHistory.js';
import { reviewForExit } from '../src/decide/exitReview.js';
import {
  extractArticleText, parseLadderJson, replayPosition, summarizeReplay, summarizeSkips, reviewReliability, sampleSkipReasons,
  type CandleMap, type ReplayItem, type ReplayPosition, type ReviewFn, type ReplayResult,
} from '../src/backtest/exitReplay.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDLE_CHUNK_SEC = 4000 * 60; // stay under the per-request candle limit
const THROTTLE_MS = 400; // Kalshi's public API 429s when hit about 40 times quickly

interface Args { trade: string; data: string; run: boolean; model: string | undefined; maxItems: number; fee: number; out: string }

function parseArgs(argv: string[]): Args {
  const a: Args = { trade: '', data: path.join(REPO_ROOT, 'data'), run: false, model: undefined, maxItems: 80, fee: 0, out: path.join(os.homedir(), 'exit-backtest') };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined || x.startsWith('--')) throw new Error(`${f} requires a value`); return x; };
    if (f === '--trade') a.trade = v();
    else if (f === '--data') a.data = path.resolve(v());
    else if (f === '--run') a.run = true;
    else if (f === '--model') a.model = v();
    else if (f === '--max-items') a.maxItems = Number(v());
    else if (f === '--fee') a.fee = Number(v());
    else if (f === '--out') a.out = v();
    else throw new Error(`unknown argument ${JSON.stringify(f)}`);
  }
  if (!a.trade) throw new Error('--trade <name> is required');
  if (!Number.isInteger(a.maxItems) || a.maxItems < 1) throw new Error('--max-items must be a positive integer');
  if (!Number.isFinite(a.fee) || a.fee < 0) throw new Error('--fee must be a number >= 0');
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

async function candlesForRange(series: string, ticker: string, startSec: number, endSec: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let from = startSec; from < endSec; from += CANDLE_CHUNK_SEC) {
    out.push(...(await fetchCandles(series, ticker, from, Math.min(endSec, from + CANDLE_CHUNK_SEC))));
    await sleep(THROTTLE_MS);
  }
  return out.sort((x, y) => x.endTs - y.endTs);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadProfile(args.trade);
  const series = loaded.profile.seriesTicker;
  const ledgerPath = path.join(args.data, args.trade, 'decisions.db');
  if (!fs.existsSync(ledgerPath)) throw new Error(`ledger not found: ${ledgerPath}`);
  const src = new Database(ledgerPath, { readonly: true, fileMustExist: true });

  // positions with a side, and what actually happened to them
  const posRows = src
    .prepare(
      `SELECT id, side, structure, market_ticker AS marketTicker, contracts, entry_price_cents AS entry, created_at AS createdAt,
              settled_at AS settledAt, pnl_cents AS pnl, ladder_json AS ladderJson
         FROM paper_positions WHERE side IS NOT NULL ORDER BY id`
    )
    .all() as Array<{ id: number; side: 'yes' | 'no'; structure: string; marketTicker: string; contracts: number; entry: number; createdAt: string; settledAt: string | null; pnl: number | null; ladderJson: string }>;

  // news that passed the gate, with the text a model saw (gate request first seen time = when it reached us)
  const itemRows = src
    .prepare(
      `SELECT g.item_id AS itemId, MIN(g.called_at) AS seen,
              (SELECT request_json FROM ai_calls x WHERE x.item_id = g.item_id AND x.stage IN ('decide','triage') AND x.error IS NULL ORDER BY x.id LIMIT 1) AS richJson,
              (SELECT request_json FROM ai_calls y WHERE y.item_id = g.item_id AND y.stage = 'gate' AND y.error IS NULL ORDER BY y.id LIMIT 1) AS gateJson
         FROM ai_calls g WHERE g.stage = 'gate' AND g.verdict = 'true' AND g.item_id IS NOT NULL GROUP BY g.item_id ORDER BY seen`
    )
    .all() as Array<{ itemId: string; seen: string; richJson: string | null; gateJson: string | null }>;
  const items: ReplayItem[] = [];
  for (const r of itemRows) {
    const text = (r.richJson !== null ? extractArticleText(r.richJson) : null) ?? (r.gateJson !== null ? extractArticleText(r.gateJson) : null);
    if (text !== null) items.push({ itemId: r.itemId, seenAtSec: epoch(r.seen), text });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const positions: Array<ReplayPosition & { skipped?: string }> = [];
  const skipped: string[] = [];
  for (const r of posRows) {
    const ladder = parseLadderJson(r.ladderJson);
    if (ladder === null) { skipped.push(`position ${r.id} (${r.marketTicker}): saved ladder missing or malformed`); continue; }
    if (r.structure !== 'band' && r.structure !== 'threshold' && r.structure !== 'binary') { skipped.push(`position ${r.id}: structure ${r.structure} is not exit-reviewable`); continue; }
    positions.push({
      id: r.id, side: r.side, structure: r.structure, marketTicker: r.marketTicker, contracts: r.contracts, entryPriceCents: r.entry,
      createdAtSec: epoch(r.createdAt), endSec: r.settledAt === null ? null : epoch(r.settledAt), actualPnlCents: r.pnl, ladder,
    });
  }

  const plannedCalls = positions.reduce((n, p) => n + Math.min(args.maxItems, items.filter((i) => i.seenAtSec > p.createdAtSec && (p.endSec === null || i.seenAtSec < p.endSec)).length), 0);
  console.log(`[backtest-exit] trade=${args.trade} series=${series} positions=${positions.length} (skipped ${skipped.length}) gated items=${items.length} planned model calls<=${plannedCalls}`);
  for (const s of skipped) console.log(`  skipped: ${s}`);
  if (!args.run) {
    console.log('[backtest-exit] DRY RUN: nothing fetched, nothing spent. Re-run with --run to replay (about $0.01 per Sonnet call).');
    src.close();
    return;
  }

  // candles for every market of every event, once each
  const candles: CandleMap = new Map();
  const nowEnd = nowSec;
  for (const p of positions) {
    const start = p.createdAtSec - 65 * 60;
    const end = p.endSec ?? nowEnd;
    for (const band of p.ladder) {
      const have = candles.get(band.ticker);
      if (have !== undefined && have.length > 0) continue;
      candles.set(band.ticker, await candlesForRange(series, band.ticker, start, end));
    }
  }
  const markTag = new Map<number, string>(); // open positions only: their "actual" is an interim mark, not an outcome
  for (const p of positions) {
    if (p.actualPnlCents === null) { // still open: use the last candle's held-side mark
      const cs = candles.get(p.marketTicker) ?? [];
      const last = cs[cs.length - 1];
      const mark = last === undefined ? null : p.side === 'yes' ? last.yesBidCents : last.yesAskCents === null ? null : 100 - last.yesAskCents;
      p.actualPnlCents = mark === null ? null : p.contracts * (mark - p.entryPriceCents);
      markTag.set(p.id, last === undefined || mark === null ? 'open, no mark available' : `open-mark @${new Date(last.endTs * 1000).toISOString()}`);
    }
  }
  const pnlTag = (id: number): string => markTag.get(id) ?? 'settled';

  const client = new Anthropic();
  const scratch = openLedger(':memory:');
  const review: ReviewFn = async ({ item, position, market, trajectory }) =>
    reviewForExit(client, scratch, {
      loaded, itemId: item.itemId, articleText: item.text, excerptSource: 'snippet', tripwireHit: false, sourceTrustTier: 3,
      publishedAt: new Date(item.seenAtSec * 1000).toISOString(),
      position: { marketTicker: position.marketTicker, side: position.side, contracts: position.contracts, remaining: position.contracts, entryPriceCents: position.entryPriceCents },
      market, trajectory, model: args.model,
    });

  const results: ReplayResult[] = [];
  for (const p of positions) {
    const r = await replayPosition(p, items, candles, review, { exitFeeCents: args.fee, maxItems: args.maxItems });
    results.push(r);
    const k = summarizeSkips(r.rows);
    const breakdown = `holds ${k.holds}, no-quote ${k.noQuote}, review-failed ${k.reviewFailed}, no-bid ${k.noBid}` + (k.otherSkip > 0 ? `, other-skip ${k.otherSkip}` : '');
    const rel = reviewReliability(r.rows, r.reviewed);
    console.log(`  position ${p.id} ${p.side.toUpperCase()} ${p.marketTicker} x${p.contracts}@${p.entryPriceCents}: reviewed ${r.reviewed} (${breakdown}), ` +
      (r.sold ? `SELL at ${new Date(r.sold.atSec * 1000).toISOString()} @${r.sold.priceCents}c (hyp ${r.sold.hypPnlCents}c vs actual ${r.actualPnlCents}c [${pnlTag(p.id)}])` : `no sell (actual ${r.actualPnlCents}c [${pnlTag(p.id)}])`) +
      (rel.mostlyFailed ? `  <-- UNRELIABLE: ${rel.failed} of ${rel.calls} reviews failed` : ''));
  }
  const settledResults = results.filter((r) => !markTag.has(r.positionId));
  const summary = summarizeReplay(results);
  const settledSummary = summarizeReplay(settledResults);
  console.log('[backtest-exit] summary, settled positions only (outcomes)', JSON.stringify(settledSummary));
  console.log(`[backtest-exit] summary, all positions (${markTag.size} open positions use an interim mark, not an outcome)`, JSON.stringify(summary));

  const totalCalls = results.reduce((n, r) => n + r.reviewed, 0);
  const totalFailed = results.reduce((n, r) => n + summarizeSkips(r.rows).reviewFailed, 0);
  const totalNoQuote = results.reduce((n, r) => n + summarizeSkips(r.rows).noQuote, 0);
  const totalsLine = `Review failures: ${totalFailed} of ${totalCalls} model calls; quote gaps: ${totalNoQuote} items`;
  const warnings: string[] = [];
  if (totalFailed > 0) warnings.push(`WARNING: ${totalFailed} review calls failed - this run is NOT reliable evidence`);
  if (totalCalls > 0 && totalFailed >= totalCalls) warnings.push('WARNING: EVERY model call failed - "never sold" below means nothing; check the API key, credit and rate limits and re-run');
  console.log(`[backtest-exit] ${totalsLine}`);
  for (const w of warnings) console.warn(`[backtest-exit] ${w}`);

  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `${args.trade}-${new Date().toISOString().slice(0, 10)}.md`);
  const lines: string[] = [
    `# Exit-review backtest: ${args.trade}`, '',
    `Run ${new Date().toISOString()}; model ${args.model ?? 'claude-sonnet-5-5 (default)'}; fee ${args.fee}c; max ${args.maxItems} items per position.`,
    `Gated items with text: ${items.length}. Positions replayed: ${positions.length}. Skipped: ${skipped.length}.`, '',
    totalsLine, '',
    ...warnings.flatMap((w) => [`**${w}**`, '']),
    '## Summary, settled positions only (outcomes)', '```', JSON.stringify(settledSummary, null, 2), '```', '',
    `## Summary, all positions (${markTag.size} of ${results.length} are open)`, '```', JSON.stringify(summary, null, 2), '```', '',
    'Positions tagged `open-mark` have not settled: their "actual" P&L is the held-side mark of the last candle at run time, an interim value and NOT an outcome, so delta and regretSells for them compare a sell against an interim price.',
    'Positive delta = selling at the trigger would have beaten holding. Profiles for dated weekly markets may be stale; fills assume the touch absorbs the order (candles carry no depth).', '',
    '## Positions',
  ];
  for (const r of results) {
    const k = summarizeSkips(r.rows);
    const rel = reviewReliability(r.rows, r.reviewed);
    lines.push(`### position ${r.positionId} ${r.side.toUpperCase()} ${r.marketTicker} x${r.contracts} @${r.entryPriceCents}c`);
    lines.push(`reviewed ${r.reviewed}; actual ${r.actualPnlCents}c [${pnlTag(r.positionId)}]; ` + (r.sold ? `SOLD ${new Date(r.sold.atSec * 1000).toISOString()} @${r.sold.priceCents}c = ${r.sold.hypPnlCents}c (delta ${r.deltaCents}c)` : 'never sold'));
    lines.push(`rows: holds ${k.holds}, no-quote ${k.noQuote}, review-failed ${k.reviewFailed}, no-bid ${k.noBid}, other-skip ${k.otherSkip}` + (rel.mostlyFailed ? `  **UNRELIABLE: ${rel.failed} of ${rel.calls} reviews failed**` : ''));
    for (const reason of sampleSkipReasons(r.rows, 5)) lines.push(`- skip reason: ${reason}`);
    for (const row of r.rows.filter((x) => x.verdict !== 'skip').slice(0, 40)) {
      lines.push(`- ${new Date(row.atSec * 1000).toISOString()} ${row.verdict.toUpperCase()} shift=${row.shift} conf=${row.confidence} loss=${row.lossCents?.toFixed(2)}c :: ${row.reason}`);
    }
    lines.push('');
  }
  fs.writeFileSync(file, lines.join('\n'));
  console.log(`[backtest-exit] wrote ${file}`);
  scratch.close();
  src.close();
}

main().catch((err) => {
  console.error('[backtest-exit] failed:', err);
  process.exit(1);
});
