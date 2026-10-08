import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLedger } from '../../src/decide/ledger.js';
import { runGate } from '../../src/decide/gate.js';
import { createOllamaClient } from '../../src/decide/ollamaClient.js';
import { loadProfile } from '../../src/profile/profile.js';
import { writeProfile } from '../profile/fixtures.js';

const STORIES = [
  { id: 's01', relevant: false, text: 'Title: Gas leak forces evacuation of Columbus apartment complex\nSite description: Utility crews shut off service to the building as a precaution; no injuries reported.\nExcerpt: About 120 residents were evacuated Tuesday evening after a natural gas odor was reported on the second floor of a Columbus apartment complex. Firefighters ventilated the building and utility crews repaired a corroded service line.' },
  { id: 's02', relevant: false, text: 'Title: Aerospace firm delays lunar lander engine test after fuel tank valve fault\nSite description: The company said the static-fire test was pushed back by at least three weeks.\nExcerpt: A private aerospace company said Tuesday it is postponing the next static-fire test of its lunar lander engine after engineers found a faulty valve in a liquid fuel tank during pre-test checks.' },
  { id: 's03', relevant: false, text: 'Title: Typhoon makes landfall in northern Philippines, thousands evacuated\nSite description: Authorities warned of flash floods and landslides across Luzon.\nExcerpt: A powerful typhoon struck the northern Philippines early Wednesday with winds of 150 km/h, forcing more than 20,000 people into evacuation centers.' },
  { id: 's04', relevant: false, text: 'Title: Automaker recalls 38,000 electric crossovers over charging software fault\nSite description: Owners will receive a free over-the-air update beginning next month.\nExcerpt: An automaker is recalling about 38,000 electric crossovers sold in North America because a software fault can interrupt charging and, in rare cases, disable the dashboard display.' },
  { id: 's05', relevant: false, text: 'Title: Streaming service raises monthly price by $2 as subscriber growth slows\nSite description: The ad-free tier will cost $17.99 starting in December.\nExcerpt: A major streaming service announced it will raise the price of its ad-free plan by $2 a month beginning in December, citing rising content costs.' },
  { id: 's06', relevant: false, text: 'Title: Champions snatch late winner to beat rivals 3-1 in derby\nSite description: A stoppage-time header sealed the result in front of a sell-out crowd.\nExcerpt: The reigning champions scored twice in the final ten minutes to beat their city rivals 3-1 on Sunday, extending their unbeaten run to nine matches.' },
  { id: 's07', relevant: false, text: 'Title: FDA approves first once-weekly insulin for type 2 diabetes\nSite description: The injection is intended to replace daily basal insulin for many patients.\nExcerpt: U.S. regulators approved the first once-weekly insulin injection for adults with type 2 diabetes on Tuesday, a decision doctors say could simplify treatment for millions of patients.' },
  { id: 's08', relevant: false, text: 'Title: City council approves 14 miles of protected bike lanes downtown\nSite description: Construction will begin in spring and take about two years.\nExcerpt: The city council voted 7-2 on Monday to approve a plan adding 14 miles of protected bike lanes across the downtown core, converting some on-street parking to dedicated lanes.' },
  { id: 's09', relevant: false, text: 'Title: Airline pilots ratify five-year contract, ending strike threat\nSite description: The deal includes a 24% raise over the life of the agreement.\nExcerpt: Pilots at a large U.S. airline voted overwhelmingly on Friday to ratify a five-year contract that includes a cumulative 24% pay increase and improved scheduling rules.' },
  { id: 's10', relevant: true, text: 'Title: Low water on lower Mississippi prompts Coast Guard to limit barge tows near Memphis\nSite description: Drought-lowered river levels are forcing tow restrictions and partial loads as shipping season peaks.\nExcerpt: The Coast Guard on Tuesday restricted tow sizes and imposed daylight-only transit between Memphis and Vicksburg as the river fell to its lowest autumn level in four years. Operators said groundings are likely to delay grain, chemical and petroleum-product barges headed north to Midwest terminals, and several carriers warned of surcharges through at least mid-November.' },
];

describe.skipIf(process.env.RUN_LIVE_GATE !== '1')('live gate smoke test (real Ollama, real model)', () => {
  it('flags the adjacent-but-impactful story and raises at most one false alarm in nine', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-live-'));
    const db = openLedger(path.join(dir, 'l.db'));
    writeProfile(dir, 'kxaaagasw');
    const loaded = loadProfile('kxaaagasw', dir);
    const ollama = createOllamaClient(process.env.OLLAMA_BASE_URL, db);
    try {
    const verdicts: Record<string, boolean> = {};
    for (const s of STORIES) {
      const r = await runGate({ ollama, db, profile: loaded }, { itemId: s.id, excerptText: s.text, excerptSource: 'page' });
      verdicts[s.id] = r.relevant;
    }
    const falseAlarms = STORIES.filter((s) => !s.relevant && verdicts[s.id]).length;
    expect(verdicts.s10).toBe(true);
    expect(falseAlarms).toBeLessThanOrEqual(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30 * 60 * 1000);
});
