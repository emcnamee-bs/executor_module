import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const GOOD_BANK = `TRADE: Weekly AAA national average price of regular gasoline
SETTLES ON: AAA national average for regular unleaded gasoline on the settlement morning
MOVES THE PRICE:
- Crude oil: WTI and Brent moves, OPEC+ decisions, EIA inventory reports
- US refining: outages, fires, strikes, maintenance, unplanned shutdowns
- Fuel logistics: pipelines, rail, ports, waterways, trucking and tanker availability
- Weather and disasters: Gulf Coast storms, floods, freezes, drought
- Geopolitics: sanctions, conflict or shipping disruption in oil regions
SETTLEMENT-SENSITIVE FACTS: AAA publishes one national figure daily, it reflects pump prices not wholesale, it moves slowly
IGNORE: gas leaks, rocket fuel, electric vehicle recalls, sports, entertainment
`;

export function profileJson(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    seriesTicker: 'KXAAAGASW',
    title: 'Will the national average price of regular gasoline be above $4.34?',
    settlement: 'Resolves YES if the AAA national average for regular gasoline is strictly above the strike on the settlement date.',
    gateModel: 'qwen2.5:7b-instruct-q4_K_M',
    gateKeepAlive: '10m',
    decideContext:
      'You are assessing a news item for its likely effect on the AAA national average price of regular gasoline, which a Kalshi market resolves on weekly.',
    directSources: [],
    marketStructure: 'threshold',
    magnitudeUnit: 'USD/gal',
    maxMagnitude: 0.5,
    ledgerPath: `data/${name}/decisions.db`,
    consumerGroup: `execmod-${name}`,
    generatedAt: '2026-10-08T00:00:00Z',
    generatorModel: 'claude-sonnet-5',
    ...over,
  };
}

export function writeProfile(
  root: string,
  name: string,
  over: { profile?: Record<string, unknown>; bank?: string; keyphrases?: string[]; metaSha?: string } = {}
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const bank = over.bank ?? GOOD_BANK;
  const phrases = over.keyphrases ?? Array.from({ length: 25 }, (_, i) => `gas price phrase ${i}`);
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profileJson(name, over.profile), null, 2));
  fs.writeFileSync(path.join(dir, 'keyphrases.json'), JSON.stringify(phrases, null, 2));
  fs.writeFileSync(path.join(dir, 'bank.md'), bank);
  fs.writeFileSync(
    path.join(dir, 'bank.meta.json'),
    JSON.stringify({ sha256: over.metaSha ?? crypto.createHash('sha256').update(bank).digest('hex'), generatedAt: '2026-10-08T00:00:00Z' })
  );
  return dir;
}
