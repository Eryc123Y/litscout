import { sql, type SQL } from "drizzle-orm";
import { vaultTitleKey } from "@litscout/core/normalize";
import {
  titleKeyBatchSize,
  titleKeyCountCap,
} from "@litscout/pipeline/vault-contracts";
import { atomic, first, rows, type Database } from "./database";

const paperTitlesPending = sql`
  EXISTS(SELECT 1 FROM papers WHERE deleted_at IS NULL AND vault_title_norm IS NULL)
  OR EXISTS(SELECT 1 FROM paper_index WHERE title_norm IS NULL)`;
const unkeyedNotes = sql`kind='paper_note' AND deleted_at IS NULL AND title_norm IS NULL
  AND json_extract(frontmatter,'$.arxiv') IS NULL
  AND json_extract(frontmatter,'$.doi') IS NULL`;
export const titleKeysPendingCount = sql`
  (SELECT count(*) FROM (SELECT 1 FROM papers WHERE deleted_at IS NULL AND vault_title_norm IS NULL LIMIT ${titleKeyCountCap}))
  + (SELECT count(*) FROM (SELECT 1 FROM paper_index WHERE title_norm IS NULL LIMIT ${titleKeyCountCap}))
  + (SELECT count(*) FROM (SELECT 1 FROM vault_notes INDEXED BY vault_notes_unkeyed_title WHERE ${unkeyedNotes} LIMIT ${titleKeyCountCap}))`;
export const titleKeysPending = sql`${paperTitlesPending}
  OR EXISTS(SELECT 1 FROM vault_notes INDEXED BY vault_notes_unkeyed_title WHERE ${unkeyedNotes})`;
const sources = {
  paper: ["papers", "id", "vault_title_norm"],
  compact: ["paper_index", "paper_id", "title_norm"],
  note: ["vault_notes", "id", "title_norm"],
} as const;

export async function backfillVaultTitleKeys(db: Database) {
  const pending = await rows<{
    source: keyof typeof sources;
    id: string;
    title: string;
  }>(
    db,
    sql`
    SELECT 'paper' AS source,id,title FROM papers WHERE deleted_at IS NULL AND vault_title_norm IS NULL
    UNION ALL SELECT 'compact',paper_id,title FROM paper_index WHERE title_norm IS NULL
    UNION ALL SELECT 'note',id,title FROM vault_notes INDEXED BY vault_notes_unkeyed_title WHERE ${unkeyedNotes}
    LIMIT ${titleKeyBatchSize}`,
  );
  // Compare the source title and unset key again in the transaction in case
  // ingestion or index publication won the race with this read.
  const [firstWrite, ...rest] = pending.map(({ source, id, title }) => {
    const [table, idColumn, keyColumn] = sources[source];
    const key = sql.identifier(keyColumn);
    return sql`UPDATE ${sql.identifier(table)} SET ${key}=${vaultTitleKey(title)}
      WHERE ${sql.identifier(idColumn)}=${id} AND title=${title} AND ${key} IS NULL`;
  });
  const rowsWritten = firstWrite ? await atomic(db, [firstWrite, ...rest]) : 0;
  const state = await first<{ pending: number }>(
    db,
    sql`SELECT (${titleKeysPending}) AS pending`,
  );
  return { titleKeysPending: Boolean(state?.pending), rowsWritten };
}

export function uniqueVaultTitle(key: SQL) {
  // A canonical row (including a soft-deleted one) supersedes its compact copy.
  // Only two eligible candidates are needed to decide uniqueness.
  return sql`(
    SELECT CASE WHEN count(*)=1 THEN min(paper_id) END FROM (
      SELECT id AS paper_id FROM papers
        WHERE deleted_at IS NULL AND vault_title_norm=${key}
      UNION ALL
      SELECT paper_id FROM paper_index WHERE title_norm=${key} AND has_canonical=0
      LIMIT 2
    )
  )`;
}

export const updateVaultTitleMatches = (guard: SQL) => sql`
  WITH matches AS MATERIALIZED (
    SELECT n.id,${uniqueVaultTitle(sql`n.title_norm`)} AS paper_id
    FROM vault_notes n
    WHERE ${guard} AND NOT (${paperTitlesPending})
      AND n.kind='paper_note' AND n.deleted_at IS NULL AND n.title_norm>''
  )
  UPDATE vault_notes AS n SET title_paper_id=m.paper_id FROM matches m
    WHERE n.id=m.id AND n.title_paper_id IS NOT m.paper_id`;

export const paperTitleKeysReady = sql`NOT (${paperTitlesPending})`;
