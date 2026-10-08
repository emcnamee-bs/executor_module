// scripts/build-trade.ts
//
// Builds (or rebuilds) a trade profile under trades/<series>/ from Kalshi's public
// market data plus two Sonnet calls. Costs two API calls; touches no live service.
//   npm run build-trade -- --series KXAAAGASW --direct aaa_national_average
import Anthropic from '@anthropic-ai/sdk';
import { buildTradeProfile } from '../src/profile/build.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const seriesTicker = arg('--series');
  if (!seriesTicker) throw new Error('--series <SERIES_TICKER> is required');
  const direct = (arg('--direct') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const { dir, profile } = await buildTradeProfile(
    {
      seriesTicker,
      directSources: direct,
      reuseKeyphrasesFile: arg('--reuse-keyphrases'),
      ledgerPath: arg('--ledger-path'),
      consumerGroup: arg('--consumer-group'),
      gateModel: arg('--gate-model'),
      allowLiveLedger: process.argv.includes('--allow-live-ledger'),
    },
    { client: new Anthropic() }
  );
  console.log(`[build-trade] wrote ${dir}`);
  console.log(`[build-trade] structure=${profile.marketStructure} unit=${profile.magnitudeUnit} maxMagnitude=${profile.maxMagnitude} direct=${JSON.stringify(profile.directSources)}`);
}

main().catch((err) => {
  console.error('[build-trade] failed, existing profile (if any) left untouched:', err);
  process.exit(1);
});
