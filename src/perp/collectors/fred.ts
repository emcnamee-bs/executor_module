// src/perp/collectors/fred.ts
import type { MacroPoint } from '../types.js';

/** Snapshot key -> FRED series id. FRED daily series lag by about a day; `asOf` carries the observation date. */
export const MACRO_SERIES: Record<string, string> = {
  vix: 'VIXCLS',
  vix3m: 'VXVCLS',
  us2y: 'DGS2',
  us10y: 'DGS10',
  hyOas: 'BAMLH0A0HYM2',
  dollar: 'DTWEXBGS',
  wti: 'DCOILWTICO',
  sp500: 'SP500',
};

/** Parses FRED's two-column CSV (`observation_date,<ID>` or the older `DATE,<ID>`), keeping valid numeric rows only. */
export function parseFredCsv(text: string): Array<{ date: string; value: number }> {
  const rows: Array<{ date: string; value: number }> = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!date || raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '.') continue;
    const value = Number(trimmed);
    if (Number.isFinite(value)) rows.push({ date: date.trim(), value });
  }
  return rows;
}

export function latestPoint(rows: Array<{ date: string; value: number }>): MacroPoint | null {
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return { value: last.value, change1d: prev === null ? null : last.value - prev.value, asOf: last.date };
}

export async function fetchFredRows(seriesId: string, fetchFn: typeof fetch = fetch): Promise<Array<{ date: string; value: number }>> {
  const res = await fetchFn(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`FRED ${seriesId} -> HTTP ${res.status}`);
  return parseFredCsv(await res.text());
}

/** Latest value and 1-day change for every series in MACRO_SERIES; a failing series is skipped and logged, never thrown. */
export async function collectMacro(fetchFn: typeof fetch = fetch): Promise<Record<string, MacroPoint>> {
  const out: Record<string, MacroPoint> = {};
  await Promise.all(
    Object.entries(MACRO_SERIES).map(async ([key, id]) => {
      try {
        const point = latestPoint(await fetchFredRows(id, fetchFn));
        if (point !== null) out[key] = point;
      } catch (err) {
        console.error(`[perp-collectors] FRED ${id} failed:`, err instanceof Error ? err.message : String(err));
      }
    })
  );
  return out;
}
