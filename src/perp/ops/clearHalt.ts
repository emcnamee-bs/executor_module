// src/perp/ops/clearHalt.ts
import type Database from 'better-sqlite3';
import { clearHalt } from '../risk/state.js';
import { appendJournal, loadRiskState, saveRiskState, setState } from '../store/db.js';

/**
 * Operator action: lift a halt. Records a kill-switch epoch so exits and equity peaks from before the clear no longer
 * count, otherwise the same old stop-outs would re-halt the bot on the next tick. The running bot re-reads the risk
 * state from the database on every tick, so this works while the service is up.
 */
export function clearHaltInDb(db: Database.Database, nowMs: number): { wasHalted: boolean; reason: string | null } {
  const risk = loadRiskState(db);
  const out = { wasHalted: risk.halted, reason: risk.haltReason };
  saveRiskState(db, clearHalt(risk));
  setState(db, 'killEpoch', { sinceMs: nowMs });
  appendJournal(db, { tsMs: nowMs, kind: 'halt_cleared', payload: out });
  return out;
}

/**
 * Operator guard for the clear-halt script: clearing also starts a new kill-switch epoch (the old exits and equity
 * peak stop counting), so doing it when the bot is not halted needs an explicit --force.
 */
export function shouldClear(wasHalted: boolean, force: boolean): boolean {
  return wasHalted || force;
}
