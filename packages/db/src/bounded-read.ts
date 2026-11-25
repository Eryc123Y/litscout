import { compactIdentifiers, compactPaperId } from "./compact-paper";
import { z } from "zod";
import { readDerivedArxivLinks } from "@litscout/pipeline/legacy-links";
import {
  feedQuerySchema,
  todoQuerySchema,
  fullPageQuerySchema,
  historyQuerySchema,
  paperQuerySchema,
  listAuthorsMax,
  type fullPageSchema,
  type historyPageSchema,
  type feedPageSchema,
  type todoPageSchema,
  type ListPaper,
} from "@litscout/pipeline/read-contracts";
import { daySchema, type FeedItem } from "@litscout/pipeline/contracts/index";
import type { IngestDatabase } from "./ingest-store";
type Row = Record<string, unknown>;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const compactJoin =
  "LEFT JOIN paper_index i ON i.paper_id=f.paper_id AND p.id IS NULL AND i.has_canonical=0";
export const join = `FROM feed_items f LEFT JOIN papers p ON p.id=f.paper_id ${compactJoin}`;
export const visible =
  "p.deleted_at IS NULL AND (p.id IS NOT NULL OR i.paper_id IS NOT NULL)";
export const stateJoin =
  "LEFT JOIN paper_state s ON s.paper_id=p.id AND s.user_id='u_owner' AND s.deleted_at IS NULL";
/** The reader's library entry for the row's paper, if any. */
const libraryEntry =
  "SELECT status FROM library_items WHERE user_id='u_owner' AND paper_id=f.paper_id AND deleted_at IS NULL";
export const codeLink =
  "EXISTS(SELECT 1 FROM paper_links WHERE paper_id=f.paper_id AND kind='code')";
/** The signed-in reader's columns on a list row. */
const listState = `s.read_at,s.skipped_at,(${libraryEntry}) AS library_status`;
const invalidCursor = z.never({ error: "Invalid cursor" });
const cursorSchema = z.strictObject({
  v: z.literal(1),
  context: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/),
  rank: z.number().finite(),
  shortlistOrder: z.union([z.literal(0), z.literal(1)]).optional(),
  day: daySchema.optional(),
  id: z.string().min(1).max(5000),
  source: z.string().min(1).max(5000),
});
function encodeCursor(value: z.infer<typeof cursorSchema>) {
  return btoa(String.fromCharCode(...encoder.encode(JSON.stringify(value))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decodeCursor(value: string, context: string) {
  let data: unknown;
  try {
    data = JSON.parse(
      decoder.decode(
        Uint8Array.from(
          atob(value.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      ),
    );
  } catch {
    invalidCursor.parse(value);
  }
  const cursor = cursorSchema.parse(data);
  if (cursor.context !== context) invalidCursor.parse(value);
  return cursor;
}
const json = <T>(r: Row, key: string, fallback: string): T =>
  JSON.parse(String(r[key] ?? fallback)) as T;
const fullIdentifiers =
  "(SELECT json_group_array(json_object('scheme',scheme,'value',value)) FROM paper_ids WHERE paper_id=p.id) AS identifiers";
const identifiers = `${fullIdentifiers},i.arxiv_id AS compact_arxiv,i.doi AS compact_doi`;
const fullSummaries =
  "(SELECT json_group_array(json_object('paperId',paper_id,'lang',lang,'content',json(content),'model',model,'client',client)) FROM summaries WHERE paper_id=p.id) AS summaries";
const tldr =
  "(SELECT json_group_array(json_object('lang',lang,'text',json_extract(content,'$.tldr'))) FROM summaries WHERE paper_id=p.id AND json_extract(content,'$.tldr') IS NOT NULL) AS tldr";
/** A list row's links: kind and address only. */
const listLinks =
  "(SELECT json_group_array(json_object('kind',kind,'url',url)) FROM paper_links WHERE paper_id=p.id) AS links";
const columns =
  "coalesce(p.id,i.paper_id) AS id,coalesce(p.title,i.title) AS title,coalesce(p.venue,i.venue) AS venue,p.venue_kind,p.year,p.published_on,p.categories,f.source,f.topics,f.shortlisted,f.hf_upvotes,f.rank_in_source,i.day AS first_seen_on,i.paper_id IS NOT NULL AS compact";
function metadata(r: Row) {
  return {
    paperId: String(r.id),
    title: String(r.title),
    source: String(r.source),
    topics: json<string[]>(r, "topics", "[]"),
    shortlisted: Boolean(r.shortlisted),
    venue: (r.venue ?? null) as string | null,
    venueKind: String(r.venue_kind ?? "preprint"),
    year: (r.year ?? null) as number | null,
    publishedOn: (r.published_on ?? null) as string | null,
    categories: json<string[]>(r, "categories", "[]"),
    hfUpvotes: (r.hf_upvotes ?? null) as number | null,
    identifiers: r.compact
      ? compactIdentifiers({
          arxivId: r.compact_arxiv as string | null,
          doi: r.compact_doi as string | null,
        })
      : json<FeedItem["identifiers"]>(r, "identifiers", "[]"),
  };
}
/** The columns of a list row; `listRow` turns the result into the row. */
export function listSelection(isPublic: boolean, keywordOnly = false) {
  return `${columns},
    (SELECT json_group_array(json(value)) FROM json_each(p.authors) WHERE cast(key AS integer)<${listAuthorsMax}) AS authors,
    json_array_length(p.authors) AS author_count,${identifiers},${listLinks},
    CASE WHEN p.id IS NULL THEN NULL ELSE p.abstract IS NOT NULL AND trim(p.abstract)<>'' END AS has_abstract,
    ${keywordOnly ? "p.abstract" : tldr}${isPublic ? "" : `,${listState}`}`;
}
export function listRow(
  r: Row,
  isPublic: boolean,
  keywordOnly = false,
): ListPaper {
  return {
    ...metadata(r),
    authors: json<ListPaper["authors"]>(r, "authors", "[]"),
    authorCount: Number(r.author_count ?? 0),
    links: json<NonNullable<ListPaper["links"]>>(r, "links", "[]"),
    tldr: json<ListPaper["tldr"]>(r, "tldr", "[]"),
    ...(r.has_abstract === null || r.has_abstract === undefined
      ? {}
      : { hasAbstract: Boolean(r.has_abstract) }),
    ...(keywordOnly ? { abstract: (r.abstract ?? null) as string | null } : {}),
    ...(!isPublic
      ? {
          readingState: {
            readAt: (r.read_at ?? null) as string | null,
            skippedAt: (r.skipped_at ?? null) as string | null,
            library: (r.library_status ?? null) as NonNullable<
              ListPaper["readingState"]
            >["library"],
          },
        }
      : {}),
  };
}
export async function readDayCounts(db: IngestDatabase, day: string) {
  const rows = await db
    .prepare("SELECT kind,key,n FROM feed_read_counts WHERE day=? AND n>0")
    .bind(day)
    .all<{ kind: string; key: string; n: number }>();
  const counts = {
    total: 0,
    summarised: 0,
    shortlisted: 0,
    arxiv: 0,
    venues: 0,
    sources: {} as Record<string, number>,
    topics: {} as Record<string, number>,
    venueCounts: {} as Record<string, number>,
  };
  let noAbstract = 0;
  for (const row of rows.results) {
    if (row.kind === "noAbstract") noAbstract = row.n;
    else if (
      row.kind === "sources" ||
      row.kind === "topics" ||
      row.kind === "venueCounts"
    )
      Object.defineProperty(counts[row.kind], row.key, {
        value: row.n,
        enumerable: true,
      });
    else if (
      row.kind === "total" ||
      row.kind === "summarised" ||
      row.kind === "shortlisted"
    )
      counts[row.kind] = row.n;
  }
  counts.arxiv = counts.sources.arxiv ?? 0;
  counts.venues = counts.total - counts.arxiv;
  return { counts, noAbstract };
}

export function readDayPage(
  db: IngestDatabase,
  day: string,
  input: unknown,
  isPublic: false,
  todo: false,
  full: true,
): Promise<z.infer<typeof fullPageSchema>>;
export function readDayPage(
  db: IngestDatabase,
  day: string,
  input?: unknown,
  isPublic?: boolean,
): Promise<z.infer<typeof feedPageSchema>>;
export function readDayPage(
  db: IngestDatabase,
  day: string,
  input: unknown,
  isPublic: boolean,
  variant: "keywords",
): Promise<z.infer<typeof feedPageSchema>>;
export function readDayPage(
  db: IngestDatabase,
  day: string,
  input: unknown,
  isPublic: boolean,
  todo: true,
): Promise<z.infer<typeof todoPageSchema>>;
export function readDayPage(
  db: IngestDatabase,
  day: string,
  input: unknown,
  isPublic: boolean,
  variant: false | "keywords",
  full: false,
  topVenues: readonly string[],
): Promise<z.infer<typeof feedPageSchema>>;
export async function readDayPage(
  db: IngestDatabase,
  day: string,
  input: unknown = {},
  isPublic = false,
  variant: boolean | "keywords" = false,
  full = false,
  /** The instance's top venues, for `top`. */
  topVenues: readonly string[] = [],
): Promise<{
  day: string;
  status: z.infer<typeof feedPageSchema>["status"];
  counts: z.infer<typeof feedPageSchema>["counts"];
  items: unknown[];
  nextCursor: string | null;
  noAbstract?: number;
}> {
  const todo = variant === true,
    keywordOnly = variant === "keywords";
  const todoQuery = todo ? todoQuerySchema.parse(input) : undefined;
  const fullQuery = full ? fullPageQuerySchema.parse(input) : undefined;
  const query = fullQuery ?? feedQuerySchema.parse(todoQuery ?? input);
  const ids = fullQuery?.ids;
  const { limit, cursor } = query;
  // Bind a cursor to its route, day, visibility and filters, while allowing a different page size.
  const contextBytes = encoder.encode(
    JSON.stringify([
      day,
      isPublic,
      todo,
      full,
      ids ?? null,
      query.topic ?? null,
      query.source ?? null,
      query.shortlisted ?? null,
      query.unread ?? null,
      query.venue ?? null,
      query.q ?? null,
      todoQuery?.lang ?? null,
      ...(keywordOnly ? ["keywords"] : []),
      // Added later: only when used, so earlier cursors stay valid.
      ...(query.kind || query.top
        ? [{ kind: query.kind ?? null, top: query.top ?? null }]
        : []),
      ...(query.code || (query.decision && !isPublic)
        ? [{ code: query.code ?? null, decision: query.decision ?? null }]
        : []),
    ]),
  );
  const context = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", contextBytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  const clauses = [visible],
    params: (string | number)[] = [];
  for (const [value, clause] of [
    [query.topic, "EXISTS(SELECT 1 FROM json_each(f.topics) WHERE value=?)"],
    [query.source, "f.source=?"],
    [query.venue, "coalesce(p.venue,i.venue)=?"],
  ] as const)
    if (value) {
      clauses.push(clause);
      params.push(value);
    }
  if (ids) {
    clauses.push(`f.paper_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  // Papers on the reader's topics come straight from the
  // (day, shortlisted, rank) index, so a page never starts from a window of
  // unmatched papers. Keyword-only instances group by shortlist themselves.
  const onTopics = query.shortlisted === true && !keywordOnly ? 1 : undefined;
  if (query.shortlisted !== undefined && onTopics === undefined) {
    clauses.push("f.shortlisted=?");
    params.push(Number(query.shortlisted));
  }
  const venues = venueFilters(query, topVenues, "coalesce(p.venue,i.venue)");
  clauses.push(...venues.clauses);
  params.push(...venues.params);
  if (query.unread !== undefined && !isPublic)
    clauses.push(query.unread ? "s.read_at IS NULL" : "s.read_at IS NOT NULL");
  if (query.code) clauses.push(codeLink);
  // A paper the reader kept shows even if it was skipped before.
  if (query.decision && !isPublic)
    clauses.push(
      {
        open: `(s.skipped_at IS NULL OR EXISTS(${libraryEntry}))`,
        skipped: `s.skipped_at IS NOT NULL AND NOT EXISTS(${libraryEntry})`,
        to_read: `EXISTS(${libraryEntry} AND status='to_read')`,
        saved: `EXISTS(${libraryEntry} AND status<>'to_read')`,
      }[query.decision],
    );
  if (query.q?.trim()) {
    clauses.push(
      "(instr(lower(coalesce(p.title,i.title)),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(p.authors) a WHERE instr(lower(json_extract(a.value,'$.name')),lower(?))>0))",
    );
    params.push(query.q.trim(), query.q.trim());
  }
  if (todo) {
    clauses.push(
      "p.abstract IS NOT NULL AND trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))<>''",
      "NOT EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id AND (lang=? OR client='legacy'))",
    );
    params.push(todoQuery!.lang);
  }
  const rankOrder = "f.rank_sort,f.paper_id,f.source";
  const order = keywordOnly ? `f.shortlisted DESC,${rankOrder}` : rankOrder;
  const after = cursor ? decodeCursor(cursor, context) : undefined;
  if (cursor && keywordOnly && after?.shortlistOrder === undefined)
    invalidCursor.parse(cursor);
  const selection = todo
    ? "p.id,p.title,p.abstract,f.rank_in_source,f.source,f.shortlisted"
    : full
      ? `${columns},p.abstract,p.authors,${identifiers},${fullSummaries},${links},s.read_at,p.verified`
      : listSelection(isPublic, keywordOnly);
  // Leaving out skipped papers is a state lookup on rows the page reads
  // anyway, so on its own it keeps the direct indexed read.
  const openOnly = query.decision === "open" && !isPublic;
  const filtered = !ids && clauses.length > (openOnly ? 2 : 1);
  type Position = Pick<
    z.infer<typeof cursorSchema>,
    "rank" | "id" | "source" | "shortlistOrder"
  >;
  const positionOf = (row: Row): Position => ({
    rank: Number(row.rank_in_source ?? -1),
    id: String(row.id),
    source: String(row.source),
    ...(keywordOnly ? { shortlistOrder: row.shortlisted ? 0 : 1 } : {}),
  });
  const select = async (
    size: number,
    shortlist?: number,
    position?: Position,
  ): Promise<{ rows: Row[]; scanned?: Position }> => {
    const seek = ["f.day=?"];
    const keys: (string | number)[] = [day];
    if (shortlist !== undefined) {
      seek.push("f.shortlisted=?");
      keys.push(shortlist);
    }
    if (position) {
      seek.push(`(${rankOrder})>(?,?,?)`);
      keys.push(position.rank, position.id, position.source);
    }
    const state = isPublic || todo ? "" : stateJoin;
    const predicate = clauses.join(" AND ");
    if (!filtered) {
      const { results } = await db
        .prepare(
          `SELECT ${selection} ${join} ${state}
         WHERE ${seek.join(" AND ")} AND ${predicate} ORDER BY ${order} LIMIT ?`,
        )
        .bind(...keys, ...params, size)
        .all<Row>();
      return { rows: results };
    }

    // Seek in the feed index before joining papers or evaluating sparse
    // filters. An empty filtered page can still have a continuation.
    // How far one request looks. Text search evaluates every candidate's
    // title and authors, so it keeps a short window. The other filters
    // (unread, topic, source, venue) are index and key lookups: one window
    // covers a busy day's matched papers, so "Unread" late in the day is
    // one request, not an empty page and five follow-ups.
    const scanLimit = todo ? 160 : query.q?.trim() ? 100 : 300;
    const { results } = await db
      .prepare(
        `WITH candidates AS MATERIALIZED (
         SELECT * FROM feed_items f WHERE ${seek.join(" AND ")} ORDER BY ${order} LIMIT ${scanLimit + 1}
       ), matched AS MATERIALIZED (
         SELECT ${selection} ${join.replace("feed_items f", "(SELECT * FROM candidates LIMIT " + scanLimit + ") f")} ${state}
         WHERE ${predicate} ORDER BY ${order} LIMIT ?
       ), boundary AS (
         SELECT f.paper_id AS scan_id,f.source AS scan_source,
           f.rank_sort AS scan_rank,f.shortlisted AS scan_shortlisted
         FROM candidates f
         WHERE EXISTS(SELECT 1 FROM candidates LIMIT 1 OFFSET ${scanLimit})
         ORDER BY ${order} LIMIT 1 OFFSET ${scanLimit - 1}
       )
       SELECT m.*,b.* FROM (SELECT 1) LEFT JOIN matched m ON true
       LEFT JOIN boundary b ON true
       ORDER BY ${keywordOnly ? "m.shortlisted DESC," : ""}coalesce(m.rank_in_source,-1),m.id,m.source`,
      )
      .bind(...keys, ...params, size)
      .all<Row>();
    const boundary = results[0];
    return {
      rows: results.filter((row) => row.id != null),
      ...(boundary?.scan_id
        ? {
            scanned: positionOf({
              id: boundary.scan_id,
              source: boundary.scan_source,
              rank_in_source: boundary.scan_rank,
              shortlisted: boundary.scan_shortlisted,
            }),
          }
        : {}),
    };
  };
  const loadPage = async () => {
    if (!keywordOnly || !after) return select(limit + 1, onTopics, after);
    // Seek within the current group, then fill from the next group if needed.
    // The v1 cursor stores 0 for shortlisted and 1 for other papers.
    const shortlist = 1 - after.shortlistOrder!;
    const page = await select(limit + 1, shortlist, after);
    if (
      shortlist === 1 &&
      !page.scanned &&
      page.rows.length <= limit &&
      query.shortlisted !== true
    ) {
      const later = await select(limit + 1 - page.rows.length, 0);
      return { rows: [...page.rows, ...later.rows], scanned: later.scanned };
    }
    return page;
  };
  const [{ rows, scanned }, feed, stats] = await Promise.all([
    loadPage(),
    db.prepare("SELECT status FROM feed_days WHERE day=?").bind(day).first<{
      status:
        "pending" | "empty" | "crawled" | "summarised" | "digested" | "final";
    }>(),
    readDayCounts(db, day),
  ]);
  const selected = rows.slice(0, limit);
  const next = rows.length > limit ? positionOf(selected.at(-1)!) : scanned;
  return {
    day,
    status: feed?.status ?? "pending",
    counts: stats.counts,
    items: selected.map((r) =>
      todo
        ? {
            paperId: String(r.id),
            title: String(r.title),
            abstract: String(r.abstract),
          }
        : full
          ? fullRecord(r, isPublic)
          : listRow(r, isPublic, keywordOnly),
    ),
    nextCursor: next ? encodeCursor({ v: 1, context, ...next }) : null,
    ...(todo ? { noAbstract: stats.noAbstract } : {}),
  };
}
const links =
  "p.derived_arxiv_links,(SELECT json_group_array(json_object('kind',kind,'url',url,'licence',licence,'oaStatus',oa_status,'checkedAt',checked_at,'httpStatus',http_status)) FROM paper_links WHERE paper_id=p.id) AS links";
function fullRecord(r: Row, isPublic = false): FeedItem {
  const paper = metadata(r);
  const savedLinks = json<FeedItem["links"]>(r, "links", "[]");
  return {
    ...paper,
    ...(r.compact
      ? {
          compact: true,
          ...(typeof r.first_seen_on === "string"
            ? { firstSeenOn: r.first_seen_on }
            : {}),
        }
      : {}),
    abstract: (r.abstract ?? null) as string | null,
    authors: json<FeedItem["authors"]>(r, "authors", "[]"),
    summaries: json<FeedItem["summaries"]>(r, "summaries", "[]"),
    links: [
      ...savedLinks,
      ...readDerivedArxivLinks(r.derived_arxiv_links as string).filter(
        (link) =>
          !savedLinks.some(
            (saved) => saved.kind === link.kind && saved.url === link.url,
          ),
      ),
    ],
    rankInSource: (r.rank_in_source ?? null) as number | null,
    ...(!isPublic
      ? {
          ...(r.compact ? {} : { verified: r.verified === 1 }),
          readingState: { readAt: (r.read_at ?? null) as string | null },
        }
      : {}),
  };
}
async function resolvePaperId(db: IngestDatabase, id: string) {
  if (id.startsWith("pap_")) return id;
  const prefixed =
    /^(arxiv|doi|openreview|openalex|s2|acl|pmlr|jmlr|pmid|dblp|url):(.+)$/.exec(
      id,
    );
  const statement = prefixed
    ? db
        .prepare("SELECT paper_id FROM paper_ids WHERE scheme=? AND value=?")
        .bind(prefixed[1], prefixed[2])
    : db
        .prepare(
          "SELECT paper_id FROM paper_ids WHERE value=? ORDER BY CASE scheme WHEN 'arxiv' THEN 0 WHEN 'doi' THEN 1 WHEN 'openreview' THEN 2 WHEN 'openalex' THEN 3 WHEN 's2' THEN 4 WHEN 'acl' THEN 5 WHEN 'pmlr' THEN 6 WHEN 'jmlr' THEN 7 WHEN 'pmid' THEN 8 WHEN 'dblp' THEN 9 WHEN 'url' THEN 10 ELSE 11 END,scheme,paper_id LIMIT 1",
        )
        .bind(id);
  return (
    (await statement.first<{ paper_id: string }>())?.paper_id ??
    compactPaperId(db, prefixed?.[2] ?? id, prefixed?.[1])
  );
}
/** The venue filters of the day pages, shared by the search: a paper with
 * no venue type counts as a preprint, and `top` keeps the instance's top
 * venues (none when it lists none). Each is bound only when used. */
function venueFilters(
  filters: { kind?: string; top?: boolean },
  topVenues: readonly string[],
  venue: string,
) {
  const clauses: string[] = [],
    params: string[] = [];
  if (filters.kind) {
    clauses.push("coalesce(p.venue_kind,'preprint')=?");
    params.push(filters.kind);
  }
  if (filters.top) {
    clauses.push(`${venue} IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(topVenues));
  }
  return { clauses, params };
}
/** Papers whose title or short summary has every word of the query (the
 * last word may be a beginning, so results follow the typing), best match
 * first, each with the latest day it was listed and its venue. The day
 * pages' venue filters narrow it the same way. */
export async function searchListedPapers(
  db: IngestDatabase,
  query: string,
  limit = 12,
  filters: { kind?: string; top?: boolean } = {},
  /** The instance's top venues, for `top`. */
  topVenues: readonly string[] = [],
) {
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return { items: [] };
  const expression = words
    .map((word, i) => `"${word}"${i === words.length - 1 ? "*" : ""}`)
    .join(" AND ");
  const latest = (column: string) =>
    `(SELECT ${column} FROM feed_items WHERE paper_id=p.id ORDER BY day DESC,source LIMIT 1)`;
  const venues = venueFilters(filters, topVenues, "p.venue");
  const { results } = await db
    .prepare(
      `SELECT p.id,p.title,p.venue,
        (SELECT json_group_array(json(value)) FROM json_each(p.authors) WHERE cast(key AS integer)<4) AS authors,
        json_array_length(p.authors) AS author_count,
        ${latest("day")} AS day,${latest("source")} AS source
       FROM paper_fts f JOIN papers p ON p.rowid=f.rowid
       WHERE ${["paper_fts MATCH ?", "p.deleted_at IS NULL", ...venues.clauses].join(" AND ")}
       ORDER BY rank LIMIT ?`,
    )
    .bind(expression, ...venues.params, limit)
    .all<Row>();
  return {
    items: results.map((r) => ({
      paperId: String(r.id),
      title: String(r.title),
      authors: json<{ name: string }[]>(r, "authors", "[]"),
      authorCount: Number(r.author_count ?? 0),
      day: (r.day ?? null) as string | null,
      source: (r.source ?? null) as string | null,
      venue: (r.venue ?? null) as string | null,
    })),
  };
}
export async function readPaper(
  db: IngestDatabase,
  id: string,
  day?: string,
  isPublic = false,
  source?: string,
) {
  paperQuerySchema.parse({ day, source });
  const paperId = await resolvePaperId(db, id);
  if (!paperId) return null;
  const filters = `${day ? "AND f.day=?" : ""} ${source ? "AND f.source=?" : ""}`;
  const inputs = [paperId, ...(day ? [day] : []), ...(source ? [source] : [])];
  const full = await db
    .prepare(
      `SELECT p.id,p.title,p.venue,p.venue_kind,p.year,p.published_on,p.categories,
        coalesce(f.source,p.source) AS source,f.topics,f.shortlisted,f.hf_upvotes,f.rank_in_source,
        p.abstract,p.authors,${fullIdentifiers},${fullSummaries},${links}${isPublic ? "" : ",s.read_at,p.verified"}
      FROM papers p ${isPublic ? "JOIN" : "LEFT JOIN"} feed_items f ON f.paper_id=p.id ${isPublic ? "" : stateJoin}
      WHERE p.deleted_at IS NULL AND p.id=? ${filters} ORDER BY f.day DESC,f.source LIMIT 1`,
    )
    .bind(...inputs)
    .first<Row>();
  if (full) return fullRecord(full, isPublic);
  const compact = await db
    .prepare(
      `SELECT i.paper_id AS id,i.title,i.venue,i.day AS first_seen_on,coalesce(f.source,'archive') AS source,
       coalesce(f.topics,i.topics) AS topics,f.shortlisted,f.hf_upvotes,f.rank_in_source,
       i.arxiv_id AS compact_arxiv,i.doi AS compact_doi,1 AS compact
     FROM paper_index i ${isPublic ? "JOIN" : "LEFT JOIN"} feed_items f ON f.paper_id=i.paper_id
     WHERE i.paper_id=? AND i.has_canonical=0 ${filters} ORDER BY f.day DESC,f.source LIMIT 1`,
    )
    .bind(...inputs)
    .first<Row>();
  return compact ? fullRecord(compact, isPublic) : null;
}
/** Thin metadata across days for deduplication, source signals and history indexes. */
export async function readHistory(
  db: IngestDatabase,
  input: unknown,
): Promise<z.infer<typeof historyPageSchema>> {
  const q = historyQuerySchema.parse(input),
    context = await contextHash(["history", q.from, q.to]);
  const where = ["f.day>=?", "f.day<=?", visible],
    params: (string | number)[] = [q.from, q.to];
  if (q.cursor) {
    const last = decodeCursor(q.cursor, context);
    daySchema.parse(last.day);
    where.push("(f.day,f.paper_id,f.source)>(?,?,?)");
    params.push(last.day!, last.id, last.source);
  }
  const rows = await db
    .prepare(
      `SELECT ${columns},f.day,(SELECT json_group_array(json(value)) FROM json_each(p.authors) WHERE cast(key AS integer)<4) AS authors,${identifiers},p.abstract IS NOT NULL AND length(p.abstract)>0 AS has_abstract ${join} WHERE ${where.join(" AND ")} ORDER BY f.day,f.paper_id,f.source LIMIT ?`,
    )
    .bind(...params, q.limit + 1)
    .all<Row>();
  const selected = rows.results.slice(0, q.limit),
    last = selected.at(-1);
  return {
    items: selected.map((r) => ({
      ...metadata(r),
      day: String(r.day),
      authors: json<ListPaper["authors"]>(r, "authors", "[]"),
      rankInSource: (r.rank_in_source ?? null) as number | null,
      hasAbstract: Boolean(r.has_abstract),
      ...(r.compact ? { compact: true as const } : {}),
    })),
    nextCursor:
      rows.results.length > q.limit && last
        ? encodeCursor({
            v: 1,
            context,
            rank: 0,
            day: String(last.day),
            id: String(last.id),
            source: String(last.source),
          })
        : null,
  };
}
async function contextHash(values: unknown[]) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify(values)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
