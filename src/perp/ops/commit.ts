// src/perp/ops/commit.ts
import { execFileSync } from 'node:child_process';

/** Short git sha of the checkout at `repoRoot`, or 'unknown' when it is not a repo or git is unavailable. Recorded on journal and lab rows. */
export function currentCommit(repoRoot: string): string {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
