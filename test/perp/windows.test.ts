import { describe, it, expect } from 'vitest';
import { eventSoon, inEventWindow, minutesToClose } from '../../src/perp/time/windows.js';
import type { ScheduledEvent } from '../../src/perp/types.js';

const NOW = Date.UTC(2026, 9, 14, 15, 0, 0);
const MIN = 60_000;
const ev = (offsetMin: number, impact: 'high' | 'medium' = 'high'): ScheduledEvent => ({ tsMs: NOW + offsetMin * MIN, name: 'CPI', impact });

describe('minutesToClose', () => {
  it('is null when the close is unknown and signed otherwise', () => {
    expect(minutesToClose(NOW, null)).toBeNull();
    expect(minutesToClose(NOW, NOW + 90 * MIN)).toBe(90);
    expect(minutesToClose(NOW, NOW - 10 * MIN)).toBe(-10);
  });
});

describe('inEventWindow', () => {
  it('is true within +-minutes of a high-impact event, either side', () => {
    expect(inEventWindow(NOW, [ev(4)], 5)).toBe(true);
    expect(inEventWindow(NOW, [ev(-4)], 5)).toBe(true);
    expect(inEventWindow(NOW, [ev(6)], 5)).toBe(false);
  });
  it('ignores medium-impact events and an empty list', () => {
    expect(inEventWindow(NOW, [ev(1, 'medium')], 5)).toBe(false);
    expect(inEventWindow(NOW, [], 5)).toBe(false);
  });
});

describe('eventSoon', () => {
  it('is true only for a high-impact event strictly ahead and within the window', () => {
    expect(eventSoon(NOW, [ev(30)], 60)).toBe(true);
    expect(eventSoon(NOW, [ev(61)], 60)).toBe(false);
    expect(eventSoon(NOW, [ev(-5)], 60)).toBe(false);
    expect(eventSoon(NOW, [ev(30, 'medium')], 60)).toBe(false);
  });
});
