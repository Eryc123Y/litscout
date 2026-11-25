import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  daySchema,
  feedDayInput,
  feedItemInput,
  summaryInput,
  digestInput,
  runInput,
  snakeValues,
} from "./contracts";
import { first, rows, saveVersioned, type Database } from "./database";
import type { feedDays, feedItems, summaries, digests, runs } from "./schema";
type FeedDay = typeof feedDays.$inferSelect;
type FeedItem = typeof feedItems.$inferSelect;
type Summary = typeof summaries.$inferSelect;
type Digest = typeof digests.$inferSelect;
type Run = typeof runs.$inferSelect;
export async function putFeedDay(db: Database, input: unknown, ifRev: number) {
  const v = feedDayInput.parse(input);
  return saveVersioned<FeedDay>(
    db,
    "feed_days",
    { day: v.day },
    snakeValues(v),
    ifRev,
  );
}
export function listFeedDays(db: Database, limit = 100, before?: string) {
  return rows<FeedDay>(
    db,
    sql`SELECT * FROM feed_days ${before ? sql`WHERE day < ${daySchema.parse(before)}` : sql``} ORDER BY day DESC LIMIT ${limit}`,
  );
}
export async function putFeedItem(db: Database, input: unknown, ifRev: number) {
  const v = feedItemInput.parse(input);
  return saveVersioned<FeedItem>(
    db,
    "feed_items",
    { day: v.day, paper_id: v.paperId, source: v.source },
    snakeValues(v),
    ifRev,
  );
}
export function listFeedItems(db: Database, day: string) {
  return rows<FeedItem>(
    db,
    sql`SELECT * FROM feed_items WHERE day=${daySchema.parse(day)} ORDER BY rank_in_source, paper_id`,
  );
}
export async function putSummary(db: Database, input: unknown, ifRev: number) {
  const v = summaryInput.parse(input);
  return saveVersioned<Summary>(
    db,
    "summaries",
    { paper_id: v.paperId, lang: v.lang, kind: v.kind },
    snakeValues(v),
    ifRev,
  );
}
export function listSummaries(db: Database, paperId: string) {
  return rows<Summary>(
    db,
    sql`SELECT * FROM summaries WHERE paper_id=${paperId} ORDER BY lang`,
  );
}
export async function putDigest(db: Database, input: unknown, ifRev: number) {
  const v = digestInput.parse(input);
  return saveVersioned<Digest>(
    db,
    "digests",
    { day: v.day, lang: v.lang, kind: v.kind },
    snakeValues(v),
    ifRev,
  );
}
export function getDigest(db: Database, day: string, lang = "en") {
  return first<Digest>(
    db,
    sql`SELECT * FROM digests WHERE day=${daySchema.parse(day)} AND lang=${lang} AND kind='daily'`,
  );
}
export async function putRun(db: Database, input: unknown, ifRev: number) {
  const v = runInput.parse(input);
  const id = v.id ?? `run_${ulid()}`;
  return saveVersioned<Run>(
    db,
    "runs",
    { id },
    snakeValues({ ...v, id }),
    ifRev,
  );
}
export function listRuns(db: Database) {
  return rows<Run>(
    db,
    sql`SELECT * FROM runs ORDER BY day DESC, started_at DESC LIMIT 100`,
  );
}
