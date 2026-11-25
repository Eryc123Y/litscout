import type { DayStatus } from "@litscout/pipeline/status";
import type { IngestDatabase } from "./ingest-store";

const reopenedStatus = `CASE WHEN EXISTS (SELECT 1 FROM feed_items WHERE day=?)
  THEN 'crawled' ELSE 'pending' END`;
const dailyDigest = "day=? AND kind='daily'";
type Snapshot = {
  oldStatus: DayStatus | null;
  reopenedStatus: "pending" | "crawled";
  languages: string;
};

export async function reopenDay(
  db: IngestDatabase,
  day: string,
  dryRun: boolean,
) {
  const snapshot = db
    .prepare(
      `SELECT (SELECT status FROM feed_days WHERE day=?) AS oldStatus,
        ${reopenedStatus} AS reopenedStatus,
        (SELECT json_group_array(lang ORDER BY lang) FROM digests
          WHERE ${dailyDigest}) AS languages`,
    )
    .bind(day, day, day);
  let row: Snapshot | null;
  let rowsWritten = 0;
  if (dryRun) {
    row = await snapshot.first<Snapshot>();
  } else {
    // Read the plan before either mutation and keep all three statements atomic.
    // A digest can predate its feed-day row, so recover that date too.
    const results = await db.batch<Snapshot>([
      snapshot,
      db
        .prepare(
          `INSERT INTO feed_days(day,status)
          SELECT ?, ${reopenedStatus}
          WHERE EXISTS (SELECT 1 FROM digests WHERE ${dailyDigest})
             OR EXISTS (SELECT 1 FROM feed_days WHERE day=? AND status IN ('digested','final'))
          ON CONFLICT(day) DO UPDATE SET status=excluded.status, rev=feed_days.rev+1`,
        )
        .bind(day, day, day, day),
      db.prepare(`DELETE FROM digests WHERE ${dailyDigest}`).bind(day),
    ]);
    row = results[0]?.results[0] ?? null;
    rowsWritten = results.reduce(
      (total, result) => total + result.meta.rows_written,
      0,
    );
  }
  if (!row) throw new Error("Missing day reopen snapshot");
  const { oldStatus } = row;
  const digests = (JSON.parse(row.languages) as string[]).map((lang) => ({
    lang,
  }));
  const changed =
    oldStatus === "digested" || oldStatus === "final" || digests.length > 0;
  return {
    plan: {
      day,
      dryRun,
      changed,
      oldStatus,
      newStatus: changed ? row.reopenedStatus : oldStatus,
      digests,
    },
    rowsWritten,
  };
}
