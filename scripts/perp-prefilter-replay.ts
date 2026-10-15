// scripts/perp-prefilter-replay.ts
// Read-only: replays the last N hours of the live news stream through the prefilter and prints the funnel.
// Usage: npm run perp-prefilter-replay -- [--hours 6] [--config config/perp-prefilter.json]
// Needs REDIS_URL (the same env the bot uses). Nothing is written anywhere.
import path from 'node:path';
import { parseItemFields, type Item } from '../src/item.js';
import { createRedisClient } from '../src/redis/client.js';
import { loadPrefilterConfig } from '../src/perp/intake/prefilter.js';
import { parseArgs } from '../src/perp/ops/args.js';
import { formatReplay, replayItems } from '../src/perp/ops/replay.js';

const args = parseArgs(process.argv.slice(2), { values: ['hours', 'config'] });
if (!args.ok) {
  console.error(args.error);
  console.error('usage: perp-prefilter-replay [--hours 6] [--config config/perp-prefilter.json]');
  process.exit(2);
}
const hours = Number(args.values.hours ?? 6);
if (!Number.isFinite(hours) || hours <= 0 || hours > 72) {
  console.error('--hours must be a number from 0 to 72');
  process.exit(2);
}
const cfg = loadPrefilterConfig(path.resolve(args.values.config ?? 'config/perp-prefilter.json'));
const client = createRedisClient();
await client.connect();
const items: Item[] = [];
let from = `${Date.now() - hours * 3_600_000}-0`;
for (;;) {
  const page = await client.xRange('iip:items', from, '+', { COUNT: 1000 });
  if (page.length === 0) break;
  for (const e of page) {
    const parsed = parseItemFields(e.message as Record<string, string>);
    if (parsed.ok) items.push(parsed.item);
  }
  from = `(${page[page.length - 1].id}`;
  if (page.length < 1000) break;
}
await client.quit();
console.log(formatReplay(replayItems(items, cfg)));
