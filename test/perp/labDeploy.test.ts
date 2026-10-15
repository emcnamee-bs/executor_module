// test/perp/labDeploy.test.ts
// The lab unit must be paper-pinned on its ExecStart line (an env file cannot undo it) and sandboxed like the bot.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertPaperOnly } from '../../src/perp/lab/startup.js';

const text = fs.readFileSync(path.resolve(__dirname, '../../deploy/mini-mac/intake-lab.service'), 'utf-8');
const execStart = text.split('\n').find((l) => l.trim().startsWith('ExecStart='))!.trim().slice('ExecStart='.length);

function effectiveEnv(envFiles: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...envFiles };
  const argv = execStart.split(/\s+/);
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-u') { delete env[argv[++i]]; continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[i]);
    if (!kv) break;
    env[kv[1]] = kv[2];
  }
  return env as NodeJS.ProcessEnv;
}

describe('intake-lab.service', () => {
  it('pins PERP_MODE=paper and strips PERP_LIVE and NODE_OPTIONS on the ExecStart line, and runs the lab main', () => {
    expect(execStart).toMatch(/^\/usr\/bin\/env -u PERP_LIVE -u NODE_OPTIONS PERP_MODE=paper /);
    expect(execStart).toContain('src/perp/lab/main.ts');
  });
  it('a hostile env file still yields a paper-only start', () => {
    const env = effectiveEnv({ PERP_MODE: 'live', PERP_LIVE: 'KXUS500PERP:3', NODE_OPTIONS: '--require /tmp/evil.js' });
    expect(() => assertPaperOnly(env)).not.toThrow();
    expect(env.PERP_LIVE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });
  it('is sandboxed like the bot: read-only home, writes only under the perp data dir, no new privileges', () => {
    expect(text).toMatch(/^ProtectHome=read-only$/m);
    expect(text).toMatch(/^ProtectSystem=strict$/m);
    expect(text).toMatch(/^NoNewPrivileges=yes$/m);
    expect(text).toMatch(/^ReadWritePaths=%h\/executor_module-perp\/data$/m);
  });
  it('starts after the bot and uses the shared secrets file, with the optional lab tunables file', () => {
    expect(text).toMatch(/^After=.*perp-bot\.service/m);
    expect(text).toMatch(/^EnvironmentFile=%h\/executor_module\/\.env$/m);
    expect(text).toMatch(/^EnvironmentFile=-%h\/executor_module\/\.env\.perp$/m);
  });
});
