import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // tripBreaker (ledger.ts) fires sendAlert() on every breaker trip, so any
    // test that trips one without its own vi.spyOn(alertModule, 'sendAlert')
    // still installs no mock -- but a test file that DOES spy on it must not
    // leak that spy into later tests in the same file. Restoring automatically
    // removes the need for every such test to remember its own
    // vi.restoreAllMocks() in afterEach.
    restoreMocks: true,
  },
});
