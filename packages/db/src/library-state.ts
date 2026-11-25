import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { z } from "zod";
import type {
  eventKind,
  stateQuery,
  StatePage,
  ReadingState,
} from "@litscout/pipeline/library-contracts";
import { atomic, rows, type Database } from "./database";
import { OWNER, livePaper } from "./library";

export async function readState(
  db: Database,
  q: z.output<typeof stateQuery>,
): Promise<StatePage> {
  const selection = q.paperId
    ? sql`p.id=${q.paperId}`
    : sql`p.id IN (
    SELECT paper_id FROM feed_items WHERE day=${q.day}
    UNION SELECT paper_id FROM events WHERE user_id=${OWNER} AND day=${q.day})`;
  const found = await rows<ReadingState>(
    db,
    sql`
    SELECT p.id AS paper_id,s.read_at,coalesce(s.starred,0) AS starred,
      coalesce(s.read_later,0) AS read_later,coalesce(s.rating,'none') AS rating,l.rev AS library_rev,
      l.status AS library_status,s.skipped_at
    FROM papers p
    LEFT JOIN paper_state s ON s.paper_id=p.id AND s.user_id=${OWNER} AND s.deleted_at IS NULL
    LEFT JOIN library_items l ON l.paper_id=p.id AND l.user_id=${OWNER} AND l.deleted_at IS NULL
    WHERE ${selection} AND p.deleted_at IS NULL AND p.id>${q.after ?? ""}
    ORDER BY p.id LIMIT ${q.limit + 1}`,
  );
  const items = found.slice(0, q.limit);
  return {
    items,
    nextCursor: found.length > q.limit ? items.at(-1)!.paperId : null,
  };
}

export async function recordEvent(
  db: Database,
  paperId: string,
  kind: z.output<typeof eventKind>,
  day: string,
  now: string,
  source: string,
) {
  const id = `evt_${ulid()}`;
  const isRead = kind === "open";
  // 1 skips, 0 takes the skip back, null leaves it as it is.
  const skip = kind === "skip" ? 1 : kind === "unskip" ? 0 : null;
  const starred = kind === "star" ? 1 : kind === "unstar" ? 0 : null;
  const rating =
    kind === "rate_up"
      ? "up"
      : kind === "rate_down"
        ? "down"
        : kind === "rate_clear"
          ? "none"
          : null;
  // A retry or a double click must not repeat an event: an open counts once
  // a day, and a star or rating only when it changes the state.
  const current = (column: "starred" | "rating", fallback: number | string) =>
    sql`coalesce((SELECT ${sql.raw(column)} FROM paper_state
      WHERE user_id=${OWNER} AND paper_id=${paperId} AND deleted_at IS NULL),${fallback})`;
  const changes = isRead
    ? sql`(NOT EXISTS(SELECT 1 FROM events WHERE user_id=${OWNER}
        AND paper_id=${paperId} AND kind='open' AND day=${day})
      OR NOT EXISTS(SELECT 1 FROM paper_state WHERE user_id=${OWNER}
        AND paper_id=${paperId} AND deleted_at IS NULL AND read_at IS NOT NULL))`
    : starred !== null
      ? sql`${current("starred", 0)}<>${starred}`
      : rating !== null
        ? sql`${current("rating", "none")}<>${rating}`
        : skip !== null
          ? // A paper the reader saved or started is kept, not skipped.
            sql`(SELECT count(*) FROM paper_state WHERE user_id=${OWNER}
              AND paper_id=${paperId} AND deleted_at IS NULL AND skipped_at IS NOT NULL)<>${skip}
            AND (${skip}=0 OR NOT EXISTS(SELECT 1 FROM library_items WHERE user_id=${OWNER}
              AND paper_id=${paperId} AND deleted_at IS NULL AND status<>'to_read'))`
          : sql`1=1`;
  const event = sql`INSERT INTO events(id,user_id,paper_id,kind,day,source,at)
    SELECT ${id},${OWNER},${paperId},${kind},${day},${source},${now}
    WHERE ${livePaper(paperId)} AND ${changes}`;
  await atomic(db, [
    event,
    ...(isRead || starred !== null || rating !== null || skip !== null
      ? [
          sql`INSERT INTO paper_state(user_id,paper_id,read_at,starred,rating,skipped_at,updated_at)
        SELECT ${OWNER},${paperId},${isRead ? now : null},${starred ?? 0},${rating ?? "none"},${skip ? now : null},${now}
        WHERE EXISTS(SELECT 1 FROM events WHERE id=${id})
        ON CONFLICT(user_id,paper_id) DO UPDATE SET
          read_at=coalesce(excluded.read_at,paper_state.read_at),
          starred=coalesce(${starred},paper_state.starred),
          rating=coalesce(${rating},paper_state.rating),
          skipped_at=CASE ${skip} WHEN 1 THEN excluded.skipped_at WHEN 0 THEN NULL ELSE paper_state.skipped_at END,
          deleted_at=NULL,updated_at=excluded.updated_at,rev=paper_state.rev+1`,
        ]
      : []),
    // A skipped paper no longer waits in To read. Entries the reader saved
    // or started stay: skipping only hides the paper from the day's list.
    ...(skip === 1
      ? [
          sql`UPDATE library_items SET deleted_at=${now},updated_at=${now},rev=rev+1
        WHERE user_id=${OWNER} AND paper_id=${paperId} AND deleted_at IS NULL
          AND status='to_read' AND EXISTS(SELECT 1 FROM events WHERE id=${id})`,
        ]
      : []),
  ]);
  return (await readState(db, { paperId, limit: 1 })).items[0] ?? null;
}
