import { describe, it, expect } from "vitest";
import { computeReturns, realizedWeeklySigma } from "../../src/perp/snapshot/builder.js";
import { loadCompactHistory } from "../../src/perp/snapshot/history.js";
import { marksReport, parseWhen } from "../../src/perp/ops/history.js";
import { hourlyMarks, markExtreme, markNear, markSeries, openPerpDb, recordMark } from "../../src/perp/store/db.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 14, 15, 7, 13); // deliberately not on an hour boundary

/** A deterministic pseudo-random walk, one mark per `stepMs`, with a 6 hour hole (like a weekend) 3 days back. */
function seeded(stepMs: number, days = 9) {
  const db = openPerpDb(":memory:");
  const ins = db.prepare("INSERT OR REPLACE INTO snapshots (ts_ms, mark, json) VALUES (?, ?, ?)");
  let x = 123456789;
  const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  let price = 13.7;
  db.transaction(() => {
    for (let t = NOW - days * DAY; t <= NOW; t += stepMs) {
      if (t > NOW - 3 * DAY && t < NOW - 3 * DAY + 6 * HOUR) continue;
      price *= 1 + rnd() * 0.0008;
      ins.run(t, price, "{}");
      recordMark(db, t, price);
    }
  })();
  return db;
}

describe("compact history equals the full series it replaces", () => {
  for (const [label, step] of [["60 s rows", 60 * SEC], ["15 s rows", 15 * SEC], ["5 min rows", 5 * MIN]] as const) {
    it(`same 1d/5d returns and realized sigma (${label})`, () => {
      const db = seeded(step);
      const mark = 13.9;
      const full = markSeries(db, NOW - 8 * DAY);
      const compact = loadCompactHistory(db, NOW);
      expect(compact.length).toBeLessThan(260);
      expect(computeReturns(NOW, mark, compact)).toEqual(computeReturns(NOW, mark, full));
      const a = realizedWeeklySigma(compact);
      const b = realizedWeeklySigma(full);
      expect(a).not.toBeNull();
      expect(a as number).toBeCloseTo(b as number, 12);
    });
  }

  it("yields no returns and no sigma on a database with only a couple of hours of rows", () => {
    const db = openPerpDb(":memory:");
    for (let t = NOW - 2 * HOUR; t <= NOW; t += MIN) recordMark(db, t, 13.7);
    const h = loadCompactHistory(db, NOW);
    expect(computeReturns(NOW, 13.7, h)).toEqual({ d1: null, d5: null });
    expect(realizedWeeklySigma(h)).toBeNull();
  });
});

describe("mark queries", () => {
  it("hourlyMarks returns the last mark of each hour, oldest first", () => {
    const db = openPerpDb(":memory:");
    const base = Date.UTC(2026, 9, 14, 10, 0, 0);
    recordMark(db, base + 5 * MIN, 1);
    recordMark(db, base + 55 * MIN, 2);
    recordMark(db, base + HOUR + 10 * MIN, 3);
    recordMark(db, base + HOUR + 20 * MIN, 4);
    expect(hourlyMarks(db, base)).toEqual([{ tsMs: base + 55 * MIN, mark: 2 }, { tsMs: base + HOUR + 20 * MIN, mark: 4 }]);
  });

  it("markNear picks the closer side and respects the maximum gap", () => {
    const db = openPerpDb(":memory:");
    recordMark(db, 1000, 1);
    recordMark(db, 5000, 2);
    expect(markNear(db, 2000, 10_000)).toEqual({ tsMs: 1000, mark: 1 });
    expect(markNear(db, 4000, 10_000)).toEqual({ tsMs: 5000, mark: 2 });
    expect(markNear(db, 100_000, 10_000)).toBeNull();
  });

  it("markExtreme is the max or min since a time, and null when empty", () => {
    const db = openPerpDb(":memory:");
    expect(markExtreme(db, 0, "max")).toBeNull();
    recordMark(db, 1000, 5);
    recordMark(db, 2000, 9);
    recordMark(db, 3000, 7);
    expect(markExtreme(db, 0, "max")).toBe(9);
    expect(markExtreme(db, 0, "min")).toBe(5);
    expect(markExtreme(db, 2500, "min")).toBe(7);
  });

  it("opening a database carries older snapshot rows into marks, once", () => {
    const db = openPerpDb(":memory:");
    db.prepare("INSERT INTO snapshots (ts_ms, mark, json) VALUES (1000, 5, '{}'), (2000, 6, '{}')").run();
    db.exec("DELETE FROM marks");
    db.exec(`INSERT OR IGNORE INTO marks (ts_ms, mark) SELECT ts_ms, mark FROM snapshots WHERE ts_ms > COALESCE((SELECT MAX(ts_ms) FROM marks), 0)`);
    expect(markExtreme(db, 0, "max")).toBe(6);
    expect((db.prepare("SELECT COUNT(*) n FROM marks").get() as { n: number }).n).toBe(2);
  });
});

describe("perp-history report", () => {
  it("summarizes and downsamples to at most maxRows, keeping the last mark of each bucket", () => {
    const db = seeded(60 * SEC, 2);
    const r = marksReport(db, NOW - DAY, NOW, 50);
    expect(r.rows.length).toBeLessThanOrEqual(50);
    expect(r.rows.length).toBeGreaterThan(30);
    expect(r.header).toMatch(/^# \d+ marks .* high .* low /);
    expect(r.rows[r.rows.length - 1].tsMs).toBe(NOW);
  });
  it("returns every row when there are few, and says so when there are none", () => {
    const db = openPerpDb(":memory:");
    expect(marksReport(db, 0, NOW, 10).rows).toEqual([]);
    recordMark(db, 1000, 1);
    recordMark(db, 2000, 2);
    expect(marksReport(db, 0, NOW, 10).rows).toHaveLength(2);
  });
  it("parses relative, ISO and epoch times", () => {
    expect(parseWhen("24h", NOW)).toBe(NOW - DAY);
    expect(parseWhen("30m", NOW)).toBe(NOW - 30 * MIN);
    expect(parseWhen("2026-10-14T00:00:00Z", NOW)).toBe(Date.UTC(2026, 9, 14));
    expect(parseWhen("1792004656951", NOW)).toBe(1792004656951);
    expect(parseWhen("garbage", NOW)).toBeNull();
  });
});
