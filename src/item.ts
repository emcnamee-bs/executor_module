import { z } from 'zod';

const EventType = z.enum(['item', 'item_amended']);
const BodyState = z.enum(['absent', 'fetching', 'present', 'paywalled', 'failed']);
const AmendmentKind = z.enum(['headline_changed', 'removed']);
const ProvenanceGap = z.enum([
  'synthetic_headline',
  'no_article_url',
  'title_not_headline',
]);

/**
 * Mirrors `Internet_Info_Plug/iip/schema.py`'s `Item` pydantic model field-for-field,
 * INCLUDING which fields carry defaults.
 *
 * This distinction is load-bearing, not cosmetic. Upstream gives most fields a default
 * precisely so payloads written before a field existed keep validating as the schema
 * grows ("every one of the 103 archived payloads written before this phase still
 * validates" — schema.py). A consumer that marks those fields *required* rejects real
 * history: over the 17,328 entries currently in the live `iip:items` stream, requiring
 * them fails 189 (1.1%) — all genuine older items.
 *
 * Only these eight are required, matching the pydantic fields declared with no default:
 *   item_id, dedup_id, source_id, adapter, trust_tier, headline, first_seen_ts, emitted_ts
 * Every other field's `.default(...)` below is the exact pydantic default.
 */
export const ItemSchema = z.object({
  // identity
  item_id: z.string(),
  dedup_id: z.string(),
  story_key: z.string().nullable().default(null),

  // event kind
  event_type: EventType.default('item'),
  replay: z.boolean().default(false),

  // provenance
  source_id: z.string(),
  adapter: z.string(),
  trust_tier: z.number().int().min(1).max(5),

  // content
  headline: z.string(),
  snippet: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  raw_url: z.string().nullable().default(null),
  enrich_url: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  lang: z.string().nullable().default(null),

  // body
  body_state: BodyState.default('absent'),
  body: z.string().nullable().default(null),

  // timing
  event_time: z.string().nullable().default(null),
  source_publish_ts: z.string().nullable().default(null),
  first_seen_ts: z.string(),
  emitted_ts: z.string(),
  latency_ms: z.number().int().nullable().default(null),

  // redundant-path accounting
  is_first_sighting: z.boolean().default(false),
  corroborations: z.number().int().default(0),

  // declared deficiencies
  provenance_gaps: z.array(ProvenanceGap).default([]),

  // amendment reference
  amends_item_id: z.string().nullable().default(null),
  amendment_kind: AmendmentKind.nullable().default(null),
});

export type Item = z.infer<typeof ItemSchema>;

export interface ParsedItem {
  ok: true;
  item: Item;
}

export interface ParseFailure {
  ok: false;
  /**
   * A COMPACT, single-line description of why parsing failed — never `ZodError.message`,
   * which is a pretty-printed multi-line JSON dump of every issue. The parse-error branch
   * is exactly the log line you need when the upstream schema drifts, so it has to survive
   * a `grep`/one-line-per-item pipeline intact.
   */
  error: string;
  raw: string;
}

/** Collapses a ZodError into one line: `path: message; path: message`. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseItemFields(
  fields: Record<string, string>
): ParsedItem | ParseFailure {
  const raw = fields.json;
  if (raw === undefined) {
    return { ok: false, error: 'missing json field on stream entry', raw: JSON.stringify(fields) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = (err as Error).message.replace(/\s+/g, ' ').trim();
    return { ok: false, error: `invalid JSON: ${detail}`, raw };
  }

  const result = ItemSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: formatZodError(result.error), raw };
  }

  return { ok: true, item: result.data };
}
