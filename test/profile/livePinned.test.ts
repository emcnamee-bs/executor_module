// The live trade's profile is HAND-PINNED and committed (final review I1): its decide
// prompt, magnitude ceiling, ledger and consumer group are the reviewed values the old
// pipeline traded on, not something a build-trade run regenerated. This test loads the
// committed directory through the real loader and pins every one of those values.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, TRADES_ROOT } from '../../src/profile/profile.js';
import { loadKeyphrases } from '../../src/keyphrases/list.js';
import { buildDecideSystem } from '../../src/decide/decide.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The first paragraph of DECIDE_CONTEXT in main:src/decide/decide.ts, verbatim.
const OLD_DECIDE_CONTEXT =
  "You are assessing a news item for its likely effect on the U.S. President's approval rating, as measured by RealClearPolitics's polling average (a Kalshi market resolves weekly on a snapshot of this average).";

describe('committed live profile trades/kxaprpotus (hand-pinned)', () => {
  it('loads through the real loader from the committed trades/ directory', () => {
    const loaded = loadProfile('kxaprpotus');
    expect(loaded.dir).toBe(path.join(TRADES_ROOT, 'kxaprpotus'));
  });

  it('pins the reviewed decide context, magnitude ceiling, unit, structure, ledger and group', () => {
    const { profile } = loadProfile('kxaprpotus');
    expect(profile.name).toBe('kxaprpotus');
    expect(profile.seriesTicker).toBe('KXAPRPOTUS');
    expect(profile.decideContext).toBe(OLD_DECIDE_CONTEXT);
    expect(profile.maxMagnitude).toBe(10);
    expect(profile.magnitudeUnit).toBe('pts');
    expect(profile.marketStructure).toBe('band');
    expect(profile.ledgerPath).toBe('data/decisions.db');
    expect(profile.consumerGroup).toBe('execmod');
    expect(profile.directSources).toEqual([]);
    expect(profile.gateModel).toBe('qwen2.5:7b-instruct-q4_K_M');
    expect(profile.gateKeepAlive).toBe('10m');
    expect(profile.generatorModel).toMatch(/hand-pinned/);
  });

  it('carries the old pipeline keyphrase list unchanged (data/keyphrases.json)', () => {
    const loaded = loadProfile('kxaprpotus');
    expect(loaded.keyphrases).toEqual(loadKeyphrases(path.join(REPO_ROOT, 'data/keyphrases.json')));
  });

  it('the real decide system prompt starts with the old context and bounds magnitude at 10 pts', () => {
    const system = buildDecideSystem(loadProfile('kxaprpotus'));
    expect(system.startsWith(OLD_DECIDE_CONTEXT)).toBe(true);
    expect(system).toContain('NON-NEGATIVE number in pts');
    expect(system).toContain('AT MOST 10.');
  });
});
