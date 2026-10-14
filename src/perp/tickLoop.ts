// src/perp/tickLoop.ts
/**
 * Runs `engine.tick()` every `tickMs`, never overlapping two ticks, never leaking a rejection, and letting the
 * owner wait for an in-flight tick before it closes the database (a tick on a closed db would lose its writes).
 */
export function createTickLoop(engine: { tick(): Promise<void> }, tickMs: number): { stop(): Promise<void> } {
  let inflight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inflight !== null) return; // skip while a tick is still running
    inflight = (async () => engine.tick())()
      .catch((err: unknown) => {
        console.error('[perp] tick failed:', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        inflight = null;
      });
  }, tickMs);

  return {
    async stop(): Promise<void> {
      clearInterval(timer);
      if (inflight !== null) await inflight; // never rejects: the chain above swallows tick errors
    },
  };
}
