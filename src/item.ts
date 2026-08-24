import { z } from 'zod';

const EventType = z.enum(['item', 'item_amended']);
const BodyState = z.enum(['absent', 'fetching', 'present', 'paywalled', 'failed']);
const AmendmentKind = z.enum(['headline_changed', 'removed']);
const ProvenanceGap = z.enum([
  'synthetic_headline',
  'no_article_url',
  'title_not_headline',
]);

export const ItemSchema = z.object({
  item_id: z.string(),
  dedup_id: z.string(),
  story_key: z.string().nullable(),
  event_type: EventType,
  replay: z.boolean(),
  source_id: z.string(),
  adapter: z.string(),
  trust_tier: z.number().int().min(1).max(5),
  headline: z.string(),
  snippet: z.string().nullable(),
  url: z.string().nullable(),
  raw_url: z.string().nullable(),
  enrich_url: z.string().nullable(),
  author: z.string().nullable(),
  lang: z.string().nullable(),
  body_state: BodyState,
  body: z.string().nullable(),
  event_time: z.string().nullable(),
  source_publish_ts: z.string().nullable(),
  first_seen_ts: z.string(),
  emitted_ts: z.string(),
  latency_ms: z.number().int().nullable(),
  is_first_sighting: z.boolean(),
  corroborations: z.number().int(),
  provenance_gaps: z.array(ProvenanceGap),
  amends_item_id: z.string().nullable(),
  amendment_kind: AmendmentKind.nullable(),
});

export type Item = z.infer<typeof ItemSchema>;

export interface ParsedItem {
  ok: true;
  item: Item;
}

export interface ParseFailure {
  ok: false;
  error: string;
  raw: string;
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
    return { ok: false, error: `invalid JSON: ${(err as Error).message}`, raw };
  }

  const result = ItemSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message, raw };
  }

  return { ok: true, item: result.data };
}
