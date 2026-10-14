// src/perp/engine/engine.ts
import type Database from 'better-sqlite3';
import type { Broker, BrokerEvent } from '../broker/types.js';
import type { PerpConfig } from '../config.js';
import { summarizeContext } from '../model/context.js';
import { decide, type NewItem, type PolicyInput } from '../policy/policy.js';
import { stopFraction } from '../quant/formulas.js';
import { PressureBook } from '../quant/pressure.js';
import { computeGovernors } from '../risk/governor.js';
import { evaluateKillSwitch } from '../risk/killSwitch.js';
import { applyEntry, applyExit, haltRisk, type RiskState } from '../risk/state.js';
import { buildSnapshot, vixOf } from '../snapshot/builder.js';
import {
  appendJournal, equityPeak, getState, listAssessments, listExits, loadPosition, loadRiskState, markSeries,
  recordAssessment, recordEquity, recordExit as recordExitRow, saveRiskState, savePosition, saveSnapshot, setState,
  snapshotNear,
} from '../store/db.js';
import type { Action, ExitRule, ImpactAssessment, MacroPoint, PositionState, ScheduledEvent, Side, Snapshot } from '../types.js';
import { extremeSince } from './helpers.js';
import { Mutex } from './mutex.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NEWS_EXIT_RULES: ReadonlySet<ExitRule> = new Set<ExitRule>(['shock', 'slow_bleed', 'pressure']);
const PUBLISH_SNAPSHOT_MAX_GAP_MS = 2 * MIN;
const HOLD_JOURNAL_EVERY_MS = 10 * MIN;
const CONSECUTIVE_FAILURE_ALERT = 5;

export interface Collected {
  perp: Snapshot['perp'];
  perpFetchedAtMs: number;
  macro: Record<string, MacroPoint>;
  macroFetchedAtMs: number | null;
  events: ScheduledEvent[];
  kalshiEvents: Snapshot['kalshiEvents'];
}

export interface EngineDeps {
  cfg: PerpConfig;
  db: Database.Database;
  broker: Broker;
  now: () => number;
  collect: () => Promise<Collected>;
  /** Fire-and-forget notification (Slack). */
  alert: (message: string) => void;
  /** Persists broker state that lives only in memory (paper). Called after every state change. */
  persistBroker?: () => void;
  /** Paper only: applies one funding settlement and returns the USD charged. */
  applyFunding?: (rate: number, markPrice: number) => number;
}

export class PerpEngine {
  private readonly lock = new Mutex();
  private readonly book: PressureBook;
  private risk: RiskState;
  private position: PositionState | null;
  private breachStreak: number;
  private latest: Snapshot | null = null;
  private lastFundingEstimate: number | null = null;
  private consecutiveFailures = 0;
  private lastHoldJournalMs = 0;
  private lastAwaitJournalMs = 0;

  constructor(private readonly d: EngineDeps) {
    this.book = new PressureBook(d.cfg);
    this.risk = loadRiskState(d.db);
    this.position = loadPosition(d.db);
    this.breachStreak = getState<number>(d.db, 'breachStreak') ?? 0;
    for (const a of listAssessments(d.db, d.now() - 20 * DAY)) this.book.add(a);
  }

  start(): Promise<void> {
    return this.lock.run(() => this.reconcile());
  }

  tick(): Promise<void> {
    return this.lock.run(() => this.tickInner());
  }

  onAssessment(a: ImpactAssessment): Promise<void> {
    return this.lock.run(() => this.assessInner(a));
  }

  contextText(): string | null {
    if (this.latest === null) return null;
    const now = this.d.now();
    return summarizeContext({
      snapshot: this.latest,
      position: this.position,
      pressureNow: this.book.at(now),
      topItems: this.book.top(now, 3),
    });
  }

  status() {
    return {
      position: this.position,
      halted: this.risk.halted,
      haltReason: this.risk.haltReason,
      pressure: this.book.at(this.d.now()),
      mark: this.latest?.perp.mark ?? null,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  // ---- tick ---------------------------------------------------------------------------------------------------

  private async tickInner(): Promise<void> {
    const now = this.d.now();
    try {
      this.risk = loadRiskState(this.d.db); // picks up an operator halt-clear
      const snapshot = await this.collectSnapshot(now);
      this.applyFundingIfDue(now); // uses the estimate from BEFORE this snapshot: the new period's estimate has reset
      this.lastFundingEstimate = snapshot.perp.fundingEstimate ?? this.lastFundingEstimate;
      const events = await this.d.broker.poll();
      if (events.length > 0) this.handleBrokerEvents(events, now);
      await this.checkKillSwitch(now);
      await this.evaluate(snapshot, [], true);
      if (this.position !== null) savePosition(this.d.db, this.position);
      this.d.persistBroker?.();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      appendJournal(this.d.db, { tsMs: now, kind: 'tick_error', payload: { error: msg, consecutive: this.consecutiveFailures } });
      console.error('[perp-engine] tick failed:', msg);
      if (this.consecutiveFailures === CONSECUTIVE_FAILURE_ALERT) {
        this.d.alert(
          `[PERP] ${CONSECUTIVE_FAILURE_ALERT} consecutive tick failures (latest: ${msg}). ` +
            (this.position !== null ? 'The open position stays protected by the exchange-side stop.' : 'No position is open.')
        );
      }
    }
  }

  private async collectSnapshot(now: number): Promise<Snapshot> {
    const c = await this.d.collect();
    const snapshot = buildSnapshot({
      nowMs: now,
      perp: c.perp,
      perpFetchedAtMs: c.perpFetchedAtMs,
      macro: c.macro,
      macroFetchedAtMs: c.macroFetchedAtMs,
      events: c.events,
      kalshiEvents: c.kalshiEvents,
      history: markSeries(this.d.db, now - 8 * DAY),
    });
    saveSnapshot(this.d.db, snapshot);
    this.latest = snapshot;
    return snapshot;
  }

  private applyFundingIfDue(now: number): void {
    const apply = this.d.applyFunding;
    if (apply === undefined || this.lastFundingEstimate === null || this.latest === null) return;
    const d = new Date(now);
    const settlement = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20);
    const day = d.toISOString().slice(0, 10);
    if (now < settlement || getState<string>(this.d.db, 'lastFundingDay') === day) return;
    const charge = apply(this.lastFundingEstimate, this.latest.perp.mark);
    setState(this.d.db, 'lastFundingDay', day);
    appendJournal(this.d.db, { tsMs: now, kind: 'funding', payload: { rate: this.lastFundingEstimate, chargeUsd: charge } });
  }

  private handleBrokerEvents(events: BrokerEvent[], now: number): void {
    for (const e of events) {
      // An external close of unknown cause is treated as a stop-out: the conservative cooldown and kill-switch count.
      const rule: ExitRule = e.kind === 'closed_externally' ? 'trailing_stop' : e.rule;
      const pnl = e.pnlUsd ?? 0;
      this.recordExitAndRisk(rule, e.side, pnl, now);
      this.position = null;
      savePosition(this.d.db, null);
      appendJournal(this.d.db, { tsMs: now, kind: 'broker_event', payload: { ...e, classifiedAs: rule } });
      this.d.alert(
        e.kind === 'closed_externally'
          ? `[PERP ${this.d.broker.mode}] ${e.side} position was closed outside the bot (P&L ${e.pnlUsd === null ? 'unknown' : e.pnlUsd.toFixed(3)}); treated as a stop-out. Verify on Kalshi.`
          : `[PERP ${this.d.broker.mode}] ${e.kind === 'liquidated' ? 'LIQUIDATED' : 'stopped out'} ${e.side}, P&L ${e.pnlUsd.toFixed(3)} USD`
      );
    }
  }

  private async checkKillSwitch(now: number): Promise<void> {
    const bal = await this.d.broker.balance();
    recordEquity(this.d.db, now, bal.equityUsd);
    const epoch = getState<{ sinceMs: number }>(this.d.db, 'killEpoch')?.sinceMs ?? 0;
    const res = evaluateKillSwitch({
      exits: listExits(this.d.db, Math.max(epoch, now - 30 * DAY)),
      equityPeak: equityPeak(this.d.db, epoch),
      equityNow: bal.equityUsd,
      nowMs: now,
      cfg: this.d.cfg,
    });
    if (res.halt && !this.risk.halted) {
      this.risk = haltRisk(this.risk, res.reason ?? 'kill switch');
      saveRiskState(this.d.db, this.risk);
      appendJournal(this.d.db, { tsMs: now, kind: 'halt', payload: { reason: res.reason } });
      this.d.alert(`[PERP ${this.d.broker.mode}] HALTED: ${res.reason}. No new entries until the operator clears it (npm run perp-clear-halt).`);
    }
  }

  // ---- news ---------------------------------------------------------------------------------------------------

  private async assessInner(a: ImpactAssessment): Promise<void> {
    try {
      if (!recordAssessment(this.d.db, a)) return; // duplicate delivery
      this.book.add(a);
      const snap = this.latest;
      if (snap === null) return;
      const item: NewItem = { ...a, movedSincePublish: this.movedSincePublish(a, snap) };
      await this.evaluate(snap, [item], true);
      if (this.position !== null) savePosition(this.d.db, this.position);
      this.d.persistBroker?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendJournal(this.d.db, { tsMs: this.d.now(), kind: 'assess_error', payload: { itemId: a.itemId, error: msg } });
      console.error('[perp-engine] assessment handling failed:', msg);
    }
  }

  /** Perp move since the item's publish time, signed in the item's direction; null when we have no price from then. */
  private movedSincePublish(a: ImpactAssessment, snap: Snapshot): number | null {
    if (a.direction === 'neutral') return 0;
    const then = snapshotNear(this.d.db, a.publishedAtMs, PUBLISH_SNAPSHOT_MAX_GAP_MS);
    if (then === null || then.perp.mark <= 0) return null;
    const move = snap.perp.mark / then.perp.mark - 1;
    return a.direction === 'up' ? move : -move;
  }

  // ---- evaluate / execute -------------------------------------------------------------------------------------

  private async evaluate(snapshot: Snapshot, newItems: NewItem[], allowFlip: boolean): Promise<void> {
    const { cfg, db, broker } = this.d;
    const now = this.d.now();
    const mark = snapshot.perp.mark;
    if (this.position !== null) {
      const p = this.position;
      p.extreme = p.side === 'long' ? Math.max(p.extreme, mark) : Math.min(p.extreme, mark);
    }

    const governors = computeGovernors(cfg, vixOf(snapshot), snapshot.realizedWeeklySigma);
    const bal = await broker.balance();
    const bp = this.position !== null ? await broker.position() : null;
    if (this.position !== null && bp === null) {
      // The broker no longer sees the position but has not classified the exit yet (poll() returns nothing until the
      // fills are visible). Deciding now could close a position that is already gone, so wait for the exit event.
      if (now - this.lastAwaitJournalMs >= HOLD_JOURNAL_EVERY_MS) {
        this.lastAwaitJournalMs = now;
        appendJournal(db, { tsMs: now, kind: 'awaiting_exit_classification', payload: { side: this.position.side, mark } });
      }
      return;
    }
    const realizedLeverage = this.position === null && bal.equityUsd > 0 ? mark / bal.equityUsd : null; // 1 contract
    const weeklyExtreme =
      this.position === null
        ? null
        : extremeSince(markSeries(db, Math.max(this.position.entryTimeMs, now - 7 * DAY)), this.position.side);

    const input: PolicyInput = {
      nowMs: now,
      cfg,
      snapshot,
      position: this.position,
      pressureNow: this.book.at(now),
      pressure12hAgo: this.book.at(now - 12 * HOUR),
      newItems,
      governors,
      realizedLeverage,
      liqDistance: bp?.liqDistance ?? null,
      weeklyExtreme,
      risk: this.risk,
      prevBreachStreak: this.breachStreak,
    };
    const out = decide(input);
    this.breachStreak = out.breachStreak;
    setState(db, 'breachStreak', this.breachStreak);

    const interesting = out.action.kind !== 'hold' || newItems.length > 0;
    if (interesting || now - this.lastHoldJournalMs >= HOLD_JOURNAL_EVERY_MS) {
      if (!interesting) this.lastHoldJournalMs = now;
      appendJournal(db, {
        tsMs: now,
        kind: 'decision',
        payload: {
          action: out.action,
          pressureNow: input.pressureNow,
          mark,
          position: this.position?.side ?? null,
          items: newItems.map((i) => i.itemId),
          leverageEff: { long: governors.long.leverageEff, short: governors.short.leverageEff },
          sigmaSource: governors.long.sigmaSource,
          realizedLeverage,
        },
      });
    }
    await this.execute(out.action, snapshot, newItems, allowFlip);
  }

  private async execute(a: Action, snapshot: Snapshot, newItems: NewItem[], allowFlip: boolean): Promise<void> {
    const { db, broker } = this.d;
    const now = this.d.now();

    if (a.kind === 'open') {
      const stopBps = Math.max(1, Math.round(a.stopFrac * 10_000));
      try {
        const fill = await broker.open({ side: a.side, contracts: 1, stopBps });
        this.position = {
          side: a.side, contracts: fill.contracts, entryPrice: fill.price, entryTimeMs: now,
          extreme: snapshot.perp.mark, leverage: a.leverage, stopBps, tightenedUntilMs: null,
        };
        savePosition(db, this.position);
        this.risk = applyEntry(this.risk, a.side);
        saveRiskState(db, this.risk);
        this.d.persistBroker?.();
        appendJournal(db, { tsMs: now, kind: 'open', payload: { side: a.side, fill, stopBps, leverage: a.leverage, reasons: a.reasons } });
        this.d.alert(
          `[PERP ${broker.mode}] OPENED ${a.side} ${fill.contracts} @ ${fill.price} (stop ${stopBps} bps, ~${a.leverage.toFixed(2)}x). ${a.reasons[0] ?? ''}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendJournal(db, { tsMs: now, kind: 'open_failed', payload: { side: a.side, error: msg } });
        this.d.alert(`[PERP ${broker.mode}] open failed (${a.side}): ${msg}`);
        // The broker flags a rejected open that may still have left a filled position with no exchange-side stop
        // (duck-typed so the engine does not depend on the broker module). Re-run reconciliation now: it adopts an
        // orphan broker position and sets a trailing stop. We already hold the engine lock, so call the private,
        // unlocked reconcile(), not the public start().
        if ((err as { positionMayBeOpen?: boolean } | null)?.positionMayBeOpen === true) {
          appendJournal(db, { tsMs: now, kind: 'open_failed_unprotected', payload: { side: a.side, error: msg } });
          this.d.alert(
            `[PERP ${broker.mode}] URGENT: the ${a.side} open failed but a position may be open WITHOUT a stop at the exchange (${msg}). Reconciling now; verify on Kalshi.`
          );
          await this.reconcile();
        }
      }
      return;
    }

    if (a.kind === 'close' && this.position !== null) {
      const side = this.position.side;
      try {
        const res = await broker.close();
        this.recordExitAndRisk(a.rule, side, res.pnlUsd, now);
        this.position = null;
        savePosition(db, null);
        this.d.persistBroker?.();
        appendJournal(db, { tsMs: now, kind: 'close', payload: { rule: a.rule, side, fill: res, reasons: a.reasons } });
        this.d.alert(`[PERP ${broker.mode}] CLOSED ${side} (${a.rule}) @ ${res.price}, P&L ${res.pnlUsd.toFixed(3)} USD. ${a.reasons[0] ?? ''}`);
        await this.checkKillSwitch(now);
        if (allowFlip && NEWS_EXIT_RULES.has(a.rule)) await this.evaluate(snapshot, newItems, false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendJournal(db, { tsMs: now, kind: 'close_failed', payload: { rule: a.rule, error: msg } });
        this.d.alert(`[PERP ${broker.mode}] close failed (${a.rule}): ${msg}. The exchange-side stop remains in force; retrying next evaluation.`);
      }
      return;
    }

    if (a.kind === 'set_stop' && this.position !== null) {
      const bps = Math.max(1, Math.round(a.stopFrac * 10_000));
      try {
        await broker.setTrailingStop(bps);
        this.position = { ...this.position, stopBps: bps, tightenedUntilMs: a.holdMs === null ? null : now + a.holdMs };
        savePosition(db, this.position);
        this.d.persistBroker?.();
        appendJournal(db, { tsMs: now, kind: 'set_stop', payload: { bps, holdMs: a.holdMs, reasons: a.reasons } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendJournal(db, { tsMs: now, kind: 'set_stop_failed', payload: { bps, error: msg } });
        this.d.alert(`[PERP ${broker.mode}] could not update the trailing stop to ${bps} bps: ${msg}`);
      }
    }
  }

  private recordExitAndRisk(rule: ExitRule, side: Side, pnlUsd: number, now: number): void {
    recordExitRow(this.d.db, { atMs: now, rule, side, pnlUsd });
    this.risk = applyExit(this.risk, { rule, side, atMs: now }, this.d.cfg);
    saveRiskState(this.d.db, this.risk);
    this.breachStreak = 0;
    setState(this.d.db, 'breachStreak', 0);
  }

  // ---- startup reconciliation ---------------------------------------------------------------------------------

  private async reconcile(): Promise<void> {
    const { db, broker, cfg } = this.d;
    const now = this.d.now();
    try {
      const bp = await broker.position();
      const stored = this.position;
      if (stored === null && bp === null) return;

      try {
        if (this.latest === null) await this.collectSnapshot(now);
      } catch {
        // No snapshot yet: an adopted position falls back to the widest allowed stop below.
      }

      if (stored !== null && bp === null) {
        appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'vanished', stored } });
        this.recordExitAndRisk('trailing_stop', stored.side, 0, now);
        this.position = null;
        savePosition(db, null);
        this.d.alert(`[PERP ${broker.mode}] the stored ${stored.side} position vanished while the bot was down; recorded as an unverified stop-out. Check Kalshi.`);
        return;
      }
      if (stored === null && bp !== null) {
        const bal = await broker.balance();
        const lev = bal.equityUsd > 0 ? (bp.markPrice * bp.contracts) / bal.equityUsd : cfg.leverageTarget;
        const gov = this.latest === null ? null : computeGovernors(cfg, vixOf(this.latest), this.latest.realizedWeeklySigma)[bp.side];
        const stopBps = Math.round((gov === null ? cfg.stopCap : stopFraction(gov.sigmaWeek, lev, cfg)) * 10_000);
        await broker.setTrailingStop(stopBps);
        this.position = {
          side: bp.side, contracts: bp.contracts, entryPrice: bp.entryPrice, entryTimeMs: now,
          extreme: bp.markPrice, leverage: lev, stopBps, tightenedUntilMs: null,
        };
        savePosition(db, this.position);
        appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'orphan_adopted', position: this.position } });
        this.d.alert(`[PERP ${broker.mode}] found an orphan ${bp.side} position at the broker; adopted it and set a ${stopBps} bps trailing stop.`);
        return;
      }
      if (stored !== null && bp !== null && stored.side !== bp.side) {
        this.risk = haltRisk(this.risk, `stored ${stored.side} position conflicts with broker ${bp.side} position`);
        saveRiskState(db, this.risk);
        appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'side_mismatch', stored, broker: bp } });
        this.d.alert(`[PERP ${broker.mode}] HALTED: stored ${stored.side} position conflicts with the broker's ${bp.side} position. Resolve manually.`);
        return;
      }
      appendJournal(db, { tsMs: now, kind: 'reconcile', payload: { result: 'consistent' } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendJournal(db, { tsMs: now, kind: 'reconcile_error', payload: { error: msg } });
      this.d.alert(`[PERP ${this.d.broker.mode}] startup reconciliation failed: ${msg}`);
    }
  }
}
