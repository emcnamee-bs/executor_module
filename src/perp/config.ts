// src/perp/config.ts
import { z } from 'zod';

const frac = z.number().gt(0).lt(1);
const unit = z.number().min(0).max(1);
const posNum = z.number().gt(0);

const BaseSchema = z
  .object({
    ticker: z.string().min(1),
    allowLong: z.boolean(),
    allowShort: z.boolean(),
    leverageTarget: z.number().gt(0).max(20),
    lossBudget: frac,
    sigmaK: posNum,
    stopFloor: frac,
    stopCap: frac,
    softDrawdown: frac,
    maintenanceMargin: z.object({ long: frac, short: frac }).strict(),
    tauDays: posNum,
    pEntryLong: frac,
    shortBar: z.number().gte(1),
    pExit: frac,
    confLong: unit,
    confShort: unit,
    shockConfidence: unit,
    shockCredibility: unit,
    latenessMaxFrac: z.number().gt(0).max(1),
    weekendFlatMinutes: z.number().int().min(0),
    weekendHoldMult: z.number().gte(1),
    noTradeMinutesAroundEvents: z.number().int().min(0),
    eventTightenMinutes: z.number().int().min(0),
    cooldownHours: z.number().min(0),
    stopOutCooldownHours: z.number().min(0),
    reentryMult: z.number().gte(1),
    minLeverage: posNum,
    entryLeverageSlack: z.number().gte(1),
    killStopOuts30d: z.number().int().min(1),
    killDrawdown: frac,
    killExits24h: z.number().int().min(1),
    tightenSigmaDayMult: posNum,
    tightenFloor: frac,
    tightenHoldMinutes: z.number().int().min(0),
    resyncMinChange: frac,
    staleSnapshotMs: z.number().int().positive(),
    bucketMove: z.object({ minor: frac, moderate: frac, major: frac, shock: frac }).strict(),
    noveltyWeight: z.object({ new: unit, known: unit }).strict(),
    pricedWeight: z.object({ yes: unit, unclear: unit, no: unit }).strict(),
    horizonTauFactor: z.object({ intraday: posNum, days: posNum, week: posNum }).strict(),
  })
  .strict();

const ConfigSchema = BaseSchema.superRefine((c, ctx) => {
  if (c.stopFloor > c.stopCap) {
    ctx.addIssue({ code: 'custom', path: ['stopFloor'], message: 'stopFloor must not exceed stopCap' });
  }
});

const OverrideSchema = BaseSchema.deepPartial();

export type PerpConfig = z.infer<typeof BaseSchema>;

export const DEFAULT_CONFIG: PerpConfig = {
  ticker: 'KXUS500PERP',
  allowLong: true,
  allowShort: true,
  leverageTarget: 4,
  lossBudget: 0.2,
  sigmaK: 1.75,
  stopFloor: 0.03,
  stopCap: 0.05,
  softDrawdown: 0.03,
  maintenanceMargin: { long: 0.0502, short: 0.056 },
  tauDays: 2,
  pEntryLong: 0.015,
  shortBar: 1.25,
  pExit: 0.02,
  confLong: 0.6,
  confShort: 0.7,
  shockConfidence: 0.7,
  shockCredibility: 0.7,
  latenessMaxFrac: 0.4,
  weekendFlatMinutes: 30,
  weekendHoldMult: 1.5,
  noTradeMinutesAroundEvents: 5,
  eventTightenMinutes: 60,
  cooldownHours: 4,
  stopOutCooldownHours: 24,
  reentryMult: 1.2,
  minLeverage: 2,
  entryLeverageSlack: 1.05,
  killStopOuts30d: 2,
  killDrawdown: 0.3,
  killExits24h: 3,
  tightenSigmaDayMult: 1.5,
  tightenFloor: 0.01,
  tightenHoldMinutes: 120,
  resyncMinChange: 0.005,
  staleSnapshotMs: 180_000,
  bucketMove: { minor: 0.005, moderate: 0.015, major: 0.03, shock: 0.05 },
  noveltyWeight: { new: 1, known: 0.25 },
  pricedWeight: { yes: 0.3, unclear: 0.7, no: 1 },
  horizonTauFactor: { intraday: 0.25, days: 1, week: 1.5 },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/** Defaults, optionally overridden by the PERP_CONFIG_JSON env var (deep-merged, validated, unknown keys rejected). */
export function loadPerpConfig(env: NodeJS.ProcessEnv): PerpConfig {
  const raw = env.PERP_CONFIG_JSON;
  if (raw === undefined || raw.trim() === '') return ConfigSchema.parse(DEFAULT_CONFIG);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PERP_CONFIG_JSON is not valid JSON: ${(err as Error).message}`);
  }
  const override = OverrideSchema.parse(parsed) as Record<string, unknown>;
  return ConfigSchema.parse(deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, override));
}
