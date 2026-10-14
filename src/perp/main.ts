// src/perp/main.ts
import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendAlert, setAlertTrade } from '../alert.js';
import { acquireLedgerLock } from '../decide/ledgerLock.js';
import { createRedisClient } from '../redis/client.js';
import { StreamConsumer } from '../redis/consumer.js';
import { KalshiMarginClient } from './broker/kalshiMarginClient.js';
import type { PaperState } from './broker/paper.js';
import { calendarCoverageDays, loadCalendar } from './collectors/calendar.js';
import { collectMacro } from './collectors/fred.js';
import { collectKalshiEvents } from './collectors/kalshiEvents.js';
import { collectPerp } from './collectors/perpMarket.js';
import { loadPerpConfig } from './config.js';
import { PerpEngine, type Collected } from './engine/engine.js';
import { NewsIntake } from './intake/newsIntake.js';
import { ensureModelCallsTable } from './model/callJson.js';
import { runPerpGate, type ModelDeps } from './model/gate.js';
import { extractImpact } from './model/impact.js';
import { createBroker, resolveMode } from './startup.js';
import { appendJournal, getState, openPerpDb, setState } from './store/db.js';
import type { MacroPoint } from './types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Same stream the executor reads; the bot uses its own consumer group so it never competes with the executor. */
const IIP_STREAM_KEY = 'iip:items';
const MACRO_REFRESH_MS = 15 * 60_000;
const KALSHI_EVENTS_REFRESH_MS = 5 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;
const CALENDAR_MIN_COVERAGE_DAYS = 7;

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function main(): Promise<void> {
  const env = process.env;
  const cfg = loadPerpConfig(env);
  const mode = resolveMode(env, cfg.ticker);
  const tickMs = Number(env.PERP_TICK_MS ?? 60_000);
  if (!Number.isFinite(tickMs) || tickMs < 5_000) throw new Error('PERP_TICK_MS must be at least 5000');
  const dailyCap = Number(env.PERP_DAILY_USD_CAP ?? 5);
  if (!Number.isFinite(dailyCap) || dailyCap <= 0) throw new Error('PERP_DAILY_USD_CAP must be a positive number of dollars');

  const dataDir = env.PERP_DATA_DIR ?? path.join(REPO_ROOT, 'data', 'perp');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, `perp-${mode.mode}.db`);
  const lock = acquireLedgerLock(dbPath);
  process.once('exit', () => lock.release());
  const db = openPerpDb(dbPath);
  ensureModelCallsTable(db);
  setAlertTrade(`perp-${mode.mode}`);
  // sendAlert has its own per-request timeout and never rejects, so the intake can await it safely.
  const alert = (m: string): Promise<void> => sendAlert(m);

  const prodClient = new KalshiMarginClient({ env: 'prod', apiKeyId: must('KALSHI_API_KEY_ID'), privateKeyPath: must('KALSHI_PRIVATE_KEY_PATH') });
  const demoClient =
    mode.mode === 'demo'
      ? new KalshiMarginClient({ env: 'demo', apiKeyId: must('KALSHI_DEMO_API_KEY_ID'), privateKeyPath: must('KALSHI_DEMO_PRIVATE_KEY_PATH') })
      : null;
  const marketClient = demoClient ?? prodClient;
  const { broker, paper } = createBroker(mode, { env, ticker: cfg.ticker, prodClient, demoClient, now: () => Date.now() });
  if (paper !== null) {
    const saved = getState<PaperState>(db, 'paper');
    if (saved !== null) paper.importState(saved);
  }

  const calendarFile = env.PERP_CALENDAR_FILE ?? path.join(REPO_ROOT, 'config', 'perp-calendar.json');
  loadCalendar(calendarFile, Date.now()); // fail at startup, loudly, if the calendar file is missing or invalid
  const kalshiTickers = (env.PERP_KALSHI_EVENT_TICKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  let macroCache: { at: number; macro: Record<string, MacroPoint> } | null = null;
  let kalshiCache: { at: number; events: Collected['kalshiEvents'] } | null = null;
  const collect = async (): Promise<Collected> => {
    const now = Date.now();
    const perp = await collectPerp(marketClient, mode.marketTicker, now);
    if (macroCache === null || now - macroCache.at > MACRO_REFRESH_MS) {
      const macro = await collectMacro();
      if (Object.keys(macro).length > 0) macroCache = { at: now, macro };
    }
    if (kalshiTickers.length > 0 && (kalshiCache === null || now - kalshiCache.at > KALSHI_EVENTS_REFRESH_MS)) {
      kalshiCache = { at: now, events: await collectKalshiEvents(kalshiTickers) };
    }
    return {
      perp,
      perpFetchedAtMs: now,
      macro: macroCache?.macro ?? {},
      macroFetchedAtMs: macroCache?.at ?? null,
      events: loadCalendar(calendarFile, now),
      kalshiEvents: kalshiCache?.events ?? [],
    };
  };

  const engine = new PerpEngine({
    cfg, db, broker, now: () => Date.now(), collect, alert,
    persistBroker: paper === null ? undefined : () => setState(db, 'paper', paper.exportState()),
    applyFunding: paper === null ? undefined : (rate, mark) => paper.applyFunding(rate, mark),
  });

  const anthropic = new Anthropic();
  const modelDeps: ModelDeps = { client: anthropic as unknown as ModelDeps['client'], db, dailyUsdCap: dailyCap };
  const intake = new NewsIntake({
    db, now: () => Date.now(), alert, engine,
    gate: (item) => runPerpGate(modelDeps, item),
    extract: (item, ctx) => extractImpact(modelDeps, item, ctx, Date.now()),
  });

  console.log(`[perp] starting mode=${mode.mode} ticker=${mode.marketTicker} subaccount=${mode.subaccount ?? '-'} tickMs=${tickMs} db=${dbPath}`);
  await engine.start();
  await engine.tick(); // first snapshot, so news arriving next has context

  const redis = createRedisClient();
  await redis.connect();
  const consumer = new StreamConsumer(redis, { streamKey: IIP_STREAM_KEY, groupName: 'perpbot', consumerName: 'perpbot-primary', startId: '$' });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  let ticking = false;
  const tickTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    engine.tick().finally(() => { ticking = false; });
  }, tickMs);

  let lastCoverageAlertDay: string | null = null;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    appendJournal(db, { tsMs: now, kind: 'heartbeat', payload: { status: engine.status(), intake: intake.counters } });
    const day = new Date(now).toISOString().slice(0, 10);
    if (lastCoverageAlertDay !== day) {
      lastCoverageAlertDay = day;
      try {
        const days = calendarCoverageDays(calendarFile, now);
        if (days < CALENDAR_MIN_COVERAGE_DAYS) void alert(`[PERP] the economic calendar file only covers the next ${days.toFixed(1)} days; add upcoming FOMC/CPI/jobs dates to ${calendarFile}.`);
      } catch (err) {
        void alert(`[PERP] the economic calendar file is unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, HEARTBEAT_MS);

  try {
    await consumer.run(async (entry) => {
      await intake.handleEntry(entry); // never rejects
    }, controller.signal);
  } finally {
    clearInterval(tickTimer);
    clearInterval(heartbeat);
    await redis.quit().catch(() => undefined);
    db.close();
  }
}

main().catch((err) => {
  console.error('[perp] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
