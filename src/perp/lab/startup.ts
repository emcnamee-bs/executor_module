// src/perp/lab/startup.ts
import path from 'node:path';

export interface LabConfig { capUsd: number; days: number; seed: number; dataDir: string; botDbPath: string; prefilterFile: string }

/** The lab is paper-only by construction: it must be started with PERP_MODE=paper pinned and no PERP_LIVE (the unit pins both). */
export function assertPaperOnly(env: NodeJS.ProcessEnv): void {
  if (env.PERP_MODE !== 'paper') throw new Error(`the intake lab runs only with PERP_MODE=paper (got ${JSON.stringify(env.PERP_MODE)})`);
  if (env.PERP_LIVE !== undefined) throw new Error('the intake lab refuses to start with PERP_LIVE set');
}

export function resolveLabConfig(env: NodeJS.ProcessEnv, repoRoot: string): LabConfig {
  const num = (name: string, fallback: number, ok: (n: number) => boolean, rule: string): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`${name} must be ${rule}, got ${JSON.stringify(raw)}`);
    return n;
  };
  const dataDir = env.LAB_DATA_DIR || path.join(repoRoot, 'data', 'perp'); // empty string counts as unset
  return {
    capUsd: num('LAB_DAILY_USD_CAP', 0.5, (n) => n > 0 && n <= 2, 'a number of dollars above 0 and at most 2 (the audit budget is small by design)'),
    days: num('LAB_DAYS', 7, (n) => Number.isInteger(n) && n >= 1 && n <= 30, 'a whole number of days from 1 to 30'),
    seed: num('LAB_SEED', 20261014, (n) => Number.isInteger(n) && n >= 0, 'a non-negative integer'),
    dataDir,
    botDbPath: env.LAB_BOT_DB || path.join(dataDir, 'perp-paper.db'),
    prefilterFile: env.PERP_PREFILTER_FILE || path.join(repoRoot, 'config', 'perp-prefilter.json'),
  };
}
