import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../../src/perp/config.js";
import { DEFAULT_PAPER_CONFIG, PaperBroker } from "../../src/perp/broker/paper.js";
import type { BrokerQuote } from "../../src/perp/broker/types.js";
import { PerpEngine, type Collected } from "../../src/perp/engine/engine.js";
import { listExits, loadPosition, markSeries, openPerpDb, setState } from "../../src/perp/store/db.js";
import type { ImpactAssessment } from "../../src/perp/types.js";

const NOW0 = Date.UTC(2026, 9, 14, 15, 0, 0);
const SEC = 1000;
const MIN = 60_000;

function harness(fullSnapshotMs?: number) {
  let now = NOW0;
  const q = { bid: 13.75, ask: 13.76, mark: 13.755 };
  const getQuote = async (): Promise<BrokerQuote> => ({ ...q, tsMs: now });
  const broker = new PaperBroker(getQuote, { ...DEFAULT_PAPER_CONFIG }, () => now);
  const db = openPerpDb(":memory:");
  let collects = 0;
  const collect = async (): Promise<Collected> => {
    collects += 1;
    return {
      perp: { bid: q.bid, ask: q.ask, mark: q.mark, marketOpen: true, nextCloseTsMs: NOW0 + 3 * 24 * 60 * MIN, fundingEstimate: 0.0001 },
      perpFetchedAtMs: now,
      macro: { vix: { value: 16, change1d: 0, asOf: "2026-10-13" } },
      macroFetchedAtMs: now,
      events: [],
      kalshiEvents: [],
    };
  };
  const engine = new PerpEngine({
    cfg: DEFAULT_CONFIG, db, broker, now: () => now, collect, alert: () => undefined,
    persistBroker: () => setState(db, "paper", broker.exportState()),
    applyFunding: (r, m) => broker.applyFunding(r, m),
    fullSnapshotMs,
  });
  const rows = () => markSeries(db, 0).length;
  return {
    engine, db, broker, rows,
    collects: () => collects,
    now: () => now,
    advance: (ms: number) => { now += ms; },
    setMark: (m: number) => { q.mark = m; q.bid = m - 0.005; q.ask = m + 0.005; },
  };
}

describe("full vs light ticks", () => {
  it("stores one snapshot row per full interval but collects a fresh quote on every tick", async () => {
    const h = harness(5 * MIN);
    for (let i = 0; i <= 20; i++) { // 21 ticks, 15 s apart = 5 minutes
      await h.engine.tick();
      h.advance(15 * SEC);
    }
    expect(h.collects()).toBe(21);
    expect(h.rows()).toBe(2); // t=0 and t=300 s
  });

  it("a light tick still moves the engine to the newest mark", async () => {
    const h = harness(5 * MIN);
    await h.engine.tick();
    h.advance(15 * SEC);
    h.setMark(13.9);
    await h.engine.tick();
    expect(h.rows()).toBe(1);
    expect(h.engine.status().mark).toBeCloseTo(13.9, 6);
  });

  it("without the option every tick is a full snapshot (previous behavior)", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) {
      await h.engine.tick();
      h.advance(15 * SEC);
    }
    expect(h.rows()).toBe(6);
  });

  it("an exit rule fires on a light tick, with no snapshot row written", async () => {
    const h = harness(5 * MIN);
    await h.engine.tick(); // full: first snapshot
    await h.engine.onAssessment({
      itemId: "item-1", receivedAtMs: h.now(), publishedAtMs: h.now() - 30_000, direction: "up", bucket: "major",
      horizon: "days", credibility: 0.8, novelty: "new", alreadyPriced: "no", confidence: 0.75, rationale: "test",
    } as ImpactAssessment);
    expect((await h.broker.position())?.side).toBe("long");
    h.advance(15 * SEC);
    h.setMark(14.2);
    await h.engine.tick(); // light
    h.advance(15 * SEC);
    h.setMark(13.6); // through the trailing stop (about 3.9% below the 14.2 high)
    await h.engine.tick(); // light
    expect(await h.broker.position()).toBeNull();
    expect(loadPosition(h.db)).toBeNull();
    expect(listExits(h.db, 0).map((e) => e.rule)).toEqual(["trailing_stop"]);
    expect(h.rows()).toBe(1); // still only the first full snapshot
  });
});
