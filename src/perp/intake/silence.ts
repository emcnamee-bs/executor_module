// src/perp/intake/silence.ts

export const IIP_SILENCE_THRESHOLD_MS = 30 * 60_000;

/**
 * IIP silence detector (pure). Alerts once when nothing has arrived on the stream for longer than `thresholdMs`,
 * counting from the later of the last entry and the process start (so a fresh start is not reported as silent
 * before it had a chance to hear anything). Re-arms once an entry arrives after the alert.
 */
export function checkSilence(
  state: { alerted: boolean },
  nowMs: number,
  lastEntryAtMs: number | null,
  startedAtMs: number,
  thresholdMs: number = IIP_SILENCE_THRESHOLD_MS
): { alert: boolean; silentForMs: number; state: { alerted: boolean } } {
  const since = Math.max(lastEntryAtMs ?? -Infinity, startedAtMs);
  const silentForMs = nowMs - since;
  if (!(silentForMs > thresholdMs)) return { alert: false, silentForMs, state: { alerted: false } };
  if (state.alerted) return { alert: false, silentForMs, state };
  return { alert: true, silentForMs, state: { alerted: true } };
}
