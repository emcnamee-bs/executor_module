// test/smoke.test.ts
import { describe, it, expect } from 'vitest';

describe('toolchain smoke test', () => {
  it('runs TypeScript under vitest', () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
