// src/perp/model/context.ts
import { sanitizeNote } from '../../guard/untrusted.js';
import type { PositionState, Snapshot } from '../types.js';

const pct = (x: number | null, digits = 2): string =>
  x === null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;

/** Compact, model-readable market context. Numbers are computed by code; the model only reads them. */
export function summarizeContext(i: {
  snapshot: Snapshot;
  position: PositionState | null;
  pressureNow: number;
  topItems: Array<{ itemId: string; contribution: number; rationale: string }>;
}): string {
  const s = i.snapshot;
  const lines: string[] = [];
  lines.push(
    `perp mark ${s.perp.mark} (bid ${s.perp.bid} / ask ${s.perp.ask}); 1d ${pct(s.returns.d1)}, 5d ${pct(s.returns.d5)}; ` +
      `market ${s.perp.marketOpen ? 'open' : 'closed'}`
  );
  const macro = Object.entries(s.macro).map(([k, p]) => {
    const name = k === 'vix' ? 'VIX' : k;
    const chg = p.change1d === null ? '' : ` (${p.change1d >= 0 ? '+' : ''}${p.change1d.toFixed(2)})`;
    return `${name} ${p.value}${chg}`;
  });
  lines.push(`macro: ${macro.length > 0 ? macro.join('; ') : 'n/a'}`);
  const events = s.events.map((e) => `${e.name} in ${((e.tsMs - s.tsMs) / 3_600_000).toFixed(1)}h (${e.impact})`);
  lines.push(`scheduled: ${events.length > 0 ? events.join('; ') : 'none in the next 72h'}`);
  const kalshi = s.kalshiEvents.map((k) => `${k.ticker} ${(k.yesProb * 100).toFixed(0)}%`);
  lines.push(`Kalshi consensus: ${kalshi.length > 0 ? kalshi.join('; ') : 'n/a'}`);
  lines.push(
    i.position === null
      ? 'position: flat'
      : `position: ${i.position.side} ${i.position.contracts} @ ${i.position.entryPrice}, stop ${i.position.stopBps} bps`
  );
  lines.push(`news pressure ${pct(i.pressureNow)} (positive = bullish)`);
  for (const t of i.topItems.slice(0, 3)) {
    lines.push(`  - ${pct(t.contribution)}: ${sanitizeNote(t.rationale, 140)}`);
  }
  return lines.join('\n');
}
