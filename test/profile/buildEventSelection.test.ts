import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { fetchSeriesSpec, buildTradeProfile } from '../../src/profile/build.js';
import { GOOD_BANK } from './fixtures.js';

const NOW = () => new Date('2026-10-11T22:00:00Z');

type Mk = { ticker: string; close_time: string; strike_type: string | null; yes_sub_title: string; rules_primary?: string };
const mk = (event: string, i: number, close: string, strike: string | null = 'custom', sub = `Outcome ${i}`): Mk =>
  ({ ticker: `${event}-${i}`, close_time: close, strike_type: strike, yes_sub_title: sub, rules_primary: `Rules for ${sub}.` });

/** events: [{ticker, title, markets}]; the markets endpoint answers per requested event_ticker. */
function fakeApi(events: Array<{ ticker: string; title: string; markets: Mk[]; strike_date?: string }>, urls: string[] = []): typeof fetch {
  return (async (url: string) => {
    urls.push(String(url));
    if (String(url).includes('/events?')) {
      return new Response(JSON.stringify({ events: events.map((e) => ({ event_ticker: e.ticker, title: e.title, strike_date: e.strike_date, markets: e.markets })) }), { status: 200 });
    }
    const wanted = new URL(String(url)).searchParams.get('event_ticker');
    return new Response(JSON.stringify({ markets: events.find((e) => e.ticker === wanted)?.markets ?? [] }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('fetchSeriesSpec: which event the profile is built for', () => {
  it('skips an event whose markets have all closed and takes the soonest UPCOMING one (not the first in API order)', async () => {
    const urls: string[] = [];
    const f = fakeApi([
      { ticker: 'KXEOWEEK-26OCT10', title: 'EOs Oct 4-10', markets: [mk('KXEOWEEK-26OCT10', 1, '2026-10-10T03:59:00Z', 'greater')] },
      { ticker: 'KXEOWEEK-26OCT24', title: 'EOs Oct 18-24', markets: [mk('KXEOWEEK-26OCT24', 1, '2026-10-24T03:59:00Z', 'greater')] },
      { ticker: 'KXEOWEEK-26OCT17', title: 'EOs Oct 11-17', markets: [mk('KXEOWEEK-26OCT17', 1, '2026-10-17T03:59:00Z', 'greater')] },
    ], urls);
    const spec = await fetchSeriesSpec('KXEOWEEK', f, NOW);
    expect(spec.eventTicker).toBe('KXEOWEEK-26OCT17');
    expect(spec.title).toBe('EOs Oct 11-17');
    expect(urls[0]).toContain('with_nested_markets=true');
    expect(urls[1]).toContain('event_ticker=KXEOWEEK-26OCT17');
  });

  it('within an event, only markets still to close count (a half-closed event is judged by its next close)', async () => {
    const f = fakeApi([
      { ticker: 'A', title: 'A', markets: [mk('A', 1, '2026-10-01T00:00:00Z', 'greater'), mk('A', 2, '2026-12-01T00:00:00Z', 'greater')] },
      { ticker: 'B', title: 'B', markets: [mk('B', 1, '2026-11-01T00:00:00Z', 'greater')] },
    ]);
    expect((await fetchSeriesSpec('S', f, NOW)).eventTicker).toBe('B');
  });

  it('keeps the old strike_date ordering when events carry no market close times', async () => {
    const f = (async (url: string) => {
      if (String(url).includes('/events?')) return new Response(JSON.stringify({ events: [{ event_ticker: 'E2', strike_date: '2026-10-20T00:00:00Z', title: 'T2' }, { event_ticker: 'E1', strike_date: '2026-10-12T00:00:00Z', title: 'T1' }] }), { status: 200 });
      return new Response(JSON.stringify({ markets: [{ ticker: 'm', strike_type: 'greater', rules_primary: 'r' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await fetchSeriesSpec('S', f, NOW)).eventTicker).toBe('E1');
  });

  it('when every event has already closed it still builds (from the old ordering) instead of failing', async () => {
    const f = fakeApi([
      { ticker: 'P1', title: 'P1', markets: [mk('P1', 1, '2026-10-01T00:00:00Z', 'greater')] },
      { ticker: 'P2', title: 'P2', markets: [mk('P2', 1, '2026-10-05T00:00:00Z', 'greater')] },
    ]);
    const spec = await fetchSeriesSpec('S', f, NOW);
    expect(['P1', 'P2']).toContain(spec.eventTicker);
  });
});

describe('fetchSeriesSpec: multi-outcome events are framed as one question', () => {
  const outcomes = (n: number, strike: string | null) => Array.from({ length: n }, (_, i) => mk('E', i, '2026-12-31T00:00:00Z', strike, `Person ${i}`));

  it('a custom-strike event with 3+ markets gets a note to write for the whole question, never one outcome', async () => {
    const spec = await fetchSeriesSpec('KXTRUMPPARDON', fakeApi([{ ticker: 'E', title: 'Who will Trump pardon in 2026?', markets: outcomes(34, 'custom') }]), NOW);
    expect(spec.outcomeNote).toMatch(/34 markets are separate outcomes of ONE question/);
    expect(spec.outcomeNote).toContain('Who will Trump pardon in 2026?');
    expect(spec.outcomeNote).toMatch(/never for a single outcome/);
  });

  it.each([
    ['a price ladder (greater strikes)', 'greater', 20],
    ['only two custom markets', 'custom', 2],
  ])('no note for %s', async (_label, strike, n) => {
    const spec = await fetchSeriesSpec('S', fakeApi([{ ticker: 'E', title: 'T', markets: outcomes(n as number, strike as string) }]), NOW);
    expect(spec.outcomeNote).toBeUndefined();
  });
});

describe('buildTradeProfile sends the event and the framing note to Sonnet', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-evt-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('puts eventTicker and outcomeNote in the bank prompt', async () => {
    const calls: any[] = [];
    const out = { title: 'Who will Trump pardon in 2026?', settlement: 'Resolves YES for an outcome if the named person receives a presidential pardon before the end of 2026.', decideContext: 'You are estimating how a news item changes the odds that Trump pardons the named people during 2026.', magnitudeUnit: 'pts', maxMagnitude: 20, bank: GOOD_BANK };
    const client = {
      messages: {
        parse: async (p: any) => {
          calls.push(p);
          const isBank = JSON.stringify(p.output_config.format.schema).includes('magnitudeUnit');
          const parsed = isBank ? out : { keyphrases: Array.from({ length: 200 }, (_, i) => `pardon phrase ${i}`) };
          return { stop_reason: 'end_turn', parsed_output: parsed, content: [{ type: 'text', text: JSON.stringify(parsed) }], usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as unknown as Anthropic;
    const outcomes = Array.from({ length: 5 }, (_, i) => mk('E', i, '2026-12-31T00:00:00Z', 'custom', `Person ${i}`));
    await buildTradeProfile(
      { seriesTicker: 'KXPARDONTEST', directSources: [], tradesRoot: path.join(root, 'trades'), repoRoot: root },
      { client, fetchImpl: fakeApi([{ ticker: 'E', title: 'Who will Trump pardon in 2026?', markets: outcomes }]), now: NOW }
    );
    const bankPrompt = calls[0].messages[0].content as string;
    expect(bankPrompt).toContain('"eventTicker": "E"');
    expect(bankPrompt).toContain('separate outcomes of ONE question');
  });
});

describe('fetchSeriesSpec: recurring series are framed in general, not for one period', () => {
  const week = (t: string, title: string) => ({ ticker: t, title, markets: [mk(t, 1, '2026-10-31T00:00:00Z', 'greater')] });

  it('two or more open events get a note to describe the recurring question and not hard-code one period', async () => {
    const spec = await fetchSeriesSpec('KXEOWEEK', fakeApi([week('A', 'EOs this week (10/4 - 10/10)'), week('B', 'EOs this week (10/11 - 10/17)')]), NOW);
    expect(spec.recurringNote).toMatch(/2 open events/);
    expect(spec.recurringNote).toContain('EOs this week (10/4 - 10/10)');
    expect(spec.recurringNote).toContain('EOs this week (10/11 - 10/17)');
    expect(spec.recurringNote).toMatch(/not hard-code the dates/);
  });

  it('a single open event gets no recurring note', async () => {
    const spec = await fetchSeriesSpec('S', fakeApi([week('A', 'Only one')]), NOW);
    expect(spec.recurringNote).toBeUndefined();
  });

  it('lists at most four event titles, however many are open', async () => {
    const many = Array.from({ length: 9 }, (_, i) => week(`E${i}`, `Title ${i}`));
    const note = (await fetchSeriesSpec('S', fakeApi(many), NOW)).recurringNote ?? '';
    expect(note).toMatch(/9 open events/);
    expect((note.match(/Title \d/g) ?? []).length).toBe(4);
  });
});
