// scripts/build-trade.ts
//
// Builds (or rebuilds) a trade profile under trades/<series>/ from Kalshi's public
// market data plus two Sonnet calls. Costs two API calls; touches no live service.
//   npm run build-trade -- --series KXAAAGASW --direct aaa_national_average
// Flags: --series --direct --reuse-keyphrases --ledger-path --consumer-group --gate-model
//        --allow-live-ledger (boolean; needed to log into data/decisions.db)
import Anthropic from '@anthropic-ai/sdk';
import { buildTradeProfile } from '../src/profile/build.js';
import { parseBuildArgs } from '../src/profile/cliArgs.js';

async function main(): Promise<void> {
  const args = parseBuildArgs(process.argv.slice(2));
  const { dir, profile } = await buildTradeProfile(
    {
      seriesTicker: args.seriesTicker,
      directSources: args.directSources,
      reuseKeyphrasesFile: args.reuseKeyphrasesFile,
      ledgerPath: args.ledgerPath,
      consumerGroup: args.consumerGroup,
      gateModel: args.gateModel,
      allowLiveLedger: args.allowLiveLedger,
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
