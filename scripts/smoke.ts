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
  console.log(
    "[smoke] NOTE: Kalshi's `position` is SIGNED -- positive is a YES holding, " +
      'negative is a NO holding. Fill detection depends on that; if any position ' +
      'above looks like an unsigned magnitude, stop and re-verify before going live.'
  );

  // The one genuinely UNVERIFIED assumption in the reconciliation path: no sibling
  // production client ever calls getOrders with a client_order_id filter, so
  // whether Kalshi honours it (rather than silently ignoring it and returning
  // everything) has never been confirmed against the live API. Reconciliation only
  // treats an exact client_order_id match in the response as "Kalshi has a record",
  // so an ignored filter degrades to a broader scan rather than a false positive --
  // but an operator should still SEE the real behaviour before trusting it.
  const probeClientOrderId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  console.log(`[smoke] probing getOrders({ client_order_id: '${probeClientOrderId}' })...`);
  const orders = await client.getOrders({ client_order_id: probeClientOrderId });
  console.log(`[smoke] orders (raw): ${JSON.stringify(orders)}`);
  console.log(
    `[smoke] EXPECTED: an empty orders list (that id was never submitted). If instead ` +
      `it lists unrelated orders, Kalshi is IGNORING the client_order_id filter -- note ` +
      `that before relying on it for reconciliation.`
  );

  console.log('[smoke] OK -- credentials and signing verified. No order was placed.');
}

main().catch((err) => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
