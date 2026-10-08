// prepareStartup is main()'s startup wiring, extracted so every guard and pin on the
// path from env + profile to the consumer is driven by a test (final review I4).
// Each test isolates ONE guard: the env and profile satisfy every other guard, so
// deleting that guard's call in prepareStartup turns exactly that test red.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendAlert, setAlertTrade } from '../src/alert.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareStartup, resolvePaperLowTier, type Startup } from '../src/startup.js';
import { findMatches } from '../src/keyphrases/match.js';
import { writeProfile } from './profile/fixtures.js';

const GATE = 'qwen2.5:7b-instruct-q4_K_M';

function tagsFetch(models: string[] = [GATE]): typeof fetch {
  return (async (url: string) => {
    if (!String(url).endsWith('/api/tags')) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('prepareStartup (main() startup wiring)', () => {
  let repo: string;
  let trades: string;
  const started: Startup[] = [];
  let logs: string[];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-'));
    trades = path.join(repo, 'trades');
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    logs = [];
  });
  afterEach(() => {
    while (started.length) started.pop()!.lock.release();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  async function start(env: Record<string, string | undefined>, fetchImpl: typeof fetch = tagsFetch()): Promise<Startup> {
    const s = await prepareStartup(env as NodeJS.ProcessEnv, repo, { tradesRoot: trades, fetchImpl, log: (l) => logs.push(l) });
    started.push(s);
    return s;
  }
  const touchLedger = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), '');
  };

  describe('paper start (happy path) and the pins it returns', () => {
    it('pins the profile ledger, the profile consumer group, stream tail start, compiled phrases and a held lock', async () => {
      writeProfile(trades, 'kxaaagasw', { keyphrases: Array.from({ length: 25 }, (_, i) => `gas price phrase ${i}`) });
      const s = await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' });
      expect(s.loaded.profile.name).toBe('kxaaagasw');
      expect(s.ledgerPath).toBe(path.join(repo, 'data/kxaaagasw/decisions.db'));
      expect(s.consumerOptions).toEqual({
        streamKey: 'iip:items',
        groupName: 'execmod-kxaaagasw',
        consumerName: 'execmod-kxaaagasw-primary',
        startId: '$',
      });
      expect(s.compiledPhrases).toHaveLength(25);
      expect(findMatches('news: gas price phrase 7 today', s.compiledPhrases)).toEqual(['gas price phrase 7']);
      expect(fs.existsSync(`${s.ledgerPath}.lock`)).toBe(true);
      expect(s.dryRun).toBe(true);
      expect(s.halted).toBe(false);
    });

    it('names the trade on every later Slack alert from this process (M4)', async () => {
      writeProfile(trades, 'kxaaagasw');
      await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await sendAlert('[CIRCUIT-BREAKER-TRIPPED] x'); // SLACK_WEBHOOK_URL is unset in tests: logged no-op
      expect(warn.mock.calls.flat().join(' ')).toContain('[trade=kxaaagasw] [CIRCUIT-BREAKER-TRIPPED] x');
      setAlertTrade(null);
    });

    it('honours EXECMOD_CONSUMER_NAME for the consumer name only, never the group', async () => {
      writeProfile(trades, 'kxaaagasw');
      const s = await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', EXECMOD_CONSUMER_NAME: 'custom-1' });
      expect(s.consumerOptions.consumerName).toBe('custom-1');
      expect(s.consumerOptions.groupName).toBe('execmod-kxaaagasw');
    });

    it('requires EXECUTOR_TRADE', async () => {
      await expect(start({ KALSHI_DRY_RUN: 'true' })).rejects.toThrow(/EXECUTOR_TRADE must be set/);
    });
  });

  describe('[profile] startup line (I3)', () => {
    it('logs trade, ledger, group, dryRun= and halted= from the env actually in force', async () => {
      writeProfile(trades, 'kxaaagasw');
      await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', EXECUTOR_TRADING_HALTED: 'true' });
      const line = logs.find((l) => l.startsWith('[profile] '))!;
      expect(line).toContain('trade=kxaaagasw');
      expect(line).toContain('group=execmod-kxaaagasw');
      expect(line).toContain(`ledger=${path.join(repo, 'data/kxaaagasw/decisions.db')}`);
      expect(line).toMatch(/ dryRun=true( |$)/);
      expect(line).toMatch(/ halted=true( |$)/);
    });

    it('a live start with no halt logs an unmissable LIVE AND NOT HALTED warning; dry-run or halted starts do not', async () => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
      touchLedger('data/kxtrumpapprove/decisions.db');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const warned = () => warn.mock.calls.flat().join('\n');
      const live = { EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove' };

      started.push(await prepareStartup({ ...live, EXECUTOR_TRADING_HALTED: 'true' } as NodeJS.ProcessEnv, repo, { tradesRoot: trades, fetchImpl: tagsFetch(), log: () => {} }));
      started.pop()!.lock.release();
      started.push(await prepareStartup({ ...live, KALSHI_DRY_RUN: 'true' } as NodeJS.ProcessEnv, repo, { tradesRoot: trades, fetchImpl: tagsFetch(), log: () => {} }));
      started.pop()!.lock.release();
      expect(warned()).not.toMatch(/LIVE AND NOT HALTED/);

      await start(live);
      expect(warned()).toMatch(/WARN.*LIVE AND NOT HALTED.*trade=kxtrumpapprove/);
    });

    it('halted=false and dryRun=false on a live start with no kill switch', async () => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
      touchLedger('data/kxtrumpapprove/decisions.db');
      const s = await start({ EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove' });
      expect(s.dryRun).toBe(false);
      const line = logs.find((l) => l.startsWith('[profile] '))!;
      expect(line).toMatch(/ dryRun=false( |$)/);
      expect(line).toMatch(/ halted=false( |$)/);
    });
  });

  describe('structure gate (assertLiveAllowed)', () => {
    it('a non-band profile refuses a live start even when every other live guard is satisfied', async () => {
      writeProfile(trades, 'kxaaagasw'); // threshold
      touchLedger('data/kxaaagasw/decisions.db');
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', EXECUTOR_LIVE_TRADE: 'kxaaagasw' })).rejects.toThrow(/paper-only/);
    });
  });

  describe('live start requires EXECUTOR_LIVE_TRADE === profile.name (C1)', () => {
    beforeEach(() => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
      touchLedger('data/kxtrumpapprove/decisions.db');
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['a different trade', 'kxaprpotus'],
      ['a case variant', 'KXTRUMPAPPROVE'],
    ])('refuses a live (non-dry-run) start when EXECUTOR_LIVE_TRADE is %s', async (_l, v) => {
      await expect(start({ EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: v })).rejects.toThrow(
        /live start refused.*EXECUTOR_LIVE_TRADE.*kxtrumpapprove/
      );
    });

    it.each(['false', '', 'TRUE', '1'])('KALSHI_DRY_RUN=%j is a live start and is refused without the live pin', async (v) => {
      await expect(start({ EXECUTOR_TRADE: 'kxtrumpapprove', KALSHI_DRY_RUN: v })).rejects.toThrow(/EXECUTOR_LIVE_TRADE/);
    });

    it('allows the live start when EXECUTOR_LIVE_TRADE names this profile', async () => {
      await expect(start({ EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove' })).resolves.toBeTruthy();
    });

    it('a dry-run start needs no live pin', async () => {
      await expect(start({ EXECUTOR_TRADE: 'kxtrumpapprove', KALSHI_DRY_RUN: 'true' })).resolves.toBeTruthy();
    });
  });

  describe("the live ledger and group belong to the live unit only (I2)", () => {
    it.each([
      ['ledger data/decisions.db', { ledgerPath: 'data/decisions.db' }],
      ['ledger data/Decisions.db', { ledgerPath: 'data/Decisions.db' }],
      ['group execmod', { consumerGroup: 'execmod' }],
    ])('a DRY-RUN start of a profile on the live %s is refused unless EXECUTOR_LIVE_TRADE names it', async (_l, pinned) => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band', ...pinned } });
      await expect(start({ EXECUTOR_TRADE: 'kxtrumpapprove', KALSHI_DRY_RUN: 'true' })).rejects.toThrow(
        /live ledger.*live unit/
      );
      await expect(
        start({ EXECUTOR_TRADE: 'kxtrumpapprove', KALSHI_DRY_RUN: 'true', EXECUTOR_LIVE_TRADE: 'other' })
      ).rejects.toThrow(/live ledger.*live unit/);
      await expect(
        start({ EXECUTOR_TRADE: 'kxtrumpapprove', KALSHI_DRY_RUN: 'true', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove' })
      ).resolves.toBeTruthy();
    });

    it('the committed kxaprpotus profile cannot be started by a paper unit (no EXECUTOR_LIVE_TRADE)', async () => {
      await expect(
        prepareStartup({ EXECUTOR_TRADE: 'kxaprpotus', KALSHI_DRY_RUN: 'true' } as NodeJS.ProcessEnv, repo, {
          fetchImpl: tagsFetch(), log: () => {},
        })
      ).rejects.toThrow(/live ledger.*live unit/);
    });
  });

  describe('fresh-ledger guard (assertLedgerStartAllowed)', () => {
    it('a live start on a ledger file that does not exist is refused', async () => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
      await expect(start({ EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove' })).rejects.toThrow(
        /ledger .* does not exist/
      );
    });

    it('creating the lock file and the ledger directory does not count as the ledger existing', async () => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
      await start({ EXECUTOR_TRADE: 'kxtrumpapprove', KALSHI_DRY_RUN: 'true' });
      started.pop()!.lock.release();
      await expect(start({ EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove' })).rejects.toThrow(
        /does not exist/
      );
    });
  });

  describe('direct sources are validated against IIP_SOURCES_FILE', () => {
    beforeEach(() => writeProfile(trades, 'kxaaagasw', { profile: { directSources: ['aaa_national_average'] } }));

    it('requires IIP_SOURCES_FILE when the profile has direct sources', async () => {
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' })).rejects.toThrow(/IIP_SOURCES_FILE must be set/);
    });

    it('refuses an id the iip sources file does not configure', async () => {
      const f = path.join(repo, 'sources.yaml');
      fs.writeFileSync(f, 'sources:\n  - id: bbc_world\n');
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', IIP_SOURCES_FILE: f })).rejects.toThrow(
        /not configured iip sources: aaa_national_average/
      );
    });

    it('starts when every direct source is configured', async () => {
      const f = path.join(repo, 'sources.yaml');
      fs.writeFileSync(f, 'sources:\n  - id: aaa_national_average\n');
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', IIP_SOURCES_FILE: f })).resolves.toBeTruthy();
    });
  });

  describe('gate model must be pulled in Ollama (I6)', () => {
    beforeEach(() => writeProfile(trades, 'kxaaagasw'));

    it('refuses to start, naming the ollama pull command, when /api/tags lacks the gate model', async () => {
      await expect(
        start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' }, tagsFetch(['qwen2.5:3b-instruct-q4_K_M']))
      ).rejects.toThrow(/gate model qwen2\.5:7b-instruct-q4_K_M is not available.*ollama pull qwen2\.5:7b-instruct-q4_K_M/);
    });

    it('fails closed when Ollama cannot be asked', async () => {
      const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' }, down)).rejects.toThrow(/could not list Ollama models.*ECONNREFUSED/);
    });

    it('fails closed on a non-2xx /api/tags', async () => {
      const bad = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' }, bad)).rejects.toThrow(/could not list Ollama models.*500/);
    });

    it('asks the configured OLLAMA_BASE_URL', async () => {
      const seen: string[] = [];
      const f = (async (url: string) => { seen.push(String(url)); return tagsFetch()(url as any); }) as unknown as typeof fetch;
      await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', OLLAMA_BASE_URL: 'http://10.0.0.9:11434' }, f);
      expect(seen).toEqual(['http://10.0.0.9:11434/api/tags']);
    });

    it('a model listed with an implicit :latest tag matches an untagged gateModel', async () => {
      writeProfile(trades, 'kxbare', { profile: { gateModel: 'mygate' } });
      await expect(start({ EXECUTOR_TRADE: 'kxbare', KALSHI_DRY_RUN: 'true' }, tagsFetch(['mygate:latest']))).resolves.toBeTruthy();
    });
  });

  describe('single instance per ledger (I2)', () => {
    it('a second start on the same ledger is refused while the first holds it, and allowed after release', async () => {
      writeProfile(trades, 'kxaaagasw');
      const first = await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' });
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' })).rejects.toThrow(/another executor instance/);
      first.lock.release();
      started.splice(started.indexOf(first), 1);
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' })).resolves.toBeTruthy();
    });

    it('a refused start (any guard) leaves no lock behind', async () => {
      writeProfile(trades, 'kxaaagasw');
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true' }, tagsFetch([]))).rejects.toThrow();
      expect(fs.existsSync(path.join(repo, 'data/kxaaagasw/decisions.db.lock'))).toBe(false);
    });
  });

  describe('EXECUTOR_PAPER_LOW_TIER (paper-only low-tier relaxation)', () => {
    const lowTierLine = () => logs.find((l) => l.startsWith('[profile] '))!;

    it('unset or empty: starts with paperLowTier=false and logs lowTier=false', async () => {
      for (const v of [undefined, '']) {
        writeProfile(trades, 'kxaaagasw');
        logs = [];
        const s = await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', EXECUTOR_PAPER_LOW_TIER: v });
        expect(s.paperLowTier).toBe(false);
        expect(lowTierLine()).toMatch(/ lowTier=false( |$)/);
        started.pop()!.lock.release();
      }
    });

    it('exactly "true" on a dry-run paper start: paperLowTier=true and logs lowTier=true', async () => {
      writeProfile(trades, 'kxaaagasw');
      const s = await start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', EXECUTOR_PAPER_LOW_TIER: 'true' });
      expect(s.paperLowTier).toBe(true);
      expect(lowTierLine()).toMatch(/ lowTier=true( |$)/);
    });

    it.each(['false', '1', 'TRUE', 'yes', ' true', 'true '])('any other value (%j) refuses to start (fail closed)', async (v) => {
      writeProfile(trades, 'kxaaagasw');
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', EXECUTOR_PAPER_LOW_TIER: v })).rejects.toThrow(
        /EXECUTOR_PAPER_LOW_TIER/
      );
    });

    it('a live (non-dry-run) start with the switch on is refused, even when every live guard is satisfied', async () => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
      touchLedger('data/kxtrumpapprove/decisions.db');
      const live = { EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove', EXECUTOR_TRADING_HALTED: 'true' };
      await expect(start({ ...live, EXECUTOR_PAPER_LOW_TIER: 'true' })).rejects.toThrow(/EXECUTOR_PAPER_LOW_TIER.*paper/);
      // The same settings without the switch start: the switch alone is what refused.
      await expect(start(live)).resolves.toBeTruthy();
    });

    it('the live profile (EXECUTOR_LIVE_TRADE set) is refused even while dry-run', async () => {
      writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
      const vars = { EXECUTOR_TRADE: 'kxtrumpapprove', EXECUTOR_LIVE_TRADE: 'kxtrumpapprove', KALSHI_DRY_RUN: 'true' };
      await expect(start({ ...vars, EXECUTOR_PAPER_LOW_TIER: 'true' })).rejects.toThrow(/EXECUTOR_PAPER_LOW_TIER.*live/);
      await expect(start(vars)).resolves.toBeTruthy();
    });

    it('a refused low-tier start leaves no lock behind', async () => {
      writeProfile(trades, 'kxaaagasw');
      await expect(start({ EXECUTOR_TRADE: 'kxaaagasw', KALSHI_DRY_RUN: 'true', EXECUTOR_PAPER_LOW_TIER: 'TRUE' })).rejects.toThrow();
      expect(fs.existsSync(path.join(repo, 'data/kxaaagasw/decisions.db.lock'))).toBe(false);
    });
  });

  describe('resolvePaperLowTier (each condition isolated)', () => {
    const paper = { name: 'kxaaagasw', ledgerPath: 'data/kxaaagasw/decisions.db', consumerGroup: 'execmod-kxaaagasw' };
    const vars = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;
    it('requires KALSHI_DRY_RUN exactly "true"', () => {
      for (const d of [undefined, '', 'false', 'TRUE', '1']) {
        expect(() => resolvePaperLowTier(paper, vars({ EXECUTOR_PAPER_LOW_TIER: 'true', KALSHI_DRY_RUN: d }))).toThrow(/KALSHI_DRY_RUN/);
      }
      expect(resolvePaperLowTier(paper, vars({ EXECUTOR_PAPER_LOW_TIER: 'true', KALSHI_DRY_RUN: 'true' }))).toBe(true);
    });
    it('refuses whenever EXECUTOR_LIVE_TRADE is present at all (even empty)', () => {
      for (const l of ['kxaaagasw', 'other', '']) {
        expect(() =>
          resolvePaperLowTier(paper, vars({ EXECUTOR_PAPER_LOW_TIER: 'true', KALSHI_DRY_RUN: 'true', EXECUTOR_LIVE_TRADE: l }))
        ).toThrow(/EXECUTOR_LIVE_TRADE/);
      }
    });
    it.each([
      ['ledger', { ledgerPath: 'data/decisions.db' }],
      ['group', { consumerGroup: 'execmod' }],
    ])('refuses a profile on the live %s', (_l, over) => {
      expect(() => resolvePaperLowTier({ ...paper, ...over }, vars({ EXECUTOR_PAPER_LOW_TIER: 'true', KALSHI_DRY_RUN: 'true' }))).toThrow(
        /live (ledger|consumer group)/
      );
    });
    it('off (unset or empty) never refuses and returns false, whatever else is set', () => {
      for (const v of [undefined, '']) {
        expect(resolvePaperLowTier({ ...paper, ledgerPath: 'data/decisions.db' }, vars({ EXECUTOR_PAPER_LOW_TIER: v, EXECUTOR_LIVE_TRADE: 'x' }))).toBe(false);
      }
    });
  });
});

describe('main() uses prepareStartup', () => {
  it('main.ts consumes the pinned consumer options and phrases from prepareStartup, not its own copies', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(src).toMatch(/await prepareStartup\(process\.env, REPO_ROOT\)/);
    expect(src).toMatch(/runOnce\(\s*client,\s*startup\.consumerOptions,\s*startup\.compiledPhrases,/);
    expect(src).not.toMatch(/loadProfile\(/);
    expect(src).not.toMatch(/startId:/);
  });

  it('main.ts hands the startup-resolved low-tier switch to the pipeline deps (never re-reads the variable itself)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf-8');
    expect(src).toMatch(/paperLowTier: startup\.paperLowTier/);
    expect(src).not.toMatch(/EXECUTOR_PAPER_LOW_TIER/);
  });
});
