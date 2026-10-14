// A hostile env file must not be able to turn a shipped unit into a demo/live one (review focus 4).
// The pins live on the ExecStart line (/usr/bin/env [-u VAR] K=V ... cmd), which nothing in an env file overrides.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMode } from '../../src/perp/startup.js';

const DEPLOY = path.resolve(__dirname, '../../deploy/mini-mac');
const read = (f: string) => fs.readFileSync(path.join(DEPLOY, f), 'utf-8');
const T = 'KXUS500PERP';

interface Unit { environment: Record<string, string>; execStart: string; text: string }
function parseUnit(text: string): Unit {
  const environment: Record<string, string> = {};
  let execStart = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const env = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (env) environment[env[1]] = env[2];
    if (line.startsWith('ExecStart=')) execStart = line.slice('ExecStart='.length);
  }
  return { environment, execStart, text };
}
function effectiveEnv(unit: Unit, envFiles: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = { ...unit.environment, ...envFiles };
  const argv = unit.execStart.split(/\s+/);
  if (argv[0] !== '/usr/bin/env') return env;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-u') { delete env[argv[++i]]; continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[i]);
    if (!kv) break;
    env[kv[1]] = kv[2];
  }
  return env;
}

const HOSTILE = {
  PERP_MODE: 'live', PERP_LIVE: `${T}:3`, PERP_SUBACCOUNT: '3',
  KALSHI_DEMO_API_KEY_ID: 'x', KALSHI_DEMO_PRIVATE_KEY_PATH: '/y',
};

describe('perp-bot.service (paper)', () => {
  const unit = parseUnit(read('perp-bot.service'));
  it('pins PERP_MODE=paper and strips PERP_LIVE on the ExecStart line, and runs src/perp/main.ts', () => {
    expect(unit.execStart).toMatch(/^\/usr\/bin\/env -u PERP_LIVE PERP_MODE=paper /);
    expect(unit.execStart).toContain('src/perp/main.ts');
  });
  it('a hostile env file still yields a paper start', () => {
    const env = effectiveEnv(unit, HOSTILE);
    expect(env.PERP_LIVE).toBeUndefined();
    expect(resolveMode(env, T).mode).toBe('paper');
  });
  it('reads the shared .env, then an optional (-) .env.perp', () => {
    expect(unit.text).toMatch(/^EnvironmentFile=%h\/executor_module\/\.env$/m);
    expect(unit.text).toMatch(/^EnvironmentFile=-%h\/executor_module\/\.env\.perp$/m);
  });
});

describe('perp-bot-demo.service', () => {
  const unit = parseUnit(read('perp-bot-demo.service'));
  it('pins PERP_MODE=demo and strips PERP_LIVE', () => {
    expect(unit.execStart).toMatch(/^\/usr\/bin\/env -u PERP_LIVE PERP_MODE=demo /);
  });
  it('a hostile env file can never make it live', () => {
    const env = effectiveEnv(unit, HOSTILE);
    expect(env.PERP_LIVE).toBeUndefined();
    expect(resolveMode(env, T).mode).toBe('demo');
  });
  it('requires its own .env.perp-demo (no "-": a missing file fails the start)', () => {
    expect(unit.text).toMatch(/^EnvironmentFile=%h\/executor_module\/\.env\.perp-demo$/m);
  });
});

describe('no shipped unit can trade real money', () => {
  it('none of the perp-*.service files pins live mode or sets PERP_LIVE', () => {
    for (const f of fs.readdirSync(DEPLOY).filter((x) => /^perp-.*\.service$/.test(x))) {
      const text = read(f);
      expect(text, f).not.toMatch(/PERP_MODE=live/);
      expect(text, f).not.toMatch(/^Environment=PERP_LIVE=/m);
    }
  });
});
