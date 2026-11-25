import {
  digestRecordSchema,
  radarSchema,
} from "@litscout/pipeline/contracts/index";
import { z } from "zod";
import type {
  DigestReference,
  DigestRow,
} from "@litscout/pipeline/web-contracts";
import type { IngestDatabase } from "./ingest-store";
import { readDigest } from "./feed-read";

const storedDigest = digestRecordSchema.strip().extend({
  createdAt: z.iso.datetime(),
  radar: z
    .array(radarSchema.strip().omit({ day: true }))
    .max(10000)
    .default([]),
});

/** The original digest route remains unchanged for CLI and MCP consumers. */
export async function readWebDigest(
  db: IngestDatabase,
  day: string,
  lang: string,
  kind: string,
) {
  // A legacy day carries the old pipeline's Chinese digest, so an English
  // instance would otherwise show "Digest pending" on a final day.
  const stored =
    (await readDigest(db, day, lang, kind)) ??
    (await readDigest(db, day, lang === "zh" ? "en" : "zh", kind));
  if (!stored) return null;
  const draft = storedDigest.parse(stored);
  const ids = [
    ...new Set([...draft.picks, ...draft.radar.map((item) => item.paperId)]),
  ];
  const rows = ids.length
    ? await db
        .prepare(
          // The title and the occurrence's topics ride along (same rows, no
          // extra reads), so the reader can name the brief's papers at once.
          "SELECT p.id,p.source,p.title,(SELECT json_object('source',f.source,'day',f.day,'topics',json(coalesce(f.topics,'[]'))) FROM feed_items f WHERE f.paper_id=p.id AND f.day<=? ORDER BY f.day DESC,f.source LIMIT 1) AS occurrence FROM json_each(?) wanted JOIN papers p ON p.id=wanted.value WHERE p.deleted_at IS NULL",
        )
        .bind(day, JSON.stringify(ids))
        .all<{
          id: string;
          source: string;
          title: string | null;
          occurrence: string | null;
        }>()
    : { results: [] };
  const refs = new Map(
    rows.results.map((row) => {
      const occurrence = row.occurrence
        ? (JSON.parse(row.occurrence) as {
            source: string;
            day: string;
            topics: string[];
          })
        : { source: row.source, day: null, topics: [] };
      return [
        row.id,
        {
          paperId: row.id,
          ...occurrence,
          ...(row.title ? { title: row.title } : {}),
        },
      ] as const;
    }),
  );
  const reference = (paperId: string): DigestReference =>
    refs.get(paperId) ?? { paperId, source: null, day: null };
  return {
    ...draft,
    picks: draft.picks.map(reference),
    radar: draft.radar.map((item) => ({ ...item, ...reference(item.paperId) })),
  };
}

/** At most fifty exact day/source identities, one SQL statement, metadata only. */
export async function readDigestRows(
  db: IngestDatabase,
  refs: { paperId: string; source: string; day: string | null }[],
): Promise<DigestRow[]> {
  const result = await db
    .prepare(
      "WITH wanted AS (SELECT json_extract(value,'$.paperId') AS id,json_extract(value,'$.source') AS source,json_extract(value,'$.day') AS day FROM json_each(?)) SELECT DISTINCT p.id AS paperId,p.title,w.source,w.day,coalesce(f.topics,'[]') AS topics FROM wanted w JOIN papers p ON p.id=w.id LEFT JOIN feed_items f ON f.paper_id=w.id AND f.source=w.source AND f.day=w.day WHERE p.deleted_at IS NULL AND (f.paper_id IS NOT NULL OR (w.day IS NULL AND p.source=w.source))",
    )
    .bind(JSON.stringify(refs))
    .all<{
      paperId: string;
      title: string;
      source: string;
      day: string | null;
      topics: string;
    }>();
  return result.results.map((row) => ({
    ...row,
    topics: JSON.parse(row.topics) as string[],
  }));
}
