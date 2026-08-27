// test/decide/pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { runDecisionPipeline } from '../../src/decide/pipeline.js';
import { openLedger, hasOpenPosition, totalExposureCents } from '../../src/decide/ledger.js';
import type { Item } from '../../src/item.js';
import type { ActiveLadder } from '../../src/decide/kalshi.js';
import * as synopsisModule from '../../src/decide/synopsis.js';
import * as verifyModule from '../../src/decide/verify.js';
import * as decideModule from '../../src/decide/decide.js';

function baseItem(overrides: Partial<Item> = {}): Item {
  return {
    item_id: 'item-1',
    dedup_id: 'dedup-1',
    story_key: 'story-1',
    event_type: 'item',
    replay: false,
    source_id: 'bls_releases',
    adapter: 'feed',
    trust_tier: 1,
    headline: 'BLS reports unemployment rate fell to 3.9%',
    snippet: 'The unemployment rate declined to 3.9% in July.',
    url: null,
    raw_url: null,
    enrich_url: null,
    author: null,
    lang: null,
    body_state: 'absent',
    body: null,
    event_time: null,
    source_publish_ts: null,
    first_seen_ts: '2026-08-25T10:01:00Z',
    emitted_ts: '2026-08-25T10:01:05Z',
    latency_ms: 5000,
    is_first_sighting: true,
    corroborations: 0,
    provenance_gaps: [],
    amends_item_id: null,
    amendment_kind: null,
    ...overrides,
  };
}

// Deviation from the brief's literal fixture numbers (documented in the task report):
// the brief's original three-band fixture (40.0-40.2 / 40.2-40.4 ask 40/42, tail 12)
// is real market-shaped data, but run through the actual (Task-4, bug-fixed)
// evaluateSizing logic it never clears the edge/Kelly gates for direction 'up',
// magnitudePts 0.3, rung 'reported' -- the narrow 0.2pt band spacing means the
// shifted interpolation target clamps to a curve endpoint instead of landing
// strictly inside the curve, so no candidate ever earns enough edge to size a
// contract. Widening the two tradeable bands to 0.4pt spacing with more separated
// prices keeps the shifted target strictly inside the curve's interior and
// produces a real, sizeable edge, letting the "everything clears" tests exercise
// the actual would-trade path end-to-end.
function stubLadder(): ActiveLadder {
  return {
    eventTicker: 'KXAPRPOTUS-26AUG28',
    strikeDate: '2026-08-28T16:00:00Z',
    bands: [
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.2',
        floorStrike: 39.8,
        capStrike: 40.2,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 20,
        yesBidCents: 18,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-40.6',
        floorStrike: 40.2,
        capStrike: 40.6,
        strikeType: 'between',
        status: 'active',
        yesAskCents: 60,
        yesBidCents: 58,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
      {
        ticker: 'KXAPRPOTUS-26AUG28-41.0',
        floorStrike: 40.6,
        capStrike: null,
        strikeType: 'greater',
        status: 'active',
        yesAskCents: 12,
        yesBidCents: 10,
        yesAskSizeContracts: 500,
        yesBidSizeContracts: 500,
      },
    ],
  };
}

describe('runDecisionPipeline', () => {
  let dir: string;
  let db: Database.Database;
  let client: Anthropic;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pipeline-test-'));
    db = openLedger(path.join(dir, 'test.db'));
    client = new Anthropic({ apiKey: 'sk-ant-unused-in-these-tests' });
    delete process.env.EXECUTOR_TRADING_HALTED;
    vi.spyOn(synopsisModule, 'synopsize').mockResolvedValue('The unemployment rate fell to 3.9%.');
    vi.spyOn(verifyModule, 'verifySynopsis').mockResolvedValue({ supported: true, note: 'faithful' });
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
      direction: 'up',
      magnitudePts: 0.3,
      shouldTrade: true,
      reasoning: 'stronger-than-expected jobs data typically lifts approval',
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.EXECUTOR_TRADING_HALTED;
  });

  it('records a skip when the kill switch is set, and makes no model calls', async () => {
    process.env.EXECUTOR_TRADING_HALTED = 'true';
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(synopsisModule.synopsize).not.toHaveBeenCalled();
    expect(fetchLadder).not.toHaveBeenCalled();
    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('records a skip when verify reports unsupported, before rung/decide/sizing', async () => {
    vi.spyOn(verifyModule, 'verifySynopsis').mockResolvedValue({ supported: false, note: 'fabricated' });
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(decideModule.decideTrade).not.toHaveBeenCalled();
    expect(fetchLadder).not.toHaveBeenCalled();
  });

  it('records a skip when rung is rumor, without calling decideTrade', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem({ trust_tier: 3, story_key: null }), {
      anthropicClient: client,
      db,
      fetchLadder,
    });

    expect(decideModule.decideTrade).not.toHaveBeenCalled();
  });

  it('skips a story that already has an open position for the active event, without calling Sonnet decide', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());
    // First run: real would-trade path.
    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });
    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(true);

    vi.mocked(decideModule.decideTrade).mockClear();
    await runDecisionPipeline(baseItem({ item_id: 'item-2' }), { anthropicClient: client, db, fetchLadder });
    expect(decideModule.decideTrade).not.toHaveBeenCalled();
  });

  it('records a skip when Sonnet decide says should_trade=false', async () => {
    vi.spyOn(decideModule, 'decideTrade').mockResolvedValue({
      direction: 'up',
      magnitudePts: 0.1,
      shouldTrade: false,
      reasoning: 'too indirect to act on',
    });
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });

  it('records a would-trade decision and increases total exposure when everything clears', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(stubLadder());

    await runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder });

    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(true);
    expect(totalExposureCents(db)).toBeGreaterThan(0);
    expect(totalExposureCents(db)).toBeLessThanOrEqual(1000);
  });

  it('records a skip (not a throw) when fetchLadder returns null (no active event)', async () => {
    const fetchLadder = vi.fn().mockResolvedValue(null);

    await expect(
      runDecisionPipeline(baseItem(), { anthropicClient: client, db, fetchLadder })
    ).resolves.toBeUndefined();
    expect(hasOpenPosition(db, 'story-1', 'KXAPRPOTUS-26AUG28')).toBe(false);
  });
});
