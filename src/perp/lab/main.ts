// src/perp/lab/main.ts
//
// Wiring only: Redis consumer group, timers, the Anthropic client. All behaviour lives in LabService (service.ts), which is tested.
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendAlert, setAlertTrade } from '../../alert.js';
import { acquireLedgerLock } from '../../decide/ledgerLock.js';
import { createRedisClient } from '../../redis/client.js';
import { StreamConsumer } from '../../redis/consumer.js';
import { loadPrefilterConfig } from '../intake/prefilter.js';
import type { ModelDeps } from '../model/gate.js';
import { currentCommit } from '../ops/commit.js';
import { auditItem } from './audit.js';
import { makeEvaluator } from './features.js';
import { openLabDb, recordProcessStart } from './labDb.js';
import { makeRng } from './sampler.js';
import { LabService } from './service.js';
import { assertPaperOnly, resolveLabConfig } from './startup.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AUDIT_TICK_MS = 20_000;
const MARKS_TICK_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const HOUSEKEEPING_MS = 5 * 60_000;

export async function main(): Promise<void> {
  assertPaperOnly(process.env);
  const cfg = resolveLabConfig(process.env, REPO_ROOT);
  const prefilterCfg = loadPrefilterConfig(cfg.prefilterFile);
  mkdirSync(cfg.dataDir, { recursive: true });
  const labPath = path.join(cfg.dataDir, 'lab.db');
  const lock = acquireLedgerLock(labPath);
  process.once('exit', () => lock.release());
  const labDb = openLabDb(labPath);
  const commit = currentCommit(REPO_ROOT);
  // The prefilter's dedup/cap state lives in memory and is cold after every start: record each start so the report can say so.
  recordProcessStart(labDb, Date.now(), commit);
  setAlertTrade('perp-lab');

  let botDb: Database.Database | null = null;
  try {
    botDb = new Database(cfg.botDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error('[perp-lab] bot ledger not readable (features are still logged):', err instanceof Error ? err.message : String(err));
  }

  const anthropic = new Anthropic();
  const modelDeps: ModelDeps = { client: anthropic as unknown as ModelDeps['client'], db: labDb, dailyUsdCap: cfg.capUsd };
  const reportPath = path.join(cfg.dataDir, 'intake-lab-week1.md');
  // The alert names the real location: relative to the checkout when inside it, else the absolute path (LAB_DATA_DIR may point elsewhere).
  const relReport = path.relative(REPO_ROOT, reportPath);
  const reportPathLabel = relReport.startsWith('..') || path.isAbsolute(relReport) ? reportPath : relReport.split(path.sep).join('/');
  const service = new LabService({
    labDb, botDb, evaluator: makeEvaluator(prefilterCfg), cfg: prefilterCfg, now: () => Date.now(), commit, capUsd: cfg.capUsd, days: cfg.days, rng: makeRng(cfg.seed),
    audit: (row, stratum, kind) => (botDb === null ? Promise.resolve('no_context' as const) : auditItem({ labDb, botDb, modelDeps, now: () => Date.now() }, row, stratum, kind)),
    alert: (m) => sendAlert(m),
    writeReport: (md) => writeFileSync(reportPath, md),
    reportPathLabel,
  });

  console.log(`[perp-lab] starting capUsd=${cfg.capUsd} days=${cfg.days} seed=${cfg.seed} commit=${commit} lab=${labPath} bot=${cfg.botDbPath}`);
  const redis = createRedisClient();
  await redis.connect();
  const consumer = new StreamConsumer(redis, { streamKey: 'iip:items', groupName: 'perp-lab', consumerName: 'perp-lab-primary', startId: '$' });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());

  // Every timer callback is wrapped: an exception in a timer would kill the process, and the lab must keep logging.
  const safe = (what: string, fn: () => unknown): (() => void) => () => {
    Promise.resolve()
      .then(fn)
      .catch((err) => console.error(`[perp-lab] ${what} failed:`, err instanceof Error ? err.message : String(err)));
  };
  const timers = [
    setInterval(safe('audit', () => service.auditTick()), AUDIT_TICK_MS),
    setInterval(safe('marks', () => service.fillMarks()), MARKS_TICK_MS),
    setInterval(safe('heartbeat', () => service.recordHeartbeat()), HEARTBEAT_MS),
    // Separate wrappers: a failing silence check must not block the day-7 report.
    setInterval(safe('silence', () => service.silenceTick()), HOUSEKEEPING_MS),
    setInterval(safe('report', () => service.maybeReport()), HOUSEKEEPING_MS),
  ];

  try {
    await consumer.run(async (entry) => {
      await service.handleEntry(entry); // never rejects
    }, controller.signal);
  } finally {
    for (const t of timers) clearInterval(t);
    await redis.quit().catch(() => undefined);
    botDb?.close();
    labDb.close();
  }
}

main().catch((err) => {
  console.error('[perp-lab] fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
