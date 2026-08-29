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

  it('is a no-op (no fetch call) when SLACK_WEBHOOK_URL is unset', async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;

    await sendAlert('nobody hears this');

    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});
