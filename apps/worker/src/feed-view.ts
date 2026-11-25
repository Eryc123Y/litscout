import { readDayCounts } from "@litscout/db/bounded-read";
import type { WebDay } from "@litscout/pipeline/web-contracts";
import { readFeedDay } from "@litscout/db/feed-read";
import { listingCursorSchema } from "@litscout/pipeline/contracts/limits";
listingCursorSchema.parse({
  listingDate: "2000-01-01",
  runDay: "2000-01-01",
  noAnnouncement: ["2000-01-01"],
});
/** Only the public announcement dates leave this operational cursor. */
async function noAnnouncementDays(db: D1Database) {
  const row = await db
    .prepare("SELECT value FROM sync_cursors WHERE name='arxiv-listing'")
    .first<{ value: string }>();
  if (!row) return [];
  try {
    const parsed = listingCursorSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? (parsed.data.noAnnouncement ?? []) : [];
  } catch {
    return [];
  }
}
export async function viewFeedDay(
  db: D1Database,
  day: string,
  filters: unknown = {},
  isPublic = false,
  keywordOnly = false,
  topVenues: readonly string[] = [],
) {
  const [feed, empty] = await Promise.all([
    readFeedDay(
      db,
      day,
      filters,
      isPublic,
      keywordOnly ? "keywords" : false,
      false,
      topVenues,
    ),
    noAnnouncementDays(db),
  ]);
  return feed.status === "pending" && empty.includes(day)
    ? { ...feed, status: "empty" as const }
    : feed;
}
export async function viewFeedDays(
  db: D1Database,
  limit = 30,
  before?: string,
  countsLimit = limit,
) {
  const [days, empty] = await Promise.all([
    db
      .prepare(
        `SELECT day,status FROM feed_days ${before ? "WHERE day < ?" : ""} ORDER BY day DESC LIMIT ?`,
      )
      .bind(...(before ? [before] : []), limit)
      .all<Pick<WebDay, "day" | "status">>()
      .then((r) => r.results),
    noAnnouncementDays(db),
  ]);
  const counts = await storedCounts(
    db,
    days.slice(0, countsLimit).map((d) => d.day),
  );
  const listed = days.map((d) => ({
    ...d,
    counts: counts.get(d.day) ?? { total: 0, sources: {} },
  }));
  if (!empty.length) return listed;
  const existing = new Set(days.map((d) => d.day));
  const extra = empty.filter(
    (day) => !existing.has(day) && (!before || day < before),
  );
  if (!extra.length) return listed;
  return listed
    .concat(
      extra.map((day) => ({
        day,
        status: "empty" as const,
        counts: { total: 0, sources: {} },
      })),
    )
    .sort((a, b) => (a.day > b.day ? -1 : a.day < b.day ? 1 : 0))
    .slice(0, limit);
}

async function storedCounts(db: D1Database, days: string[]) {
  const counts = new Map<string, WebDay["counts"]>();
  if (!days.length) return counts;
  const result = await db
    .prepare(
      `SELECT day,kind,key,n FROM feed_read_counts WHERE kind IN ('total','sources','shortlisted') AND day IN (${days.map(() => "?").join(",")}) AND n>0`,
    )
    .bind(...days)
    .all<{ day: string; kind: string; key: string; n: number }>();
  for (const row of result.results) {
    let value = counts.get(row.day);
    if (!value) {
      value = { total: 0, sources: {} };
      counts.set(row.day, value);
    }
    if (row.kind === "total") value.total = row.n;
    else if (row.kind === "shortlisted") value.shortlisted = row.n;
    else
      Object.defineProperty(value.sources, row.key, {
        value: row.n,
        enumerable: true,
      });
  }
  return counts;
}

/** One extra stored/announcement day tells the UI whether an older page exists. */
export async function viewFeedDaysPage(
  db: D1Database,
  limit = 30,
  before?: string,
) {
  const rows = await viewFeedDays(db, limit + 1, before, limit);
  const items = rows.slice(0, limit);
  return { items, nextBefore: rows.length > limit ? items.at(-1)!.day : null };
}

/** For each day, how many of its papers on the reader's topics the owner
 * has opened. One indexed pass over those days' matched rows. */
export async function readCountsByDay(db: D1Database, days: string[]) {
  const counts = new Map<string, number>();
  if (!days.length) return counts;
  const { results } = await db
    .prepare(
      `SELECT f.day,count(DISTINCT f.paper_id) AS n FROM feed_items f
       JOIN paper_state s ON s.paper_id=f.paper_id AND s.user_id='u_owner'
         AND s.deleted_at IS NULL AND s.read_at IS NOT NULL
       WHERE f.shortlisted=1 AND f.day IN (${days.map(() => "?").join(",")})
       GROUP BY f.day`,
    )
    .bind(...days)
    .all<{ day: string; n: number }>();
  for (const row of results) counts.set(row.day, row.n);
  return counts;
}
/** The private Days page: each listed day also says how many of its
 * matched papers have been read. */
export async function viewPrivateFeedDaysPage(
  db: D1Database,
  limit = 30,
  before?: string,
) {
  const page = await viewFeedDaysPage(db, limit, before);
  const read = await readCountsByDay(
    db,
    page.items.filter((d) => d.counts.shortlisted).map((d) => d.day),
  );
  return {
    ...page,
    items: page.items.map((d) =>
      d.counts.shortlisted
        ? { ...d, counts: { ...d.counts, read: read.get(d.day) ?? 0 } }
        : d,
    ),
  };
}

export async function viewFeedCounts(db: D1Database, day: string) {
  const [stored, record, empty] = await Promise.all([
    readDayCounts(db, day),
    db
      .prepare("SELECT status FROM feed_days WHERE day=?")
      .bind(day)
      .first<{ status: WebDay["status"] }>(),
    noAnnouncementDays(db),
  ]);
  return {
    day,
    status:
      (!record || record.status === "pending") && empty.includes(day)
        ? ("empty" as const)
        : (record?.status ?? ("pending" as const)),
    counts: stored.counts,
  };
}
