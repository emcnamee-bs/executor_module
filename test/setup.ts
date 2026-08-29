// test/setup.ts
//
// Global vitest setup. Ensures the automated suite can never post a real
// Slack alert regardless of what's in the operator's own shell environment --
// tripBreaker (ledger.ts) fires sendAlert() on every breaker trip, including
// ones tripped incidentally by tests that don't spy on it at all. A machine
// that followed HANDOFF.md's own go-live checklist and set SLACK_WEBHOOK_URL
// would otherwise have `npm test` post real pages to the live channel.
delete process.env.SLACK_WEBHOOK_URL;
