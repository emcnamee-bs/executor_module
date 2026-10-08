// Final review C1: in systemd, EnvironmentFile= overrides Environment=, so a pin set
// with Environment= can be undone by .env or .env.<name>. The pins now live on the
// ExecStart command line (`/usr/bin/env [-u VAR] K=V ... tsx main.ts`), which nothing
// in an env file can override. These tests read the REAL unit files, compute the
// environment the process would actually get from a hostile env file, and drive the
// real startup path (prepareStartup) with it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareStartup } from '../src/startup.js';
import { writeProfile } from './profile/fixtures.js';

const DEPLOY = path.resolve(__dirname, '../deploy/mini-mac');
const read = (f: string) => fs.readFileSync(path.join(DEPLOY, f), 'utf-8');

interface Unit {
  environment: Record<string, string>;
  execStart: string;
}

function parseUnit(text: string, instance?: string): Unit {
  const sub = (s: string) => (instance === undefined ? s : s.replace(/%i/g, instance));
  const environment: Record<string, string> = {};
  let execStart = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const env = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (env) environment[env[1]] = sub(env[2]);
    if (line.startsWith('ExecStart=')) execStart = sub(line.slice('ExecStart='.length));
  }
  return { environment, execStart };
}

/** What the process sees: Environment=, then env files (which override it), then the /usr/bin/env prefix. */
function effectiveEnv(unit: Unit, envFiles: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = { ...unit.environment, ...envFiles };
  const argv = unit.execStart.split(/\s+/);
  if (argv[0] !== '/usr/bin/env') return env;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-u') {
      delete env[argv[++i]];
      continue;
    }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[i]);
    if (!kv) break; // the command itself
    env[kv[1]] = kv[2];
  }
  return env;
}

const HOSTILE_ENV_FILE = {
  KALSHI_DRY_RUN: 'false',
  EXECUTOR_TRADE: 'kxtrumpapprove',
  EXECUTOR_LIVE_TRADE: 'kxtrumpapprove',
};

describe('paper template executor-module@.service', () => {
  const unit = (i: string) => parseUnit(read('executor-module@.service'), i);

  it('pins KALSHI_DRY_RUN=true and EXECUTOR_TRADE=%i on the ExecStart line and strips EXECUTOR_LIVE_TRADE', () => {
    const { execStart, environment } = unit('kxtrumpapprove');
    expect(execStart).toMatch(/^\/usr\/bin\/env -u EXECUTOR_LIVE_TRADE KALSHI_DRY_RUN=true EXECUTOR_TRADE=kxtrumpapprove /);
    expect(execStart).toMatch(/node_modules\/\.bin\/tsx \S+\/src\/main\.ts$/);
    // Not ALSO set with Environment= (which an env file would silently beat).
    expect(environment.KALSHI_DRY_RUN).toBeUndefined();
    expect(environment.EXECUTOR_TRADE).toBeUndefined();
    expect(environment.EXECUTOR_LIVE_TRADE).toBeUndefined();
  });

  it('a hostile .env/.env.<name> cannot make a paper unit live or retarget it', () => {
    const env = effectiveEnv(unit('kxtrumpapprove'), { ...HOSTILE_ENV_FILE, EXECUTOR_TRADE: 'kxaprpotus' });
    expect(env.KALSHI_DRY_RUN).toBe('true');
    expect(env.EXECUTOR_TRADE).toBe('kxtrumpapprove');
    expect(env.EXECUTOR_LIVE_TRADE).toBeUndefined();
  });
});

describe('live unit executor-module.service', () => {
  const unit = () => parseUnit(read('executor-module.service'));

  it('pins EXECUTOR_TRADE and EXECUTOR_LIVE_TRADE to kxaprpotus on the ExecStart line, and never pins KALSHI_DRY_RUN', () => {
    const { execStart, environment } = unit();
    expect(execStart).toMatch(/^\/usr\/bin\/env EXECUTOR_TRADE=kxaprpotus EXECUTOR_LIVE_TRADE=kxaprpotus /);
    expect(execStart).not.toMatch(/KALSHI_DRY_RUN/);
    expect(environment.EXECUTOR_TRADE).toBeUndefined();
  });

  it('REQUIRES its own .env.kxaprpotus after the shared .env (no "-": a missing file fails the start)', () => {
    const text = read('executor-module.service');
    const files = [...text.matchAll(/^EnvironmentFile=(.*)$/gm)].map((m) => m[1]);
    expect(files).toEqual(['%h/executor_module/.env', '%h/executor_module/.env.kxaprpotus']);
  });

  it('a hostile env file cannot retarget the live unit to another trade', () => {
    const env = effectiveEnv(unit(), HOSTILE_ENV_FILE);
    expect(env.EXECUTOR_TRADE).toBe('kxaprpotus');
    expect(env.EXECUTOR_LIVE_TRADE).toBe('kxaprpotus');
  });

  it('describes the gate -> triage -> decide pipeline, not the deleted synopsis/verify steps', () => {
    const text = read('executor-module.service');
    expect(text).not.toMatch(/synopsis|verify/i);
    expect(text).toMatch(/gate/);
  });
});

describe('score-paper.service (M3)', () => {
  it('scores the live ledger data/decisions.db as well as every data/*/decisions.db', () => {
    const exec = parseUnit(read('score-paper.service')).execStart;
    expect(exec).toMatch(/for d in data\/decisions\.db data\/\*\/decisions\.db;/);
  });
});

describe('the real startup path with the units\' effective env', () => {
  let repo: string;
  let trades: string;
  const tags = (async () =>
    new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b-instruct-q4_K_M' }] }), { status: 200 })) as unknown as typeof fetch;
  const releases: Array<() => void> = [];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
    trades = path.join(repo, 'trades');
    // A BAND paper profile whose ledger already exists: the exact C1 scenario.
    writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
    fs.mkdirSync(path.join(repo, 'data/kxtrumpapprove'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'data/kxtrumpapprove/decisions.db'), '');
  });
  afterEach(() => {
    while (releases.length) releases.pop()!();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('a band paper unit with KALSHI_DRY_RUN=false in its env file still starts dry-run', async () => {
    const env = effectiveEnv(parseUnit(read('executor-module@.service'), 'kxtrumpapprove'), HOSTILE_ENV_FILE);
    const s = await prepareStartup(env, repo, { tradesRoot: trades, fetchImpl: tags, log: () => {} });
    releases.push(() => s.lock.release());
    expect(s.dryRun).toBe(true);
  });

  it('even if the dry-run pin were lost, the paper unit could not start live: it has no EXECUTOR_LIVE_TRADE', async () => {
    const env = effectiveEnv(parseUnit(read('executor-module@.service'), 'kxtrumpapprove'), HOSTILE_ENV_FILE);
    delete env.KALSHI_DRY_RUN;
    await expect(prepareStartup(env, repo, { tradesRoot: trades, fetchImpl: tags, log: () => {} })).rejects.toThrow(
      /live start refused.*EXECUTOR_LIVE_TRADE/
    );
  });

  it('a paper unit instantiated for kxaprpotus is refused (live ledger and group belong to the live unit)', async () => {
    const env = effectiveEnv(parseUnit(read('executor-module@.service'), 'kxaprpotus'), {});
    await expect(prepareStartup(env, repo, { fetchImpl: tags, log: () => {} })).rejects.toThrow(/live ledger.*live unit/);
  });
});

// EXECUTOR_PAPER_LOW_TIER: enabled per paper unit by a systemd drop-in, never by editing
// a unit's ExecStart. Whatever route the variable takes into the LIVE unit's environment
// (the shared .env, .env.kxaprpotus, or a drop-in copied to the wrong unit), the live
// unit must refuse to start rather than relax.
describe('EXECUTOR_PAPER_LOW_TIER deployment', () => {
  const DROPIN = 'executor-module@.service.d/low-tier.conf.example';
  const dropIn = () => parseUnit(read(DROPIN));
  const withDropIn = (unit: Unit): Unit => ({ ...unit, environment: { ...unit.environment, ...dropIn().environment } });
  const tags = (async () =>
    new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b-instruct-q4_K_M' }] }), { status: 200 })) as unknown as typeof fetch;
  let repo: string;
  let trades: string;
  const releases: Array<() => void> = [];

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-lowtier-'));
    trades = path.join(repo, 'trades');
    writeProfile(trades, 'kxtrumpapprove', { profile: { marketStructure: 'band' } });
    writeProfile(trades, 'kxaprpotus', { profile: { marketStructure: 'band', ledgerPath: 'data/decisions.db', consumerGroup: 'execmod' } });
    fs.mkdirSync(path.join(repo, 'data/kxtrumpapprove'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'data/kxtrumpapprove/decisions.db'), '');
    fs.writeFileSync(path.join(repo, 'data/decisions.db'), '');
  });
  afterEach(() => {
    while (releases.length) releases.pop()!();
    fs.rmSync(repo, { recursive: true, force: true });
  });
  const startWith = async (vars: NodeJS.ProcessEnv) => {
    const s = await prepareStartup(vars, repo, { tradesRoot: trades, fetchImpl: tags, log: () => {} });
    releases.push(() => s.lock.release());
    return s;
  };

  it('the example drop-in is exactly a [Service] section setting EXECUTOR_PAPER_LOW_TIER=true', () => {
    const lines = read(DROPIN).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual(['[Service]', 'Environment=EXECUTOR_PAPER_LOW_TIER=true']);
  });

  it('neither unit file sets or mentions EXECUTOR_PAPER_LOW_TIER (it is never baked into a unit)', () => {
    expect(read('executor-module.service')).not.toMatch(/EXECUTOR_PAPER_LOW_TIER/);
    expect(read('executor-module@.service')).not.toMatch(/EXECUTOR_PAPER_LOW_TIER/);
  });

  it('a paper unit with the drop-in starts dry-run with paperLowTier=true', async () => {
    const vars = effectiveEnv(withDropIn(parseUnit(read('executor-module@.service'), 'kxtrumpapprove')), {});
    const s = await startWith(vars);
    expect(s.dryRun).toBe(true);
    expect(s.paperLowTier).toBe(true);
  });

  it('a paper unit without the drop-in starts with paperLowTier=false', async () => {
    const s = await startWith(effectiveEnv(parseUnit(read('executor-module@.service'), 'kxtrumpapprove'), {}));
    expect(s.paperLowTier).toBe(false);
  });

  it.each([
    ['dry-run soak', { KALSHI_DRY_RUN: 'true' }],
    ['halted', { EXECUTOR_TRADING_HALTED: 'true' }],
    ['live', {}],
  ])('the LIVE unit refuses to start (%s) when a hostile shared .env carries EXECUTOR_PAPER_LOW_TIER=true', async (_l, own) => {
    const live = parseUnit(read('executor-module.service'));
    await expect(startWith(effectiveEnv(live, { ...own, EXECUTOR_PAPER_LOW_TIER: 'true' }))).rejects.toThrow(/EXECUTOR_PAPER_LOW_TIER/);
    // Control: the same live environment without the variable starts.
    await expect(startWith(effectiveEnv(live, { ...own }))).resolves.toBeTruthy();
  });

  it('the LIVE unit refuses to start if the paper drop-in is copied onto it by mistake', async () => {
    const live = withDropIn(parseUnit(read('executor-module.service')));
    await expect(startWith(effectiveEnv(live, { KALSHI_DRY_RUN: 'true' }))).rejects.toThrow(/EXECUTOR_PAPER_LOW_TIER/);
  });
});
