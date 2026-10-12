// scripts/build-trade.ts
//
// Builds (or rebuilds) a trade profile under trades/<series>/ from Kalshi's public
// market data plus two Sonnet calls. Costs two API calls; touches no live service.
//   npm run build-trade -- --series KXAAAGASW --direct aaa_national_average
// Flags: --series --direct --reuse-keyphrases --ledger-path --consumer-group --gate-model
//        --allow-live-ledger (boolean; needed to log into data/decisions.db)
//        --validate (boolean; after building, replay the keyphrases over the iip archive, have the production gate judge a
//                    sample of each frequent phrase's hits, and drop the phrases it rejects; see scripts/validate-bank.ts)
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { buildTradeProfile } from '../src/profile/build.js';
import { parseBuildArgs } from '../src/profile/cliArgs.js';
import { loadCorpusFromIipDb } from '../src/profile/validate.js';
import { runValidation } from '../src/profile/validateRun.js';
import { DEFAULT_KEYPHRASE_FLOOR, DEFAULT_VALIDATE_OPTIONS } from '../src/profile/validateTrade.js';

async function main(): Promise<void> {
  const args = parseBuildArgs(process.argv.slice(2));
  const client = new Anthropic();
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
    { client }
  );
  console.log(`[build-trade] wrote ${dir}`);
  console.log(`[build-trade] structure=${profile.marketStructure} unit=${profile.magnitudeUnit} maxMagnitude=${profile.maxMagnitude} direct=${JSON.stringify(profile.directSources)}`);

  if (args.validate) {
    try {
      const iipDb = process.env.IIP_DB_PATH ?? path.join(os.homedir(), 'Internet_Info_Plug', 'data', 'iip.db');
      console.log(`[build-trade] validating the keyphrases against ${iipDb} (read-only)`);
      const corpus = loadCorpusFromIipDb(iipDb);
      const r = await runValidation(
        { names: [profile.name], apply: true, floor: DEFAULT_KEYPHRASE_FLOOR, options: DEFAULT_VALIDATE_OPTIONS },
        { anthropic: client, corpus, tradesRoot: path.dirname(dir), log: (l) => console.log(`[build-trade] ${l}`) }
      );
      console.log(`[build-trade] validation used ${r.totalCalls} gate calls (~$${r.spendUsd.toFixed(3)})`);
    } catch (err) {
      // The profile itself was written; only the optional validation step failed.
      console.error('[build-trade] the profile was built, but validating its keyphrases failed (list left as generated):', err);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('[build-trade] failed, existing profile (if any) left untouched:', err);
  process.exit(1);
});
