import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTickLoop } from '../../src/perp/tickLoop.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createTickLoop', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    errorSpy.mockRestore();
  });

  it('stop() waits for a tick that is already running, so the tick finishes before the db is closed', async () => {
    const slow = deferred();
    let dbClosed = false;
    let tickSawClosedDb: boolean | null = null;
    const engine = {
      tick: vi.fn(async () => {
        await slow.promise;
        tickSawClosedDb = dbClosed;
      }),
    };
    const loop = createTickLoop(engine, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.tick).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; dbClosed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); // the tick is still in flight

    slow.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(tickSawClosedDb).toBe(false); // the tick completed before the "db" was closed
  });

  it('a rejecting tick is logged, raises no unhandledRejection, and the loop keeps ticking', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const engine = { tick: vi.fn(async () => { throw new Error('boom'); }) };
      const loop = createTickLoop(engine, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(engine.tick).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(2);
      await loop.stop();
      // let Node's unhandled-rejection processing run
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('skips interval firings while a tick is still running', async () => {
    const slow = deferred();
    const engine = { tick: vi.fn(() => slow.promise) };
    const loop = createTickLoop(engine, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(engine.tick).toHaveBeenCalledTimes(1);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.tick).toHaveBeenCalledTimes(2); // resumes once the slow tick is done
    await loop.stop();
  });

  it('stop() with nothing in flight resolves at once and no further ticks happen', async () => {
    const engine = { tick: vi.fn(async () => undefined) };
    const loop = createTickLoop(engine, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.tick).toHaveBeenCalledTimes(1);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.tick).toHaveBeenCalledTimes(1);
    await expect(loop.stop()).resolves.toBeUndefined(); // idempotent
  });
});
