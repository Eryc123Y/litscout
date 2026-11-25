import {
  datedTrendCursor,
  feedTrendCursor,
  shiftMonth,
  type TrendPaper,
  type TrendSearchQuery,
  type TrendSourceQuery,
} from "@litscout/pipeline/trends-contracts";
import { trendTermMatcher } from "@litscout/pipeline/trends";
import type { IngestDatabase } from "./ingest-store";
import { OWNER } from "./library";

const feedPageSize = 24;
const activityPageSize = 40;

type FeedRow = {
  day: string;
  paperId: string;
  source: string;
  title: string | null;
  abstract: string | null;
  topics: string;
  shortlisted: number;
};
type TrendFeedQuery = Pick<TrendSourceQuery, "month" | "cursor">;
type PaperFields = Pick<
  FeedRow,
  "paperId" | "topics" | "abstract" | "shortlisted"
> & { title: string };
const paper = (row: PaperFields): TrendPaper => ({
  paperId: row.paperId,
  title: row.title,
  abstract: row.abstract,
  topics: JSON.parse(row.topics) as string[],
  shortlisted: Boolean(row.shortlisted),
});
const live = (row: FeedRow): row is FeedRow & { title: string } =>
  row.title !== null;

async function feedWindow(
  db: IngestDatabase,
  { month, cursor }: TrendFeedQuery,
  limit: number,
) {
  const [day, paperId, source] = cursor
    ? feedTrendCursor.parse(JSON.parse(cursor))
    : [month + "-01", "", ""];
  if (!day.startsWith(month + "-"))
    throw new SyntaxError("Cursor outside trend month");
  const result = await db
    .prepare(
      `
    WITH window AS MATERIALIZED (
      SELECT day,paper_id,source,topics,shortlisted FROM feed_items
      WHERE (day,paper_id,source)>(?,?,?) AND day<?
      ORDER BY day,paper_id,source LIMIT ?
    )
    SELECT f.day,f.paper_id AS paperId,f.source,f.topics,f.shortlisted,
      CASE WHEN p.deleted_at IS NULL THEN coalesce(p.title,i.title) END AS title,p.abstract
    FROM window f LEFT JOIN papers p ON p.id=f.paper_id
    LEFT JOIN paper_index i ON i.paper_id=f.paper_id AND p.id IS NULL AND i.has_canonical=0
    ORDER BY f.day,f.paper_id,f.source
  `,
    )
    .bind(day, paperId, source, shiftMonth(month, 1) + "-01", limit + 1)
    .all<FeedRow>();
  const scanned = result.results.slice(0, limit);
  const last = scanned.at(-1);
  return {
    scanned,
    nextCursor:
      last && result.results.length > limit
        ? JSON.stringify([last.day, last.paperId, last.source])
        : null,
  };
}

export async function searchTrendPapers(
  db: IngestDatabase,
  query: TrendSearchQuery,
) {
  // Search only on click. A stable cursor advances over scanned rows even when none match.
  const { scanned, nextCursor } = await feedWindow(db, query, 48);
  const hasTerm = trendTermMatcher(query.term);
  const matches = new Map<string, { paperId: string; title: string }>();
  for (const row of scanned.filter(live)) {
    if (matches.has(row.paperId)) continue;
    const { paperId, title, abstract, topics } = paper(row);
    if (
      topics.includes(query.topic) &&
      (hasTerm(title) || (abstract && hasTerm(abstract)))
    )
      matches.set(paperId, { paperId, title });
  }
  return { items: [...matches.values()], nextCursor };
}

const datedSources = {
  digests: {
    table: "digests",
    index: "digests_lookup_0",
    prefix: "kind=? AND",
    args: ["daily"],
    fields: `picks,(SELECT json_group_array(json_object('paperId',value->>'paperId','level',value->>'level'))
      FROM json_each(digests.radar)) AS radar`,
    limit: 1,
  },
  radar: {
    table: "radar_grades",
    index: "radar_grades_lookup_0",
    prefix: "",
    args: [],
    fields: "paper_id AS paperId,level",
    limit: activityPageSize,
  },
  events: {
    table: "events",
    index: "events_lookup_0",
    prefix: "user_id=? AND",
    args: [OWNER],
    fields:
      "CASE WHEN kind IN ('save','rate_up','rate_down','rate_clear') THEN paper_id END AS paperId,kind,at",
    limit: activityPageSize,
  },
} as const;

export async function readTrendSource(
  db: IngestDatabase,
  query: TrendSourceQuery,
) {
  if (query.kind === "papers") {
    const { scanned, nextCursor } = await feedWindow(db, query, feedPageSize);
    // The day lets a refresh count the listing days a month had.
    const items = scanned
      .filter(live)
      .map((row) => ({ ...paper(row), day: row.day }));
    return { items, nextCursor };
  }
  const start = query.month + "-01";
  const end = shiftMonth(query.month, 1) + "-01";
  const [day, rowId] = query.cursor
    ? datedTrendCursor.parse(JSON.parse(query.cursor))
    : [start, 0];
  if (!day.startsWith(query.month + "-"))
    throw new SyntaxError("Cursor outside trend month");
  const { table, index, prefix, args, fields, limit } =
    datedSources[query.kind];
  // Separate seeks use the date index for both parts of the continuation.
  // Events we do not need still take a slot, so even an all-open page is bounded.
  const select = `SELECT day,rowid AS rowId,${fields} FROM ${table} INDEXED BY ${index} WHERE ${prefix}`;
  type DatedRow = {
    day: string;
    rowId: number;
    paperId?: string | null;
    picks?: string;
    radar?: string;
    level?: string;
    kind?: string;
    at?: string;
  };
  const [same, later] = await db.batch<DatedRow>([
    db
      .prepare(`${select} day=? AND rowid>? ORDER BY rowid LIMIT ?`)
      .bind(...args, day, rowId, limit + 1),
    db
      .prepare(`${select} day>? AND day<? ORDER BY day,rowid LIMIT ?`)
      .bind(...args, day, end, limit + 1),
  ]);
  const found = [...same!.results, ...later!.results];
  const scanned = found.slice(0, limit);
  const last = scanned.at(-1);
  const items =
    query.kind === "digests"
      ? scanned.map((row) => ({
          picks: JSON.parse(row.picks ?? "[]"),
          radar: JSON.parse(row.radar ?? "[]"),
        }))
      : scanned.flatMap(({ paperId, level, kind, at }) =>
          paperId
            ? [
                query.kind === "events"
                  ? { paperId, kind, at }
                  : { paperId, level },
              ]
            : [],
        );
  return {
    items,
    nextCursor:
      last && found.length > limit
        ? JSON.stringify([last.day, last.rowId])
        : null,
  };
}

export async function trendReferences(db: IngestDatabase, ids: string[]) {
  const { results } = await db
    .prepare(
      `
    SELECT p.id AS paperId,p.title,p.abstract,coalesce(i.topics,(
      SELECT f.topics FROM feed_items f WHERE f.day=p.first_seen_on AND f.paper_id=p.id
      ORDER BY f.source LIMIT 1
    ),'[]') AS topics,0 AS shortlisted
    FROM papers p LEFT JOIN paper_index i ON i.paper_id=p.id
    WHERE p.id IN (SELECT value FROM json_each(?1)) AND p.deleted_at IS NULL
    UNION ALL SELECT i.paper_id,i.title,NULL,i.topics,0
    FROM json_each(?1) wanted CROSS JOIN paper_index i ON i.paper_id=wanted.value WHERE i.has_canonical=0
  `,
    )
    .bind(JSON.stringify([...new Set(ids)]))
    .all<PaperFields>();
  return results.map(paper);
}

export async function trendWindow(db: IngestDatabase) {
  const { results } = await db
    .prepare(
      `
    SELECT min(day) AS day FROM (
      SELECT min(day) AS day FROM feed_days
      UNION ALL SELECT min(day) FROM digests WHERE kind='daily'
      UNION ALL SELECT min(day) FROM radar_grades
      UNION ALL SELECT min(day) FROM events WHERE user_id=?
    )
  `,
    )
    .bind(OWNER)
    .all<{ day: string | null }>();
  return { oldestMonth: results[0]?.day?.slice(0, 7) ?? null };
}
