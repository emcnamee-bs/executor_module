// test/alert.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendAlert } from '../src/alert.js';

describe('sendAlert', () => {
  let fetchSpy: { mockRestore: () => void } | undefined;
  const ORIGINAL_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/services/FAKE';
  });
  afterEach(() => {
    vi.useRealTimers();
    fetchSpy?.mockRestore();
    if (ORIGINAL_WEBHOOK_URL === undefined) delete process.env.SLACK_WEBHOOK_URL;
    else process.env.SLACK_WEBHOOK_URL = ORIGINAL_WEBHOOK_URL;
  });

  it('posts the message as-is on the first successful attempt, exactly once', async () => {
    let calls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls += 1;
      expect(JSON.parse(init?.body as string)).toEqual({ text: 'hello operator' });
      // Undici's default headersTimeout is 300s; a fire-and-forget POST nothing
      // awaits must not be able to hold the event loop open that long.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetchSpy;

    await sendAlert('hello operator');

    expect(calls).toBe(1);
  });

  it('retries exactly once after a short delay when the first attempt fails, then succeeds', async () => {
    let calls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return new Response('down', { status: 500 });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetchSpy;

    const promise = sendAlert('retry me');
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(calls).toBe(2);
  });

  it('gives up after the retry also fails, without throwing', async () => {
    let calls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      return new Response('still down', { status: 500 });
    }) as unknown as typeof fetchSpy;

    const promise = sendAlert('give up eventually');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBeUndefined();

    expect(calls).toBe(2);
  });

  it('never lets a malformed SLACK_WEBHOOK_URL reach a log line', async () => {
    // Deliberately NOT mocking fetch: the real fetch is what throws the TypeError
    // whose message embeds the full attempted URL ("Failed to parse URL from ..."),
    // and that message is the actual leak path. A malformed URL fails at parse
    // time, so this makes no network request.
    process.env.SLACK_WEBHOOK_URL = 'ht!tp://hooks.slack.test/services/T0/B0/SUPER-SECRET-TOKEN';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const promise = sendAlert('does this leak?');
      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      expect(errorSpy).toHaveBeenCalledTimes(2); // first attempt, then the retry
      const logged = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(logged).not.toContain('SUPER-SECRET-TOKEN');
      expect(logged).not.toContain('hooks.slack.test');
      expect(logged).toContain('TypeError'); // the type still makes it into the log
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs the status and body of a non-2xx Slack response, which carries no URL', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('invalid_payload', { status: 400 })
    ) as unknown as typeof fetchSpy;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const promise = sendAlert('rejected by slack');
      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      const logged = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('400');
      expect(logged).toContain('invalid_payload');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('is a no-op (no fetch call) when SLACK_WEBHOOK_URL is unset', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;

    await sendAlert('nobody hears this');

    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});
