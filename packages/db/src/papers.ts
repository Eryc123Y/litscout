import type { CompactPaper } from "./compact-paper";
import { sql, type SQL } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import { samePaperEdition } from "@litscout/core/merge";
import {
  titleKey,
  normalizeDoi,
  vaultTitleKey,
} from "@litscout/core/normalize";
import { paperInput } from "./contracts";
import {
  atomic,
  first,
  rows,
  saveVersioned,
  type Database,
  type WriteResult,
} from "./database";
import type { papers } from "./schema";
export type PaperRow = typeof papers.$inferSelect;
type Input = z.output<typeof paperInput>;
type CompactRestore = CompactPaper & { maxFeedDays: number; utcDay: string };
const relations = [
  "paper_ids",
  "paper_links",
  "feed_items",
  "paper_index",
  "summaries",
  "radar_grades",
  "missed",
  "alphaxiv_items",
  "events",
] as const;
const mergeRelationCost = {
  paper_ids: 2,
  paper_links: 3,
  // Feed moves can write both the old and new counter contributions.
  feed_items: 5,
  paper_index: 10,
  summaries: 12,
  radar_grades: 5,
  missed: 4,
  alphaxiv_items: 5,
  events: 4,
} satisfies Record<(typeof relations)[number], number>;

export function mergeWriteBound(
  drop: string,
  group: readonly string[],
  metadata?: { updates: number; incomingCounters: number },
) {
  const count = (table: string) =>
    sql`(SELECT count(*) FROM ${sql.identifier(table)} WHERE paper_id=${drop})`;
  const target = sql`WHERE target_type='paper' AND target_id=${drop}`;
  const groupFeeds = sql`WHERE paper_id IN (SELECT value FROM json_each(${JSON.stringify(group)}))`;
  // Updating the surviving paper or its feed item can touch old and new
  // counters, including feed rows moved earlier in this transaction.
  const metadataCounters = metadata
    ? sql`${4 * metadata.updates}*(${metadata.incomingCounters} +
      (SELECT coalesce(sum(6+json_array_length(topics)),0) FROM feed_items ${groupFeeds}))`
    : sql`0`;
  // Allow both the move and conflict handling, indexes and dependent triggers.
  // A summary move touches counters on both papers' feed days. Count all feeds
  // in the group since an earlier merge may move some of them to the survivor.
  return sql`17
    + ${sql.join(
      relations.map(
        (table) =>
          sql`${sql.raw(String(mergeRelationCost[table]))}*${count(table)}`,
      ),
      sql` + `,
    )}
    + (SELECT coalesce(sum(2*(6+json_array_length(topics))),0) FROM feed_items WHERE paper_id=${drop})
    + (SELECT coalesce(sum(17+2*(json_array_length(d.topics)+json_array_length(f.topics))),0)
      FROM feed_items d CROSS JOIN feed_items f ON f.day=d.day AND f.source=d.source
      WHERE d.paper_id=${drop} AND f.paper_id<>d.paper_id
        AND f.paper_id IN (SELECT value FROM json_each(${JSON.stringify(group)})))
    + 2*${count("summaries")}*(SELECT count(*) FROM feed_items ${groupFeeds})
    + ${metadataCounters}
    + 10*${count("library_items")} + 6*${count("paper_state")}
    + 4*(SELECT count(*) FROM notes ${target})
    + 4*(SELECT count(*) FROM idea_links ${target})
    + 3*(SELECT count(*) FROM vault_notes WHERE title_paper_id=${drop} AND deleted_at IS NULL)
    + 2*(SELECT count(*) FROM captures WHERE source_paper_id=${drop})
    + 5*(SELECT count(*) FROM vault_requests WHERE json_extract(payload,'$.paperId')=${drop})
    + 4*(SELECT count(*) FROM retention_refs WHERE paper_id=${drop})
    + (SELECT count(*) FROM suggestions WHERE EXISTS(SELECT 1 FROM json_each(paper_ids) WHERE value=${drop}))
    + (SELECT count(*) FROM digests WHERE EXISTS(SELECT 1 FROM json_tree(picks) WHERE value=${drop})
        OR EXISTS(SELECT 1 FROM json_tree(radar) WHERE value=${drop}))`;
}
function identifiers(input: Input) {
  return input.identifiers.map(({ scheme, value }) => ({
    scheme,
    value:
      scheme === "doi"
        ? z.string().min(1).parse(normalizeDoi(value))
        : scheme === "arxiv"
          ? value.toLowerCase().replace(/v\d+$/, "")
          : value,
  }));
}
async function matching(db: Database, ids: ReturnType<typeof identifiers>) {
  if (!ids.length) return [];
  return rows<PaperRow>(
    db,
    sql`SELECT DISTINCT p.* FROM papers p JOIN paper_ids i ON p.id=i.paper_id WHERE ${sql.join(
      ids.map((i) => sql`(i.scheme=${i.scheme} AND i.value=${i.value})`),
      sql` OR `,
    )} ORDER BY p.created_at,p.id`,
  );
}
export function mergeQueries(keep: string, drop: string): SQL[] {
  return [
    sql`UPDATE library_items AS keep SET
      tags=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(keep.tags)
        UNION SELECT value FROM json_each(library_items.tags) WHERE value IS NOT NULL)),
      status=CASE WHEN keep.deleted_at IS NOT NULL OR library_items.updated_at>keep.updated_at THEN library_items.status ELSE keep.status END,
      deleted_at=NULL,updated_at=max(keep.updated_at,library_items.updated_at),rev=keep.rev+1
      FROM library_items WHERE keep.paper_id=${keep} AND library_items.paper_id=${drop}
        AND keep.user_id=library_items.user_id AND library_items.deleted_at IS NULL`,
    sql`UPDATE OR IGNORE library_items SET paper_id=${keep} WHERE paper_id=${drop}`,
    sql`DELETE FROM library_items WHERE paper_id=${drop}`,
    sql`UPDATE paper_state AS keep SET
      read_at=coalesce(max(keep.read_at,paper_state.read_at),keep.read_at,paper_state.read_at),
      starred=max(keep.starred,paper_state.starred),read_later=max(keep.read_later,paper_state.read_later),
      rating=CASE WHEN keep.rating='none' OR (paper_state.rating<>'none' AND paper_state.updated_at>keep.updated_at) THEN paper_state.rating ELSE keep.rating END,
      skipped_at=CASE WHEN paper_state.updated_at>keep.updated_at THEN paper_state.skipped_at ELSE keep.skipped_at END,
      deleted_at=NULL,updated_at=max(keep.updated_at,paper_state.updated_at),rev=keep.rev+1
      FROM paper_state WHERE keep.paper_id=${keep} AND paper_state.paper_id=${drop}
        AND keep.user_id=paper_state.user_id AND paper_state.deleted_at IS NULL`,
    sql`UPDATE OR IGNORE paper_state SET paper_id=${keep} WHERE paper_id=${drop}`,
    sql`DELETE FROM paper_state WHERE paper_id=${drop}`,
    sql`WITH combined AS MATERIALIZED (
      SELECT kept.rowid AS feed_row,
        (SELECT json_group_array(topic ORDER BY topic) FROM (
          SELECT value AS topic FROM json_each(kept.topics)
          UNION SELECT value FROM json_each(dropped.topics)
        )) AS topics,
        coalesce(min(kept.rank_in_source,dropped.rank_in_source),kept.rank_in_source,dropped.rank_in_source) AS rank,
        coalesce(max(kept.hf_upvotes,dropped.hf_upvotes),kept.hf_upvotes,dropped.hf_upvotes) AS votes,
        max(kept.shortlisted,dropped.shortlisted) AS shortlisted
      FROM feed_items dropped CROSS JOIN feed_items kept ON kept.day=dropped.day AND kept.source=dropped.source
      WHERE dropped.paper_id=${drop} AND kept.paper_id=${keep}
    )
    UPDATE feed_items SET topics=combined.topics,rank_in_source=combined.rank,
      hf_upvotes=combined.votes,shortlisted=combined.shortlisted,rev=rev+1
    FROM combined WHERE feed_items.rowid=combined.feed_row
      AND (feed_items.topics IS NOT combined.topics OR rank_in_source IS NOT combined.rank
        OR hf_upvotes IS NOT combined.votes OR feed_items.shortlisted IS NOT combined.shortlisted)`,
    ...relations.flatMap((table) => [
      sql`UPDATE OR IGNORE ${sql.identifier(table)} SET paper_id=${keep} WHERE paper_id=${drop}`,
      sql`DELETE FROM ${sql.identifier(table)} WHERE paper_id=${drop}`,
    ]),
    sql`UPDATE notes SET target_id=${keep},rev=rev+1 WHERE target_type='paper' AND target_id=${drop}`,
    sql`UPDATE OR IGNORE idea_links SET target_id=${keep} WHERE target_type='paper' AND target_id=${drop}`,
    sql`DELETE FROM idea_links WHERE target_type='paper' AND target_id=${drop}`,
    sql`UPDATE vault_notes SET title_paper_id=${keep} WHERE title_paper_id=${drop} AND deleted_at IS NULL`,
    sql`UPDATE captures SET source_paper_id=${keep} WHERE source_paper_id=${drop}`,
    sql`WITH duplicate AS MATERIALIZED (
      SELECT id FROM vault_requests
      WHERE kind='make_paper_note' AND state='queued' AND json_extract(payload,'$.paperId')=${drop}
        AND EXISTS(SELECT 1 FROM vault_requests
          WHERE kind='make_paper_note' AND state='queued' AND json_extract(payload,'$.paperId')=${keep})
    )
    UPDATE vault_requests SET payload=json_set(payload,'$.paperId',${keep}),
      state=CASE WHEN id IN duplicate THEN 'cancelled' ELSE state END,
      reason=CASE WHEN id IN duplicate THEN 'Merged duplicate paper request' ELSE reason END,
      resolved_at=CASE WHEN id IN duplicate THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE resolved_at END,
      claim=NULL,claim_until=NULL
    WHERE json_extract(payload,'$.paperId')=${drop}`,
    sql`UPDATE idea_index SET paper_ids=replace(paper_ids,json_quote(${drop}),json_quote(${keep}))
      WHERE id IN (SELECT source_key FROM retention_refs WHERE paper_id=${drop} AND source='idea_index')`,
    sql`UPDATE working_paper_index SET paper_ids=replace(paper_ids,json_quote(${drop}),json_quote(${keep}))
      WHERE id IN (SELECT source_key FROM retention_refs WHERE paper_id=${drop} AND source='working_paper_index')`,
    sql`UPDATE suggestions SET paper_ids=(SELECT json_group_array(CASE WHEN value=${drop} THEN ${keep} ELSE value END) FROM json_each(suggestions.paper_ids)),rev=rev+1 WHERE EXISTS (SELECT 1 FROM json_each(suggestions.paper_ids) WHERE value=${drop})`,
    sql`UPDATE digests SET picks=replace(picks,json_quote(${drop}),json_quote(${keep})),radar=replace(radar,json_quote(${drop}),json_quote(${keep})),rev=rev+1 WHERE EXISTS (SELECT 1 FROM json_tree(picks) WHERE value=${drop}) OR EXISTS (SELECT 1 FROM json_tree(radar) WHERE value=${drop})`,
    sql`UPDATE papers SET derived_arxiv_links=(
      SELECT json_group_array(json(value)) FROM (
        SELECT value FROM json_each(papers.derived_arxiv_links)
        UNION SELECT j.value FROM papers removed, json_each(removed.derived_arxiv_links) j
          WHERE removed.id=${drop}
      )
    ) WHERE id=${keep} AND EXISTS(
      SELECT 1 FROM papers removed WHERE removed.id=${drop} AND removed.derived_arxiv_links<>'[]'
    )`,
    sql`DELETE FROM papers WHERE id=${drop}`,
  ];
}
function childQueries(
  id: string,
  v: Input,
  ids: ReturnType<typeof identifiers>,
  fresh = false,
): SQL[] {
  return [
    ...ids.map(
      (i) =>
        sql`INSERT ${fresh ? sql`` : sql`OR IGNORE`} INTO paper_ids(paper_id,scheme,value) VALUES (${id},${i.scheme},${i.value})`,
    ),
    ...v.links.map(
      (l) =>
        sql`INSERT INTO paper_links(id,paper_id,kind,url,licence,oa_status,source) VALUES (${`lnk_${ulid()}`},${id},${l.kind},${l.url},${l.licence ?? null},${l.oaStatus},${l.source ?? v.source})
          ON CONFLICT(paper_id,kind,url) DO UPDATE SET licence=coalesce(excluded.licence,paper_links.licence),
          oa_status=CASE WHEN excluded.oa_status='unknown' THEN paper_links.oa_status ELSE excluded.oa_status END,
          source=excluded.source WHERE excluded.kind='pdf_oa' `,
    ),
  ];
}
async function unchanged(
  db: Database,
  current: PaperRow,
  v: Input,
  ids: ReturnType<typeof identifiers>,
) {
  if (
    current.title !== v.title ||
    (v.verified !== undefined && v.verified !== current.verified) ||
    (v.abstract !== undefined && current.abstract !== v.abstract) ||
    (v.authors.length > 0 &&
      JSON.stringify(current.authors) !== JSON.stringify(v.authors))
  )
    return false;
  const storedIds = await rows<{ scheme: string; value: string }>(
    db,
    sql`SELECT scheme,value FROM paper_ids WHERE paper_id=${current.id}`,
  );
  const links = await rows<{
    kind: string;
    url: string;
    licence: string | null;
    oaStatus: string;
  }>(
    db,
    sql`SELECT kind,url,licence,oa_status FROM paper_links WHERE paper_id=${current.id}`,
  );
  return (
    ids.every((i) =>
      storedIds.some((s) => s.scheme === i.scheme && s.value === i.value),
    ) &&
    v.links.every((l) =>
      links.some(
        (s) =>
          s.kind === l.kind &&
          s.url === l.url &&
          (!l.licence || s.licence === l.licence) &&
          (l.oaStatus === "unknown" || s.oaStatus === l.oaStatus),
      ),
    ) &&
    (v.venue === undefined || v.venue === current.venue) &&
    (v.venueKind === undefined || v.venueKind === current.venueKind) &&
    (v.publishedOn === undefined || v.publishedOn === current.publishedOn) &&
    (v.year === undefined || v.year === current.year)
  );
}
function identityGuard(
  found: PaperRow[],
  ids: ReturnType<typeof identifiers>,
): SQL {
  const identities = ids.length
    ? sql`NOT EXISTS(SELECT 1 FROM paper_ids i WHERE (${sql.join(
        ids.map((i) => sql`(i.scheme=${i.scheme} AND i.value=${i.value})`),
        sql` OR `,
      )}) AND i.paper_id NOT IN (${sql.join(found.length ? found.map((p) => sql`${p.id}`) : [sql`''`], sql`, `)}))`
    : sql`1`;
  const revisions = found.length
    ? sql.join(
        found.map(
          (p) => sql`(SELECT rev FROM papers WHERE id=${p.id})=${p.rev}`,
        ),
        sql` AND `,
      )
    : sql`1`;
  return sql`SELECT CASE WHEN (${identities}) AND (${revisions}) THEN 1 ELSE json('revision conflict') END`;
}
function mergedMetadata(v: Input, found: PaperRow[]): Input {
  const authors = found.reduce(
    (best, p) => (p.authors.length > best.length ? p.authors : best),
    v.authors,
  );
  const abstract = found.reduce<string | null | undefined>(
    (best, p) =>
      (p.abstract?.length ?? 0) > (best?.length ?? 0) ? p.abstract : best,
    v.abstract,
  );
  return {
    ...v,
    authors: v.authors.length ? v.authors : authors,
    abstract: v.abstract ?? abstract,
    venue: v.venue ?? found.find((p) => p.venue)?.venue ?? undefined,
    year: v.year ?? found.find((p) => p.year)?.year ?? undefined,
  };
}
function paperWrite(
  id: string,
  now: string,
  current: PaperRow | undefined,
  v: Input,
  firstDay?: string,
): SQL {
  const verified = Number(v.verified ?? current?.verified ?? true);
  return current
    ? sql`UPDATE papers SET deleted_at=NULL,verified=${verified},title=${v.title},title_norm=${titleKey(v.title)},vault_title_norm=${vaultTitleKey(v.title)},abstract=${v.abstract ?? current.abstract},authors=${JSON.stringify(v.authors.length ? v.authors : current.authors)},venue=${v.venue ?? current.venue},venue_kind=${v.venueKind ?? current.venueKind},published_on=${v.publishedOn ?? current.publishedOn},year=${v.year ?? current.year},updated_at=${now},rev=rev+1 WHERE id=${id}`
    : sql`INSERT INTO papers(id,verified,title,title_norm,vault_title_norm,abstract,authors,venue,venue_kind,published_on,year,source,created_at,updated_at,first_seen_on) VALUES (${id},${verified},${v.title},${titleKey(v.title)},${vaultTitleKey(v.title)},${v.abstract ?? null},${JSON.stringify(v.authors)},${v.venue ?? null},${v.venueKind ?? null},${v.publishedOn ?? null},${v.year ?? null},${v.source},${now},${now},${firstDay ?? null})`;
}
/** Build the same paper and children as save, for an already matched library batch. */
export function newResolvedPaperQueries(
  id: string,
  input: z.input<typeof paperInput>,
  now: string,
) {
  const paper = paperInput.parse(input);
  return [
    paperWrite(id, now, undefined, paper),
    ...childQueries(id, paper, identifiers(paper), true),
  ];
}

async function findEdition(
  db: Database,
  v: Input,
  ids: ReturnType<typeof identifiers>,
) {
  const published = ids.some((id) => id.scheme === "doi");
  if (
    !v.year ||
    !v.authors.length ||
    (!published && !ids.some((id) => id.scheme === "arxiv"))
  )
    return undefined;
  const opposite = published
    ? sql`
    EXISTS(SELECT 1 FROM paper_ids WHERE paper_id=p.id AND scheme='arxiv')
    AND NOT EXISTS(SELECT 1 FROM paper_ids WHERE paper_id=p.id AND scheme='doi')`
    : sql`EXISTS(SELECT 1 FROM paper_ids WHERE paper_id=p.id AND scheme='doi')`;
  const candidates = await rows<PaperRow>(
    db,
    sql`
    SELECT p.* FROM papers p WHERE title_norm=${titleKey(v.title)} AND year BETWEEN ${v.year - 1} AND ${v.year + 1}
      AND deleted_at IS NULL AND ${opposite} LIMIT 21`,
  );
  if (candidates.length > 20) return undefined;
  const matches = candidates.filter((p) =>
    samePaperEdition({ ...p, year: p.year ?? undefined }, v),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export async function upsertPaper(db: Database, input: unknown, ifRev: number) {
  return writePaper(
    db,
    paperInput.parse(input),
    z.number().int().nonnegative().parse(ifRev),
  );
}

export async function upsertResolvedPaper(
  db: Database,
  input: unknown,
  retained?: CompactRestore,
) {
  const value = paperInput.parse(input);
  const result = await writePaper(db, value, undefined, retained);
  return result.ok ? result : writePaper(db, value, undefined, retained);
}

/** All identity changes and reference transfers form one SQLite transaction / D1 batch. */
async function writePaper(
  db: Database,
  v: Input,
  ifRev?: number,
  retained?: CompactRestore,
): Promise<WriteResult<PaperRow> & { rowsWritten?: number }> {
  const ids = identifiers(v);
  const found = await matching(db, ids);
  if (retained) {
    // A competing restore is allowed to win. If a merge moved this identity,
    // do not resurrect its old ID.
    const restored = await getPaper(db, retained.paperId);
    if (restored) return { ok: true, value: restored };
    if (found.length) return { ok: false, conflict: found[0] ?? null };
  }
  if (v.verified === false) {
    const verified = found.find((p) => p.verified && !p.deletedAt);
    // A provider outage must not replace existing verified metadata with page claims.
    if (verified && ifRev === undefined) return { ok: true, value: verified };
  } else if (ifRev === undefined && !retained) {
    const edition = await findEdition(db, v, ids);
    const incomingPreprint =
      !ids.some((id) => id.scheme === "doi") &&
      ids.some((id) => id.scheme === "arxiv");
    const anchor =
      incomingPreprint && found.length
        ? await first<{ id: string }>(
            db,
            sql`SELECT p.id FROM paper_ids p
          WHERE p.scheme='doi' AND p.paper_id IN (${sql.join(
            found.map((p) => sql`${p.id}`),
            sql`, `,
          )})
          LIMIT 1`,
          )
        : null;
    const published =
      (anchor && found.find((p) => p.id === anchor.id && p.verified)) ??
      (incomingPreprint && edition?.verified ? edition : undefined);
    if (published)
      v = {
        ...v,
        title: published.title,
        year: published.year ?? v.year,
        venue: published.venue ?? v.venue,
        venueKind:
          (published.venueKind as Input["venueKind"] | null) ?? undefined,
        publishedOn: published.publishedOn ?? undefined,
        authors: published.authors,
      };
    if (edition && !found.some((p) => p.id === edition.id)) found.push(edition);
    found.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  const current = found[0];
  if (ifRev !== undefined && (current?.rev ?? 0) !== ifRev)
    return { ok: false, conflict: current ?? null };
  if (
    current &&
    !current.deletedAt &&
    found.length === 1 &&
    (await unchanged(db, current, v, ids))
  )
    return { ok: true, value: current };
  const id = current?.id ?? retained?.paperId ?? `pap_${ulid()}`;
  const now = new Date().toISOString();
  const guard = identityGuard(found, ids);
  const write = paperWrite(
    id,
    now,
    current,
    mergedMetadata(v, found),
    retained?.day,
  );
  let rowsWritten: number;
  try {
    rowsWritten = await atomic(db, [
      guard,
      ...(retained
        ? [
            sql`SELECT CASE WHEN EXISTS(SELECT 1 FROM paper_index
        WHERE paper_id=${id} AND has_canonical=0 AND title=${retained.title}
          AND arxiv_id IS ${retained.arxivId} AND doi IS ${retained.doi})
        AND ${retained.utcDay}=date('now')
        AND (SELECT count(DISTINCT day) FROM feed_items WHERE paper_id=${id})<=${retained.maxFeedDays}
        THEN 1 ELSE json('compact record changed') END`,
          ]
        : []),
      write,
      ...found.slice(1).flatMap((p) => mergeQueries(id, p.id)),
      ...childQueries(id, v, ids),
    ]);
  } catch (error) {
    if (
      /malformed JSON|revision conflict|UNIQUE constraint/i.test(String(error))
    )
      return { ok: false, conflict: (await matching(db, ids))[0] ?? null };
    throw error;
  }
  return {
    ok: true,
    value: (await first<PaperRow>(
      db,
      sql`SELECT * FROM papers WHERE id=${id}`,
    ))!,
    ...(retained ? { rowsWritten } : {}),
  };
}
export function getPaper(db: Database, id: string) {
  return first<PaperRow>(
    db,
    sql`SELECT * FROM papers WHERE id=${id} AND deleted_at IS NULL`,
  );
}
export function deletePaper(db: Database, id: string, ifRev: number) {
  return saveVersioned<PaperRow>(
    db,
    "papers",
    { id },
    { deleted_at: new Date().toISOString() },
    ifRev,
  );
}
export async function searchPapers(db: Database, query: string) {
  const term = z.string().trim().min(1).parse(query);
  const words = term.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return [];
  const expression = words.map((word) => '"' + word + '"').join(" AND ");
  const [full, compact] = await Promise.all([
    rows<PaperRow>(
      db,
      sql`SELECT p.* FROM paper_fts f JOIN papers p ON p.rowid=f.rowid
      WHERE paper_fts MATCH ${expression} AND p.deleted_at IS NULL ORDER BY rank LIMIT 100`,
    ),
    rows<{ id: string; title: string; venue: string | null; compact: 1 }>(
      db,
      sql`SELECT i.paper_id AS id,i.title,i.venue,1 AS compact FROM compact_paper_fts f
        JOIN paper_index i ON i.rowid=f.rowid WHERE compact_paper_fts MATCH ${expression}
        AND i.has_canonical=0 ORDER BY rank LIMIT 100`,
    ),
  ]);
  return [...full, ...compact].slice(0, 100);
}
export function getPaperIdentifiers(db: Database, paperId: string) {
  return rows<{ paperId: string; scheme: string; value: string }>(
    db,
    sql`SELECT i.* FROM paper_ids i JOIN papers p ON p.id=i.paper_id WHERE p.id=${paperId} AND p.deleted_at IS NULL ORDER BY i.scheme`,
  );
}
export function listPaperLinks(db: Database, paperId: string) {
  return rows<typeof import("./schema").paperLinks.$inferSelect>(
    db,
    sql`SELECT l.* FROM paper_links l JOIN papers p ON p.id=l.paper_id WHERE p.id=${paperId} AND p.deleted_at IS NULL ORDER BY l.kind,l.url`,
  );
}
