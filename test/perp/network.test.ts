import dns from 'node:dns';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { CONNECT_ATTEMPT_TIMEOUT_MS, preferIpv4 } from '../../src/perp/ops/network.js';

describe('preferIpv4', () => {
  it('resolves IPv4 first and gives each connection attempt 5 s', () => {
    preferIpv4();
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
    expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBe(5_000);
  });
});
