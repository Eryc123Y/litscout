import type { IngestDatabase } from "./ingest-store";
import type { WriteLease } from "./write-budget";

/** Compact rows expire, with their feed occurrences, once the paper was last
 * listed before a horizon (12 months by default; earlier when the server is
 * over its storage cap), oldest first (ADR 0004, decision 6). Full records
 * are never touched: `prunePage` makes them compact after `storage.fullDays`. */

// Library, mirror, reading, missed and radar rows need a full record (their
// foreign keys), so a compact row is kept only by references without one:
// published lists (digest picks, suggestions, ideas, working papers), idea
// links, notes, captures, queued vault requests and paper notes in the
// vault. While a paper note has no title key yet, nothing expires, as in
// `retentionPage`.
const kept = `EXISTS(SELECT 1 FROM retention_refs WHERE paper_id=c.paper_id)
  OR EXISTS(SELECT 1 FROM idea_links WHERE target_type='paper' AND target_id=c.paper_id)
  OR EXISTS(SELECT 1 FROM notes WHERE target_type='paper' AND target_id=c.paper_id)
  OR EXISTS(SELECT 1 FROM captures WHERE source_paper_id=c.paper_id)
  OR EXISTS(SELECT 1 FROM vault_requests INDEXED BY vault_requests_retention_paper
    WHERE json_extract(payload,'$.paperId')=+c.paper_id)
  OR EXISTS(SELECT 1 FROM vault_notes WHERE title_paper_id=c.paper_id AND deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM vault_notes WHERE kind='paper_note' AND deleted_at IS NULL
    AND title_norm>'' AND title_norm=c.title_norm)
  OR EXISTS(SELECT 1 FROM vault_notes INDEXED BY vault_notes_unkeyed_title
    WHERE kind='paper_note' AND deleted_at IS NULL AND title_norm IS NULL
    AND json_extract(frontmatter,'$.arxiv') IS NULL AND json_extract(frontmatter,'$.doi') IS NULL)
  OR (c.arxiv_id IS NOT NULL AND EXISTS(SELECT 1 FROM vault_notes n INDEXED BY vault_notes_arxiv
    WHERE n.kind='paper_note' AND n.deleted_at IS NULL
    AND lower(json_extract(n.frontmatter,'$.arxiv'))=lower(c.arxiv_id)))
  OR (c.doi IS NOT NULL AND EXISTS(SELECT 1 FROM vault_notes n INDEXED BY vault_notes_doi
    WHERE n.kind='paper_note' AND n.deleted_at IS NULL
    AND lower(json_extract(n.frontmatter,'$.doi'))=lower(c.doi)))`;
const lastDay = `coalesce((SELECT max(f.day) FROM feed_items f WHERE f.paper_id=c.paper_id),c.day)`;
// The index row with its FTS entry, and per occurrence the row, its indexes
// and the day's read counts (six kinds plus one per topic), each counted
// twice for index writes. Re-evaluated inside the deletion transaction.
const cost = `16 + (SELECT coalesce(sum(20+2*json_array_length(f.topics)),0)
  FROM feed_items f WHERE f.paper_id=c.paper_id)`;
// The first listing is never after the last, so the day index narrows the
// scan to rows first seen before the horizon.
const due = `c.day<?1 AND c.has_canonical=0
  AND NOT EXISTS(SELECT 1 FROM papers WHERE id=c.paper_id)
  AND ${lastDay}<?1 AND NOT (${kept})`;

export type ExpiryRow = {
  id: string;
  title: string;
  lastDay: string;
  bound: number;
};

/** The next compact rows that expire before `before`, oldest listing first. */
export async function expiryPage(
  db: IngestDatabase,
  before: string,
  limit = 100,
): Promise<{ rows: ExpiryRow[] }> {
  const { results } = await db
    .prepare(
      `SELECT c.paper_id AS id,c.title,${lastDay} AS lastDay,${cost} AS bound
      FROM paper_index c INDEXED BY paper_index_compact_day
      WHERE ${due} ORDER BY lastDay,c.paper_id LIMIT ?2`,
    )
    .bind(before, limit)
    .all<ExpiryRow>();
  return { rows: results };
}

/** What would expire before `before`: how many rows, the oldest listing day
 * and up to ten titles. */
export async function expiryPreview(db: IngestDatabase, before: string) {
  const row = await db
    .prepare(
      `WITH due AS MATERIALIZED (
        SELECT c.title,${lastDay} AS last_day FROM paper_index c INDEXED BY paper_index_compact_day
        WHERE ${due})
      SELECT (SELECT count(*) FROM due) AS count,(SELECT min(last_day) FROM due) AS oldestDay,
        (SELECT json_group_array(title) FROM (SELECT title FROM due ORDER BY last_day,title LIMIT 10)) AS sample`,
    )
    .bind(before)
    .first<{ count: number; oldestDay: string | null; sample: string }>();
  return {
    count: Number(row?.count ?? 0),
    oldestDay: row?.oldestDay ?? null,
    sample: JSON.parse(row?.sample ?? "[]") as string[],
  };
}

/** Delete a page of expiring compact rows in one transaction: first their
 * occurrences (so the day counts drop while the compact row still names the
 * paper), then the rows themselves (their FTS entries go by trigger). Every
 * condition is checked again inside the transaction; a row whose bound grew
 * stays. With `accounting`, nothing changes unless the prune lease is live. */
export async function expirePage(
  db: IngestDatabase,
  before: string,
  rows: readonly Pick<ExpiryRow, "id" | "bound" | "title">[],
  accounting?: { lease: WriteLease },
) {
  if (!rows.length) return { expired: 0, rowsWritten: 0 };
  if (rows.length > 100) throw new RangeError("Expiry page is too large");
  const wanted = JSON.stringify(
    rows.map(({ id, bound, title }) => ({ id, bound, title })),
  );
  const guard = accounting
    ? `AND ?4=date('now') AND EXISTS(
        SELECT 1 FROM write_leases WHERE id=?3 AND day=?4 AND expired=0)`
    : "";
  const statement = (sql: string) => {
    const query = db.prepare(sql);
    return accounting
      ? query.bind(before, wanted, accounting.lease.id, accounting.lease.day)
      : query.bind(before, wanted);
  };
  const chosen = (extra: string) => `SELECT c.paper_id FROM json_each(?2) w
    CROSS JOIN paper_index c ON c.paper_id=w.value->>'id'
    WHERE ${due} AND c.title=w.value->>'title' ${extra} ${guard}`;
  const results = await db.batch([
    statement(
      `DELETE FROM feed_items WHERE paper_id IN (${chosen(`AND ${cost}<=w.value->>'bound'`)})`,
    ),
    statement(
      `DELETE FROM paper_index WHERE has_canonical=0 AND paper_id IN (${chosen(
        "AND NOT EXISTS(SELECT 1 FROM feed_items WHERE paper_id=c.paper_id)",
      )}) RETURNING paper_id`,
    ),
  ]);
  return {
    expired: results[1]!.results.length,
    rowsWritten: results.reduce((sum, r) => sum + r.meta.rows_written, 0),
  };
}
