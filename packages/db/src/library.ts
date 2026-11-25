import { alphaXivUrl } from "@litscout/pipeline/alphaxiv-contracts";
import { completedMirror } from "./alphaxiv";
import { doiPath } from "@litscout/core/normalize";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ulid } from "ulid";
import {
  editLibraryInput,
  libraryQuery,
  paperIdSchema,
  type LibraryItem,
  type LibraryPage,
  type LibraryRow,
} from "@litscout/pipeline/library-contracts";
import { atomic, first, rows, type Database } from "./database";

export const OWNER = "u_owner";
export const livePaper = (id: string) =>
  sql`EXISTS(SELECT 1 FROM papers WHERE id=${id} AND deleted_at IS NULL)`;
const cursor = z.tuple([
  z.iso.datetime(),
  z.union([paperIdSchema, z.string().max(136).startsWith("private:")]),
]);

function decodeCursor(value: string) {
  let data: unknown;
  try {
    data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(value), (s) => s.charCodeAt(0)),
      ),
    );
  } catch {
    /* The schema turns a malformed cursor into a validation error. */
  }
  return cursor.parse(data);
}

type LibraryResult = Omit<LibraryRow, "link" | "origin" | "alphaXiv"> & {
  rowKey: string;
  privateId: string | null;
  alphaxivId: string | null;
  mirroredTitle: string | null;
  savedUpdatedAt: string | null;
  mirrorStatus: "saved" | "reading" | "read" | null;
  annotation: { hasNotes: boolean; highlightCount: number } | null;
  folders: { id: string; path: string }[] | null;
  linkKind: string | null;
  linkUrl: string | null;
  doi: string | null;
  arxiv: string | null;
  /** For the Type filter only; the rows do not carry it. */
  venueKind: string | null;
};

export async function listLibrary(
  db: Database,
  input: unknown,
  /** The instance's top venues, for `top`. */
  topVenues: readonly string[] = [],
): Promise<LibraryPage> {
  const q = libraryQuery.parse(input);
  const conditions = [sql`1`];
  const activePublicMirror = sql`a.user_id=${OWNER} AND a.paper_type='public' AND a.removed_at IS NULL AND a.deleted_at IS NULL`;
  const preferredMirror = sql`FROM alphaxiv_items a WHERE a.paper_id=v.paper_id AND ${activePublicMirror}
    ORDER BY json_extract(a.annotation,'$.hasNotes') DESC,
      json_extract(a.annotation,'$.highlightCount') DESC,a.synced_at DESC,a.alphaxiv_id LIMIT 1`;
  const folderJoin = q.folder
    ? sql`LEFT JOIN json_each(a.folders) f ON json_extract(f.value,'$.id')=${q.folder}`
    : sql``;
  const folderHaving = q.folder ? sql`HAVING count(f.value)>0` : sql``;
  const before = q.cursor ? decodeCursor(q.cursor) : undefined;
  if (before) {
    const [added, key] = before;
    conditions.push(sql`(v.added_at,v.row_key)<(${added},${key})`);
  }
  if (q.origin === "alphaxiv")
    conditions.push(
      sql`v.mirror_status IS NOT NULL OR v.private_id IS NOT NULL`,
    );
  if (q.origin === "litscout") conditions.push(sql`v.rev IS NOT NULL`);
  if (q.folder) conditions.push(sql`v.mirror_status IS NOT NULL`);
  if (q.status) conditions.push(sql`v.status=${q.status}`);
  if (q.venue) conditions.push(sql`v.venue=${q.venue} COLLATE NOCASE`);
  if (q.year) conditions.push(sql`v.year=${q.year}`);
  // The day pages' venue filters: no venue type counts as a preprint, and a
  // private upload has no venue, so it is never among the top venues.
  if (q.kind) conditions.push(sql`coalesce(v.venue_kind,'preprint')=${q.kind}`);
  if (q.top)
    conditions.push(
      sql`v.venue IN (SELECT value FROM json_each(${JSON.stringify(topVenues)}))`,
    );
  const tags = (q.tags ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (tags.length)
    conditions.push(
      sql`NOT EXISTS(SELECT 1 FROM json_each(${JSON.stringify(tags)}) wanted
        WHERE NOT EXISTS(SELECT 1 FROM json_each(v.tags) actual WHERE actual.value=wanted.value COLLATE NOCASE))`,
    );
  if (q.q) {
    const term = q.q.toLowerCase();
    conditions.push(
      sql`(instr(lower(coalesce((SELECT a.title ${preferredMirror}),v.title)),${term})>0
        OR EXISTS(SELECT 1 FROM json_each(v.authors) WHERE instr(lower(json_extract(value,'$.name')),${term})>0))`,
    );
  }
  // Use the newer of the two source-window boundaries as the shared edge.
  // Rows older than it are left for the next request even if no row matches.
  const native = sql`l.user_id=${OWNER} AND l.deleted_at IS NULL
    ${before ? sql`AND (l.added_at,l.paper_id)<(${before[0]},${before[1]})` : sql``}`;
  const mirror = sql`a.user_id=${OWNER} AND a.removed_at IS NULL AND a.deleted_at IS NULL
    ${before ? sql`AND (a.library_added_at,a.library_key)<(${before[0]},${before[1]})` : sql``}`;
  type Edge = { addedAt: string; paperId: string };
  const edges = await Promise.all([
    rows<Edge>(
      db,
      sql`SELECT l.added_at,l.paper_id FROM library_items l
      WHERE ${native} ORDER BY l.added_at DESC,l.paper_id DESC LIMIT 2 OFFSET 35`,
    ),
    rows<Edge>(
      db,
      sql`SELECT a.library_added_at AS added_at,a.library_key AS paper_id
      FROM alphaxiv_items a INDEXED BY alphaxiv_library_order
      WHERE ${mirror} ORDER BY a.library_added_at DESC,a.library_key DESC LIMIT 2 OFFSET 35`,
    ),
  ]);
  const edge = edges
    .flatMap((page) => (page.length === 2 ? [page[0]!] : []))
    .reduce<Edge | undefined>(
      (newer, row) =>
        !newer ||
        row.addedAt > newer.addedAt ||
        (row.addedAt === newer.addedAt && row.paperId > newer.paperId)
          ? row
          : newer,
      undefined,
    );
  if (edge)
    conditions.push(
      sql`(v.added_at,v.row_key)>=(${edge.addedAt},${edge.paperId})`,
    );

  const [found, folders, sync] = await Promise.all([
    rows<LibraryResult>(
      db,
      sql`
    WITH native_page AS MATERIALIZED (
      SELECT l.* FROM library_items l WHERE ${native}
        ${edge ? sql`AND (l.added_at,l.paper_id)>=(${edge.addedAt},${edge.paperId})` : sql``}
    ), mirror_page AS MATERIALIZED (
      SELECT a.paper_type,a.paper_id,a.alphaxiv_id,a.title,a.library_added_at,a.library_key,a.synced_at
      FROM alphaxiv_items a INDEXED BY alphaxiv_library_order WHERE ${mirror}
        ${edge ? sql`AND (a.library_added_at,a.library_key)>=(${edge.addedAt},${edge.paperId})` : sql``}
    ), public_ids AS MATERIALIZED (
      SELECT paper_id FROM native_page
      UNION SELECT paper_id FROM mirror_page WHERE paper_type='public'
    ), public_mirror AS MATERIALIZED (
      SELECT a.paper_id,min(a.library_added_at) AS first_seen,
        max(CASE a.status WHEN 'read' THEN 2 WHEN 'reading' THEN 1 ELSE 0 END) AS progress
      FROM public_ids ids CROSS JOIN alphaxiv_items a ON a.paper_id=ids.paper_id ${folderJoin}
      WHERE ${activePublicMirror}
      GROUP BY a.paper_id ${folderHaving}
    ), public_entries AS (
      SELECT l.paper_id,l.rev,l.added_via,l.status,l.tags,l.added_at,l.updated_at,a.progress
      FROM native_page l LEFT JOIN public_mirror a ON a.paper_id=l.paper_id
      UNION ALL
      SELECT a.paper_id,NULL,NULL,NULL,'[]',a.first_seen,NULL,a.progress
      FROM public_mirror a
      WHERE NOT EXISTS (
        SELECT 1 FROM library_items l WHERE l.user_id=${OWNER} AND l.paper_id=a.paper_id AND l.deleted_at IS NULL
      )
    ), entries AS (
      SELECT p.id AS row_key,NULL AS private_id,p.id AS paper_id,p.title,
        p.verified,p.authors,p.venue,p.venue_kind,p.year,e.rev,e.added_via,NULL AS deleted_at,
        coalesce(e.status,CASE e.progress WHEN 2 THEN 'read' WHEN 1 THEN 'reading' ELSE 'saved' END) AS status,
        e.tags,e.added_at,e.updated_at AS saved_updated_at,
        CASE e.progress WHEN 2 THEN 'read' WHEN 1 THEN 'reading' WHEN 0 THEN 'saved' END AS mirror_status
      FROM public_entries e CROSS JOIN papers p ON p.id=e.paper_id AND p.deleted_at IS NULL
      UNION ALL
      SELECT library_key,alphaxiv_id,NULL,title,
        NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,library_added_at,
        synced_at,NULL
      FROM mirror_page WHERE paper_type='private'
    ), page AS MATERIALIZED (
      SELECT * FROM entries v
      WHERE ${sql.join(
        conditions.map((condition) => sql`(${condition})`),
        sql` AND `,
      )}
      ORDER BY added_at DESC,row_key DESC LIMIT ${q.limit + 1}
    ), page_folders AS (
      SELECT paper_id,json_group_array(json_object('id',id,'path',path) ORDER BY path,id) AS folders
      FROM (
        SELECT a.paper_id,json_extract(f.value,'$.id') AS id,max(json_extract(f.value,'$.path')) AS path
        FROM page v
        CROSS JOIN alphaxiv_items a ON a.paper_id=v.paper_id
        CROSS JOIN json_each(a.folders) f
        WHERE v.mirror_status IS NOT NULL AND ${activePublicMirror}
        GROUP BY a.paper_id,json_extract(f.value,'$.id')
      )
      GROUP BY paper_id
    )
    SELECT v.*,a.alphaxiv_id,a.title AS mirrored_title,a.annotation,
      coalesce(v.saved_updated_at,a.synced_at) AS updated_at,
      s.read_at,pf.folders,k.kind AS link_kind,k.url AS link_url,
      (SELECT value FROM paper_ids WHERE paper_id=v.paper_id AND scheme='doi' ORDER BY value LIMIT 1) AS doi,
      (SELECT value FROM paper_ids WHERE paper_id=v.paper_id AND scheme='arxiv' ORDER BY value LIMIT 1) AS arxiv
    FROM page v
    LEFT JOIN alphaxiv_items a ON a.user_id=${OWNER} AND a.paper_type='public'
      AND a.alphaxiv_id=(SELECT a.alphaxiv_id ${preferredMirror})
    LEFT JOIN page_folders pf ON pf.paper_id=v.paper_id
    LEFT JOIN paper_state s ON s.user_id=${OWNER} AND s.paper_id=v.paper_id AND s.deleted_at IS NULL
    LEFT JOIN paper_links k ON k.id=(
      SELECT id FROM paper_links WHERE paper_id=v.paper_id AND user_id=${OWNER}
        AND kind IN ('pdf_oa','pdf_arxiv','doi','landing')
      ORDER BY CASE kind WHEN 'pdf_oa' THEN 0 WHEN 'pdf_arxiv' THEN 1 WHEN 'doi' THEN 2 ELSE 3 END,
        http_status>=400, CASE source WHEN 'openalex' THEN 0 WHEN 'unpaywall' THEN 1 WHEN 'core' THEN 2 ELSE 3 END, id LIMIT 1)
    ORDER BY v.added_at DESC,v.row_key DESC
    `,
    ),
    rows<{ id: string; path: string }>(
      db,
      sql`
      SELECT folder_id AS id,max(path) AS path FROM alphaxiv_folder_counts
      WHERE user_id=${OWNER} GROUP BY folder_id ORDER BY path,id
    `,
    ),
    first<{ syncedAt: string }>(
      db,
      sql`SELECT updated_at AS synced_at FROM sync_cursors WHERE name=${completedMirror}`,
    ),
  ]);
  const selected = found.slice(0, q.limit);
  const last = selected.at(-1);
  const next =
    found.length > q.limit && last
      ? [last.addedAt, last.rowKey]
      : edge
        ? [edge.addedAt, edge.paperId]
        : null;
  return {
    items: selected.map(libraryEntry),
    nextCursor: next
      ? btoa(
          String.fromCharCode(
            ...new TextEncoder().encode(JSON.stringify(next)),
          ),
        )
      : null,
    alphaXiv: { syncedAt: sync?.syncedAt ?? null, folders },
  };
}

function libraryEntry({
  rowKey: _rowKey,
  privateId,
  alphaxivId,
  mirroredTitle,
  savedUpdatedAt: _savedUpdatedAt,
  mirrorStatus,
  annotation,
  folders,
  linkKind,
  linkUrl,
  doi,
  arxiv,
  venueKind: _venueKind,
  ...row
}: LibraryResult): LibraryPage["items"][number] {
  if (privateId)
    return {
      title: row.title,
      origin: ["alphaxiv-private"],
      link: { kind: "alphaxiv", url: alphaXivUrl(privateId, "private") },
    };
  return {
    ...row,
    title: mirroredTitle ?? row.title,
    origin: [
      ...(row.rev === null ? [] : (["litscout"] as const)),
      ...(alphaxivId ? (["alphaxiv"] as const) : []),
    ],
    link: preferredReadingLink(linkKind, linkUrl, doi, arxiv),
    ...(alphaxivId && mirrorStatus
      ? {
          alphaXiv: {
            url: alphaXivUrl(alphaxivId, "public"),
            status: mirrorStatus,
            folders: folders ?? [],
            hasNotes: annotation?.hasNotes ?? false,
            highlightCount: annotation?.highlightCount ?? 0,
          },
        }
      : {}),
  };
}

export function libraryItem(db: Database, paperId: string) {
  return first<LibraryItem>(
    db,
    sql`SELECT * FROM library_items WHERE user_id=${OWNER} AND paper_id=${paperId} AND deleted_at IS NULL`,
  );
}

export function addLibraryItemQueries(
  paperId: string,
  source: string,
  day: string,
  now: string,
  tags: readonly string[] = [],
  /** Asked for by the reader: a new entry gets it, and an entry still at
   * "saved" or "to_read" moves to it. Left out, nothing changes a status. */
  status?: "to_read" | "saved",
): [SQL, SQL] {
  const incoming = JSON.stringify([...new Set(tags)]);
  const moves = status
    ? sql`library_items.status IN ('saved','to_read') AND library_items.status<>${status}`
    : sql`0`;
  const newTags = sql`SELECT incoming.value FROM json_each(excluded.tags) incoming
    WHERE NOT EXISTS(SELECT 1 FROM json_each(library_items.tags) stored WHERE stored.value=incoming.value)`;
  return [
    sql`INSERT INTO events(id,user_id,paper_id,kind,day,source,at)
      SELECT ${`evt_${ulid()}`},${OWNER},${paperId},'save',${day},${source},${now}
      WHERE ${livePaper(paperId)} AND NOT EXISTS(
        SELECT 1 FROM library_items WHERE user_id=${OWNER} AND paper_id=${paperId} AND deleted_at IS NULL)`,
    sql`INSERT INTO library_items(user_id,paper_id,added_via,added_at,updated_at,tags,status)
      SELECT ${OWNER},${paperId},${source.split(":")[0]},${now},${now},${incoming},${status ?? "saved"} WHERE ${livePaper(paperId)}
      ON CONFLICT(user_id,paper_id) DO UPDATE SET deleted_at=NULL,
        status=CASE
          WHEN ${status ?? null} IS NULL AND library_items.deleted_at IS NOT NULL
            AND library_items.status='to_read' THEN 'saved'
          WHEN ${status ?? null} IS NULL THEN library_items.status
          WHEN library_items.deleted_at IS NOT NULL OR library_items.status IN ('saved','to_read') THEN ${status ?? null}
          ELSE library_items.status END,
        added_at=CASE WHEN library_items.deleted_at IS NULL THEN library_items.added_at ELSE excluded.added_at END,
        added_via=CASE WHEN library_items.deleted_at IS NULL THEN library_items.added_via ELSE excluded.added_via END,
        updated_at=excluded.updated_at,rev=library_items.rev+1,
        tags=(SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(library_items.tags) UNION ALL ${newTags}
        ))
      WHERE library_items.deleted_at IS NOT NULL OR EXISTS(${newTags}) OR (${moves})`,
  ];
}

export async function addLibraryItem(
  db: Database,
  paperId: string,
  source: string,
  day: string,
  now: string,
  status?: "to_read" | "saved",
) {
  await atomic(db, [
    ...addLibraryItemQueries(paperId, source, day, now, [], status),
    // Keeping a paper takes back an earlier skip.
    sql`UPDATE paper_state SET skipped_at=NULL,updated_at=${now},rev=rev+1
      WHERE user_id=${OWNER} AND paper_id=${paperId} AND skipped_at IS NOT NULL
        AND ${livePaper(paperId)}`,
  ]);
  return libraryItem(db, paperId);
}

export async function editLibraryItem(
  db: Database,
  paperId: string,
  ifRev: number,
  now: string,
  input: z.output<typeof editLibraryInput> | null,
) {
  const where = sql`user_id=${OWNER} AND paper_id=${paperId} AND deleted_at IS NULL`;
  const change = input
    ? sql`status=coalesce(${input.status ?? null},status),tags=coalesce(${input.tags ? JSON.stringify([...new Set(input.tags)]) : null},tags)`
    : sql`deleted_at=${now}`;
  const item = await first<LibraryItem>(
    db,
    sql`UPDATE library_items SET ${change}, updated_at=${now},rev=rev+1 WHERE ${where} AND rev=${ifRev} RETURNING *`,
  );
  return item ? { item } : { current: await libraryItem(db, paperId) };
}

function preferredReadingLink(
  kind: string | null,
  url: string | null,
  doi: string | null,
  arxiv: string | null,
): LibraryRow["link"] {
  if (url && (kind === "pdf_oa" || kind === "pdf_arxiv")) return { kind, url };
  if (arxiv && /^(?:\d{4}\.\d{4,5}|[a-z.-]+\/\d{7})$/i.test(arxiv))
    return { kind: "pdf_arxiv", url: "https://arxiv.org/pdf/" + arxiv };
  if (url && kind === "doi") return { kind, url };
  if (doi) return { kind: "doi", url: "https://doi.org/" + doiPath(doi) };
  return kind && url ? { kind, url } : null;
}
