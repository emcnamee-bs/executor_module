// src/perp/ops/network.ts
import dns from 'node:dns';
import net from 'node:net';

/** How long Node waits for one connection attempt before trying the next address (its default is 250 ms). */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Connection setup for a host with a slow or broken IPv6 route. On mini-mac (2026-10-15) the API's IPv6 address was unreachable and IPv4 connects
 * took 1-5 s, so Node's 250 ms attempt window made every request fail with ETIMEDOUT ("Connection error."). Resolve IPv4 first and give each
 * attempt 5 s. Process-wide: call once at startup, before any client is created.
 */
export function preferIpv4(): void {
  dns.setDefaultResultOrder('ipv4first');
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
}
