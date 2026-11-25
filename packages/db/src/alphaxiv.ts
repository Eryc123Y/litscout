import { ulid } from "ulid";
import { titleKey, vaultTitleKey } from "@litscout/core/normalize";
import type {
  MirrorItem,
  MirrorRun,
  MirrorWrite,
} from "@litscout/pipeline/alphaxiv-contracts";
import { decodeRow } from "./database";
import { type IngestDatabase } from "./ingest-store";

const active = "alphaxiv:active";
export const completedMirror = "alphaxiv:completed";
type RunRow = MirrorRun & { name: string };
type ItemRow = Record<string, unknown> & { key: string; paper_type: string };
const runs =
  "SELECT name, value AS digest, updated_at AS takenAt FROM sync_cursors WHERE name IN (?, ?)";
const currentRun =
  "SELECT 1 FROM sync_cursors WHERE name=? AND value=? AND updated_at=?";
// Test the active snapshot and its completion in the same transaction as each write.
const guard = `EXISTS (${currentRun}) AND NOT EXISTS (${currentRun})`;
const needsMetadata =
  "p.source='alphaxiv' AND nullif(trim(p.abstract),'') IS NULL";
const args = (run: MirrorRun) => [
  active,
  run.digest,
  run.takenAt,
  completedMirror,
  run.digest,
  run.takenAt,
];

export async function beginAlphaXiv(db: IngestDatabase, run: MirrorRun) {
  return changeRun(
    db,
    run,
    db
      .prepare(
        `
    INSERT INTO sync_cursors(name,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE excluded.updated_at > sync_cursors.updated_at
  `,
      )
      .bind(active, run.digest, run.takenAt),
  );
}

export async function finishAlphaXiv(db: IngestDatabase, run: MirrorRun) {
  return changeRun(
    db,
    run,
    db
      .prepare(
        `
    INSERT INTO sync_cursors(name,value,updated_at) SELECT ?,?,? WHERE ${guard}
    ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
  `,
      )
      .bind(completedMirror, run.digest, run.takenAt, ...args(run)),
    true,
  );
}

async function changeRun(
  db: IngestDatabase,
  run: MirrorRun,
  statement: D1PreparedStatement,
  countMissing = false,
) {
  const [change, read, backlog] = await db.batch<
    RunRow | { missingMetadata: number }
  >([
    statement,
    db.prepare(runs).bind(active, completedMirror),
    ...(countMissing
      ? [
          db.prepare(`
      SELECT count(DISTINCT a.paper_id) AS missingMetadata FROM alphaxiv_items a
      JOIN papers p ON p.id=a.paper_id
      WHERE a.user_id='u_owner' AND a.paper_type='public'
        AND a.removed_at IS NULL AND a.deleted_at IS NULL AND ${needsMetadata}
    `),
        ]
      : []),
  ]);
  const matches = (name: string) =>
    read!.results.some(
      (row) =>
        "name" in row &&
        row.name === name &&
        row.digest === run.digest &&
        row.takenAt === run.takenAt,
    );
  const finished = matches(completedMirror);
  const count = backlog?.results[0];
  return {
    applied: matches(active) || finished,
    completed: finished,
    rowsWritten: change!.meta.rows_written,
    ...(count && "missingMetadata" in count ? count : {}),
  };
}

export async function readAlphaXiv(db: IngestDatabase, after: string) {
  const [type = "", id = ""] = after.split(":", 2);
  const [page, cursors] = await db.batch<ItemRow | RunRow>([
    db
      .prepare(
        `
      SELECT a.paper_type || ':' || a.alphaxiv_id AS key, a.paper_type, a.alphaxiv_id AS paper_id,
        a.title,a.folders,a.status,a.publication_date,a.annotation,
        CASE WHEN ${needsMetadata} THEN 1 ELSE 0 END AS needs_metadata
      FROM alphaxiv_items a LEFT JOIN papers p ON p.id=a.paper_id
      WHERE a.user_id='u_owner' AND (a.paper_type,a.alphaxiv_id) > (?,?)
      ORDER BY a.paper_type,a.alphaxiv_id LIMIT 51
    `,
      )
      .bind(type, id),
    db.prepare(runs).bind(active, completedMirror),
  ]);
  const selected = (page!.results as ItemRow[]).slice(0, 50);
  function cursor(name: string) {
    const row = (cursors!.results as RunRow[]).find((r) => r.name === name);
    return row ? { digest: row.digest, takenAt: row.takenAt } : null;
  }
  return {
    active: cursor(active),
    completed: cursor(completedMirror),
    nextCursor: page!.results.length > 50 ? selected.at(-1)!.key : null,
    pendingMetadata: selected
      .filter((row) => row.needs_metadata === 1)
      .map((row) => row.paper_id),
    items: selected.map(
      ({
        key: _key,
        needs_metadata: _needsMetadata,
        publication_date,
        annotation,
        ...row
      }) =>
        decodeRow<MirrorItem>(
          row.paper_type === "private"
            ? row
            : { ...row, publication_date, annotation },
        ),
    ),
  };
}
export async function knownArxivIds(
  db: IngestDatabase,
  ids: readonly string[],
) {
  const found = await db
    .prepare(
      `SELECT i.value FROM paper_ids i JOIN papers p ON p.id=i.paper_id
        WHERE i.scheme='arxiv' AND i.value IN (${ids.map(() => "?").join(",")})
          AND NOT (${needsMetadata})`,
    )
    .bind(...ids)
    .all<{ value: string }>();
  return found.results.map((row) => row.value);
}

export async function writeAlphaXiv(db: IngestDatabase, run: MirrorWrite) {
  const statements = run.items.flatMap((item) => [
    ...(item.paperType === "public" && item.folders.length
      ? paperStatements(db, run, item)
      : []),
    mirrorStatement(db, run, item),
  ]);
  const results = await db.batch<{ current: number }>([
    ...statements,
    db.prepare(`SELECT ${guard} AS current`).bind(...args(run)),
  ]);
  return {
    accepted: results.pop()!.results[0]?.current ? run.items.length : 0,
    rowsWritten: results.reduce(
      (sum, result) => sum + result.meta.rows_written,
      0,
    ),
  };
}

const paperLookup =
  "SELECT paper_id FROM paper_ids WHERE scheme='arxiv' AND value=?";
const storedMirrorPaper =
  "SELECT paper_id FROM alphaxiv_items WHERE user_id='u_owner' AND paper_type='public' AND alphaxiv_id=?";
const publicPaper = `coalesce((${paperLookup}),(${storedMirrorPaper}))`;
function paperStatements(
  db: IngestDatabase,
  run: MirrorRun,
  item: Extract<MirrorWrite["items"][number], { paperType: "public" }>,
) {
  const id = "pap_" + ulid();
  const title = item.metadata?.title ?? item.title;
  const date = item.metadata?.publicationDate ?? item.publicationDate;
  const abstract = item.metadata?.abstract?.trim() || null;
  return [
    db
      .prepare(
        `
      INSERT INTO papers(id,title,title_norm,vault_title_norm,abstract,authors,venue,venue_kind,year,published_on,source)
      SELECT ?,?,?,?,?,?,'arXiv','preprint',?,?,?
      WHERE ${guard} AND ${publicPaper} IS NULL
    `,
      )
      .bind(
        id,
        title,
        titleKey(title),
        vaultTitleKey(title),
        abstract,
        JSON.stringify(item.metadata?.authors ?? []),
        date ? Number(date.slice(0, 4)) : null,
        date,
        abstract ? "arxiv" : "alphaxiv",
        ...args(run),
        item.paperId,
        item.paperId,
      ),
    db
      .prepare(
        `
      INSERT OR IGNORE INTO paper_ids(paper_id,scheme,value)
      SELECT id,'arxiv',? FROM papers WHERE id=coalesce((${storedMirrorPaper}),?) AND ${guard}
    `,
      )
      .bind(item.paperId, item.paperId, id, ...args(run)),
    db
      .prepare(
        `
      UPDATE papers SET deleted_at=NULL,rev=rev+1
      WHERE id=(${paperLookup}) AND deleted_at IS NOT NULL AND ${guard}
    `,
      )
      .bind(item.paperId, ...args(run)),
    ...(abstract && item.metadata
      ? [
          db
            .prepare(
              `
        UPDATE papers AS p SET title=?,title_norm=?,vault_title_norm=?,abstract=?,authors=coalesce(?,authors),
          published_on=coalesce(?,published_on),year=coalesce(?,year),source='arxiv',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),rev=rev+1
        WHERE id=(${paperLookup}) AND ${needsMetadata} AND ${guard}
      `,
            )
            .bind(
              title,
              titleKey(title),
              vaultTitleKey(title),
              abstract,
              item.metadata.authors.length
                ? JSON.stringify(item.metadata.authors)
                : null,
              item.metadata.publicationDate ?? null,
              item.metadata.publicationDate
                ? Number(item.metadata.publicationDate.slice(0, 4))
                : null,
              item.paperId,
              ...args(run),
            ),
        ]
      : []),
  ];
}

function mirrorStatement(db: IngestDatabase, run: MirrorRun, item: MirrorItem) {
  const publicItem = item.paperType === "public" ? item : null;
  return db
    .prepare(
      `
    INSERT INTO alphaxiv_items(alphaxiv_id,paper_type,paper_id,title,folders,status,publication_date,annotation,saved_at,synced_at,removed_at)
    SELECT ?,?,${publicPaper},?,?,?,?,?,?,?,?
    WHERE ${guard}
      AND (? OR EXISTS(SELECT 1 FROM alphaxiv_items WHERE user_id='u_owner' AND paper_type=? AND alphaxiv_id=?))
    ON CONFLICT(user_id,paper_type,alphaxiv_id) DO UPDATE SET
      paper_id=excluded.paper_id,title=excluded.title,folders=excluded.folders,status=excluded.status,
      publication_date=excluded.publication_date,annotation=excluded.annotation,synced_at=excluded.synced_at,
      removed_at=CASE WHEN excluded.removed_at IS NULL THEN NULL ELSE coalesce(alphaxiv_items.removed_at,excluded.removed_at) END,
      deleted_at=NULL,rev=alphaxiv_items.rev+1
    WHERE alphaxiv_items.paper_id IS NOT excluded.paper_id OR alphaxiv_items.title IS NOT excluded.title
      OR alphaxiv_items.folders IS NOT excluded.folders OR alphaxiv_items.status IS NOT excluded.status
      OR alphaxiv_items.publication_date IS NOT excluded.publication_date OR alphaxiv_items.annotation IS NOT excluded.annotation
      OR (alphaxiv_items.removed_at IS NULL) != (excluded.removed_at IS NULL) OR alphaxiv_items.deleted_at IS NOT NULL
  `,
    )
    .bind(
      item.paperId,
      item.paperType,
      publicItem?.paperId ?? null,
      publicItem?.paperId ?? null,
      item.title,
      JSON.stringify(item.folders),
      item.status,
      publicItem?.publicationDate ?? null,
      publicItem?.annotation ? JSON.stringify(publicItem.annotation) : null,
      run.takenAt,
      run.takenAt,
      item.folders.length ? null : run.takenAt,
      ...args(run),
      Number(!!item.folders.length),
      item.paperType,
      item.paperId,
    );
}
