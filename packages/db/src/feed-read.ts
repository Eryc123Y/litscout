import { decodeRow } from "./database";
import { type IngestDatabase } from "./ingest-store";
export { readDayPage as readFeedDay, readPaper } from "./bounded-read";
export async function readDigest(
  db: IngestDatabase,
  day: string,
  lang: string,
  kind: string,
) {
  const row = await db
    .prepare("SELECT * FROM digests WHERE day=? AND lang=? AND kind=?")
    .bind(day, lang, kind)
    .first<Record<string, unknown>>();
  return row ? decodeRow(row) : null;
}
export async function readOperations(
  db: IngestDatabase,
  from: string,
  to: string,
) {
  const results = await db.batch([
    db
      .prepare("SELECT * FROM runs WHERE day>=? AND day<=? ORDER BY started_at")
      .bind(from, to),
    db
      .prepare(
        "SELECT id,paper_id,day,kind,CASE WHEN source LIKE 'mcp:%' THEN source || ' (unverified)' ELSE source END AS source,at FROM events WHERE user_id='u_owner' AND day>=? AND day<=? AND kind IN ('rate_up','rate_down','rate_clear') ORDER BY at",
      )
      .bind(from, to),
    db
      .prepare(
        "SELECT * FROM radar_grades WHERE day>=? AND day<=? ORDER BY day,paper_id",
      )
      .bind(from, to),
    db
      .prepare(
        "SELECT id,paper_id,found_on,\"where\",coalesce(note,'') AS note FROM missed WHERE found_on>=? AND found_on<=? AND deleted_at IS NULL ORDER BY found_on",
      )
      .bind(from, to),
  ]);
  return Object.fromEntries(
    ["runs", "ratings", "radar", "missed"].map((key, i) => [
      key,
      results[i]!.results.map((r) => decodeRow(r as Record<string, unknown>)),
    ]),
  );
}
