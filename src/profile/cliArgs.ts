export interface BuildCliArgs {
  seriesTicker: string;
  directSources: string[];
  reuseKeyphrasesFile?: string;
  ledgerPath?: string;
  consumerGroup?: string;
  gateModel?: string;
  allowLiveLedger: boolean;
}

const VALUE_FLAGS: Record<string, 'seriesTicker' | 'direct' | 'reuseKeyphrasesFile' | 'ledgerPath' | 'consumerGroup' | 'gateModel'> = {
  '--series': 'seriesTicker',
  '--direct': 'direct',
  '--reuse-keyphrases': 'reuseKeyphrasesFile',
  '--ledger-path': 'ledgerPath',
  '--consumer-group': 'consumerGroup',
  '--gate-model': 'gateModel',
};

/**
 * Strict parsing for `npm run build-trade`: every value flag needs a value that does not
 * start with "--", unknown flags and stray positionals are errors, duplicates are errors,
 * and `--allow-live-ledger` is a boolean flag. A mistyped command must fail before it can
 * spend any Sonnet calls.
 */
export function parseBuildArgs(argv: string[]): BuildCliArgs {
  const values: Partial<Record<string, string>> = {};
  let allowLiveLedger = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--allow-live-ledger') {
      if (allowLiveLedger) throw new Error('duplicate flag --allow-live-ledger');
      allowLiveLedger = true;
      continue;
    }
    const key = VALUE_FLAGS[flag];
    if (!key) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    if (key in values) throw new Error(`duplicate flag ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--') || value.trim() === '') {
      throw new Error(`${flag} requires a value`);
    }
    values[key] = value;
    i++;
  }
  if (!values.seriesTicker) throw new Error('--series <SERIES_TICKER> is required');
  return {
    seriesTicker: values.seriesTicker,
    directSources: (values.direct ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    reuseKeyphrasesFile: values.reuseKeyphrasesFile,
    ledgerPath: values.ledgerPath,
    consumerGroup: values.consumerGroup,
    gateModel: values.gateModel,
    allowLiveLedger,
  };
}
