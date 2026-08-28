// scripts/smoke.ts
//
// Manual, read-only sanity check against the REAL Kalshi API. Run this once before
// ever unsetting KALSHI_DRY_RUN, to confirm credentials and signing work end to end
// without placing any order. Not part of `npm test` -- invoke directly:
//   direnv exec . npx tsx scripts/smoke.ts

import { KalshiClient } from '../src/execute/kalshiClient.js';

function mustGetEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set (see .envrc)`);
  return value;
}

async function main(): Promise<void> {
  const client = new KalshiClient({
    apiKeyId: mustGetEnv('KALSHI_API_KEY_ID'),
    privateKeyPath: mustGetEnv('KALSHI_PRIVATE_KEY_PATH'),
  });

  console.log('[smoke] fetching balance...');
  const balance = await client.getBalance();
  console.log(`[smoke] balance: ${JSON.stringify(balance)}`);

  console.log('[smoke] fetching positions...');
  const positions = await client.getPositions();
  console.log(`[smoke] positions: ${JSON.stringify(positions)}`);

  console.log('[smoke] OK -- credentials and signing verified. No order was placed.');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
