// CI check (round-2 item 9): two profiles sharing a consumer group would split one
// stream between two trades, and two sharing a ledger would mix their exposure,
// breakers and dedup. Neither is detectable by one process at startup, so every
// committed trades/*/profile.json is checked here, together.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProfileCollisions, TRADES_ROOT } from '../../src/profile/profile.js';
import { writeProfile } from './fixtures.js';

describe('committed trades/*/profile.json are pairwise distinct', () => {
  it('no two committed profiles share a consumerGroup or a ledgerPath', () => {
    expect(fs.readdirSync(TRADES_ROOT).filter((d) => !d.startsWith('.')).length).toBeGreaterThan(0);
    expect(findProfileCollisions(TRADES_ROOT)).toEqual([]);
  });
});

describe('findProfileCollisions', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'collide-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts distinct profiles', () => {
    writeProfile(root, 'kxa');
    writeProfile(root, 'kxb');
    expect(findProfileCollisions(root)).toEqual([]);
  });

  it('reports a shared consumerGroup', () => {
    writeProfile(root, 'kxa', { profile: { consumerGroup: 'execmod' } });
    writeProfile(root, 'kxb', { profile: { consumerGroup: 'execmod' } });
    expect(findProfileCollisions(root)).toEqual(['consumerGroup "execmod" is used by kxa, kxb']);
  });

  it('reports a shared ledgerPath, case-insensitively', () => {
    writeProfile(root, 'kxa', { profile: { ledgerPath: 'data/decisions.db' } });
    writeProfile(root, 'kxb', { profile: { ledgerPath: 'data/Decisions.db' } });
    expect(findProfileCollisions(root)).toEqual(['ledgerPath "data/decisions.db" is used by kxa, kxb']);
  });

  it('ignores dot directories (build staging and .old copies)', () => {
    writeProfile(root, 'kxa');
    writeProfile(root, '.old-kxa-deadbeef', { profile: { name: 'kxa' } });
    expect(findProfileCollisions(root)).toEqual([]);
  });

  it('reports an unreadable profile.json rather than skipping it', () => {
    fs.mkdirSync(path.join(root, 'kxa'));
    fs.writeFileSync(path.join(root, 'kxa', 'profile.json'), '{');
    expect(findProfileCollisions(root)[0]).toMatch(/kxa: profile\.json unreadable/);
  });
});
