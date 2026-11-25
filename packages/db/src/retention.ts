import { vaultTitleKey } from "@litscout/core/normalize";
import {
  retentionPageSize,
  retentionReasons,
} from "@litscout/pipeline/retention-contracts";
import type { IngestDatabase } from "./ingest-store";
import type { WriteLease } from "./write-budget";

const age = "coalesce(p.first_seen_on,substr(p.created_at,1,10))";
const latestDay =
  "(SELECT f.day FROM feed_items f WHERE f.paper_id=p.id ORDER BY f.day DESC LIMIT 1)";
// Unary + strips the outer column affinity so SQLite can seek the JSON expression indexes.
const rule = {
  library: `EXISTS(SELECT 1 FROM library_items WHERE paper_id=p.id)
    OR EXISTS(SELECT 1 FROM alphaxiv_items WHERE paper_id=p.id)`,
  reading: `EXISTS(SELECT 1 FROM events WHERE paper_id=p.id)
    OR EXISTS(SELECT 1 FROM paper_state WHERE paper_id=p.id)`,
  digest: `EXISTS(SELECT 1 FROM retention_refs WHERE paper_id=p.id AND source='digests')
    OR EXISTS(SELECT 1 FROM radar_grades WHERE paper_id=p.id)`,
  research: `EXISTS(SELECT 1 FROM retention_refs WHERE paper_id=p.id AND source<>'digests')
    OR EXISTS(SELECT 1 FROM idea_links WHERE target_type='paper' AND target_id=p.id)
    OR EXISTS(SELECT 1 FROM notes WHERE target_type='paper' AND target_id=p.id)
    OR EXISTS(SELECT 1 FROM missed WHERE paper_id=p.id)
    OR EXISTS(SELECT 1 FROM captures WHERE source_paper_id=p.id)
    OR EXISTS(SELECT 1 FROM vault_requests INDEXED BY vault_requests_retention_paper WHERE json_extract(payload,'$.paperId')=+p.id)
    OR EXISTS(SELECT 1 FROM vault_notes WHERE title_paper_id=p.id AND deleted_at IS NULL)
    OR EXISTS(SELECT 1 FROM vault_notes WHERE kind='paper_note' AND deleted_at IS NULL
      AND title_norm>'' AND title_norm=p.vault_title_norm)
    -- Migration 0014 leaves Unicode title keys for vault sync to backfill.
    -- Until then there is no reliable SQL comparison for the missing key.
    OR EXISTS(SELECT 1 FROM vault_notes INDEXED BY vault_notes_unkeyed_title
      WHERE kind='paper_note' AND deleted_at IS NULL AND title_norm IS NULL
      AND json_extract(frontmatter,'$.arxiv') IS NULL AND json_extract(frontmatter,'$.doi') IS NULL)
    OR (p.vault_title_norm IS NULL AND EXISTS(SELECT 1 FROM vault_notes
      WHERE kind='paper_note' AND deleted_at IS NULL AND title_norm>''))
    OR EXISTS(SELECT 1 FROM paper_ids i WHERE i.paper_id=p.id AND (
      (i.scheme='arxiv' AND EXISTS(SELECT 1 FROM vault_notes n INDEXED BY vault_notes_arxiv
        WHERE n.kind='paper_note' AND n.deleted_at IS NULL AND lower(json_extract(n.frontmatter,'$.arxiv'))=lower(i.value)))
      OR (i.scheme='doi' AND EXISTS(SELECT 1 FROM vault_notes n INDEXED BY vault_notes_doi
        WHERE n.kind='paper_note' AND n.deleted_at IS NULL AND lower(json_extract(n.frontmatter,'$.doi'))=lower(i.value)))
    ))`,
  recent: `coalesce(${latestDay}>=?1,0)`,
};
const count = (table: string) =>
  `(SELECT count(*) FROM ${table} WHERE paper_id=p.id)`;
// Count affected children and feed days, with room for ordinary indexes and
// FTS segment writes. Re-evaluate the bound inside the deletion transaction.
const cost = `36 + 3*${count("paper_ids")} + 4*${count("paper_links")}
  + 2*${count("summaries")} + 2*${count("feed_items")}`;

export type RetentionCursor = { age: string; id: string };
type RetentionRow = RetentionCursor & {
  title: string;
  bound: number;
  reasons: (keyof typeof rule)[];
};
export const retentionPageSql = `
  WITH same_day AS MATERIALIZED (
    SELECT p.id,${age} AS age FROM papers p INDEXED BY papers_retention_age
    WHERE p.deleted_at IS NULL AND ${age}=?2 AND p.id>?3 AND ${age}<?5
    ORDER BY p.id LIMIT ?4
  ), later AS MATERIALIZED (
    SELECT p.id,${age} AS age FROM papers p INDEXED BY papers_retention_age
    WHERE p.deleted_at IS NULL AND ${age}>?2 AND ${age}<?5
    ORDER BY ${age},p.id LIMIT ?4
  ), page AS MATERIALIZED (
    SELECT * FROM same_day UNION ALL SELECT * FROM later
    ORDER BY age,id LIMIT ?4
  )
  SELECT p.id,p.title,${age} AS age,${cost} AS bound,
    ${retentionReasons.map((key) => `(${rule[key]}) AS ${key}`).join(",")}
  FROM page CROSS JOIN papers p ON p.id=page.id ORDER BY age,p.id`;

export async function retentionPage(
  db: IngestDatabase,
  cutoff: string,
  cursor: RetentionCursor | null,
  limit = retentionPageSize,
  oldOnly = false,
) {
  const { results, meta } = await db
    .prepare(retentionPageSql)
    .bind(
      cutoff,
      cursor?.age ?? "",
      cursor?.id ?? "",
      limit,
      oldOnly ? cutoff : "~",
    )
    .all<Omit<RetentionRow, "reasons"> & Record<keyof typeof rule, number>>();
  const rows: RetentionRow[] = results.map(
    ({ id, title, age, bound, ...flags }) => ({
      id,
      title,
      age,
      bound,
      reasons: retentionReasons.filter((key) => flags[key]),
    }),
  );
  return { rows, sizeBytes: meta.size_after > 0 ? meta.size_after : null };
}

const eligible = `p.deleted_at IS NULL AND ${age}<?1 AND NOT (${Object.values(rule).join(" OR ")})`;
const qualified = `SELECT p.id FROM json_each(?2) wanted
  CROSS JOIN papers p ON p.id=wanted.value->>'id'
  WHERE ${eligible} AND ${cost}<=wanted.value->>'bound' AND p.title=wanted.value->>'title'`;
const activePrune = (id: string, day: string) =>
  `${day}=date('now') AND EXISTS(
    SELECT 1 FROM write_leases WHERE id=${id} AND day=${day} AND expired=0)`;

export async function prunePage(
  db: IngestDatabase,
  cutoff: string,
  rows: readonly Pick<RetentionRow, "id" | "bound" | "title">[],
  accounting?: { lease: WriteLease; at: string },
) {
  if (!rows.length) return { pruned: 0, rowsWritten: 0 };
  if (rows.length > 40) throw new RangeError("Prune page is too large");
  const wanted = JSON.stringify(
    rows.map(({ id, bound, title }) => ({
      id,
      bound,
      title,
      titleNorm: vaultTitleKey(title),
    })),
  );
  const key = accounting ? "prune:" + accounting.lease.day : "";
  const guard = accounting ? `AND ${activePrune("?3", "?4")}` : "";
  const statement = (sql: string) => {
    const query = db.prepare(sql);
    return accounting
      ? query.bind(cutoff, wanted, accounting.lease.id, accounting.lease.day)
      : query.bind(cutoff, wanted);
  };
  const marked = `SELECT i.paper_id FROM json_each(?) j
    CROSS JOIN paper_index i ON i.paper_id=j.value->>'id'
    CROSS JOIN papers p ON p.id=i.paper_id WHERE i.has_canonical=0`;
  const statements = [
    // No full record may already be marked compact. This makes the marks
    // used by the DELETEs exclusive to this transaction, even on replay.
    db
      .prepare(
        `SELECT CASE WHEN EXISTS(${marked}) THEN json('inconsistent compact marker') ELSE 1 END`,
      )
      .bind(wanted),
    statement(`INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title,title_norm,has_canonical,topics,venue)
      SELECT p.id,
        coalesce((SELECT value FROM paper_ids WHERE paper_id=p.id AND scheme='arxiv' ORDER BY value LIMIT 1),i.arxiv_id),
        coalesce((SELECT value FROM paper_ids WHERE paper_id=p.id AND scheme='doi' ORDER BY value LIMIT 1),i.doi),
        min(${age},coalesce(i.day,${age})),p.title,j.value->>'titleNorm',1,
        coalesce((SELECT json_group_array(topic) FROM (
          SELECT j.value AS topic FROM feed_items f,json_each(f.topics) j WHERE f.paper_id=p.id
          UNION SELECT value FROM json_each(i.topics) ORDER BY topic)), '[]'),
        p.venue
      FROM json_each(?2) j CROSS JOIN papers p ON p.id=j.value->>'id' LEFT JOIN paper_index i ON i.paper_id=p.id
      WHERE p.id IN (${qualified} ${guard})
      ON CONFLICT(paper_id) DO UPDATE SET arxiv_id=excluded.arxiv_id,doi=excluded.doi,day=excluded.day,
        title=excluded.title,title_norm=excluded.title_norm,has_canonical=1,topics=excluded.topics,venue=excluded.venue
      WHERE paper_index.arxiv_id IS NOT excluded.arxiv_id OR paper_index.doi IS NOT excluded.doi
        OR paper_index.day IS NOT excluded.day OR paper_index.title IS NOT excluded.title
        OR paper_index.title_norm IS NOT excluded.title_norm OR paper_index.has_canonical<>1
        OR paper_index.topics IS NOT excluded.topics OR paper_index.venue IS NOT excluded.venue`),
    statement(
      `UPDATE paper_index SET has_canonical=0 WHERE paper_id IN (${qualified} ${guard})`,
    ),
    db
      .prepare(`DELETE FROM summaries WHERE paper_id IN (${marked})`)
      .bind(wanted),
    db
      .prepare(`DELETE FROM paper_links WHERE paper_id IN (${marked})`)
      .bind(wanted),
    db
      .prepare(`DELETE FROM paper_ids WHERE paper_id IN (${marked})`)
      .bind(wanted),
    db
      .prepare(`DELETE FROM papers WHERE id IN (${marked}) RETURNING id`)
      .bind(wanted),
  ];
  if (accounting) {
    statements.push(
      db
        .prepare(
          `INSERT INTO runs(id,kind,day,status,started_at,finished_at,stats)
      SELECT ?, 'prune', ?, 'done', ?, ?, json_object('papers',changes(),'waiting',NULL)
      WHERE changes()>0
      ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,
        stats=json_object('papers',json_extract(runs.stats,'$.papers')+json_extract(excluded.stats,'$.papers'),
          'waiting',NULL)`,
        )
        .bind(key, accounting.lease.day, accounting.at, accounting.at),
    );
  }
  const results = await db.batch(statements);
  return {
    pruned: results[6]!.results.length,
    rowsWritten: results.reduce((sum, r) => sum + r.meta.rows_written, 0),
  };
}

export function pruneStatusQuery(db: IngestDatabase, day?: string) {
  const query = db.prepare(`SELECT finished_at AS lastAt,
    json_extract(stats,'$.papers') AS papersPruned,
    coalesce((SELECT prune_charged FROM daily_write_usage WHERE day=runs.day),0) AS rowsUsed,
    json_extract(stats,'$.waiting') AS waiting
    FROM runs WHERE ${day ? "id=?" : "id>='prune:' AND id<'prune;' ORDER BY id DESC"} LIMIT 1`);
  return day ? query.bind("prune:" + day) : query;
}

export async function finishPrune(
  db: IngestDatabase,
  lease: WriteLease,
  at: string,
  waiting: number,
) {
  return db
    .prepare(
      `INSERT INTO runs(id,kind,day,status,started_at,finished_at,stats)
    SELECT ?1,'prune',?2,'done',?3,?3,json_object('papers',0,'waiting',?4)
    WHERE ${activePrune("?5", "?2")}
    ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,
      stats=json_set(runs.stats,'$.waiting',?4)`,
    )
    .bind("prune:" + lease.day, lease.day, at, waiting, lease.id)
    .run();
}
