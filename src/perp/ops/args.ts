// src/perp/ops/args.ts

export type ParsedArgs =
  | { ok: true; values: Record<string, string>; flags: Set<string> }
  | { ok: false; error: string };

/**
 * Strict parser for the operator scripts. Every argument must be a known `--flag`; a value flag needs a value that
 * does not itself start with `--` (so `--db --force` is an error, not a database called "--force"); positionals,
 * unknown flags and repeated flags are errors.
 */
export function parseArgs(argv: string[], spec: { values: string[]; booleans?: string[] }): ParsedArgs {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const booleans = spec.booleans ?? [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { ok: false, error: `unexpected argument ${JSON.stringify(a)}` };
    const name = a.slice(2);
    if (name in values || flags.has(name)) return { ok: false, error: `--${name} given more than once` };
    if (spec.values.includes(name)) {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('--')) return { ok: false, error: `--${name} needs a value` };
      values[name] = v;
      i += 1;
    } else if (booleans.includes(name)) {
      flags.add(name);
    } else {
      return { ok: false, error: `unknown option --${name}` };
    }
  }
  return { ok: true, values, flags };
}
