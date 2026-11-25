import {
  dailyRunPruneLimit,
  type DailyRunInput,
  type DailyRunView,
} from "@litscout/pipeline/health-contracts";
import type { IngestDatabase } from "./ingest-store";

export const dailyRunCutoff = (now: Date) =>
  new Date(now.getTime() - 90 * 86_400_000).toISOString();

export const hasExpiredDailyRuns = (db: IngestDatabase, cutoff: string) =>
  db
    .prepare("SELECT 1 FROM daily_runs WHERE started_at<? LIMIT 1")
    .bind(cutoff)
    .first();

export const deleteExpiredDailyRuns = (db: IngestDatabase, cutoff: string) =>
  db
    .prepare(
      `
    DELETE FROM daily_runs WHERE id IN (
      SELECT id FROM daily_runs WHERE started_at<? ORDER BY started_at,id LIMIT ${dailyRunPruneLimit}
    )
  `,
    )
    .bind(cutoff);

export async function recordDailyRun(
  db: IngestDatabase,
  input: DailyRunInput,
  runDay: string,
  cutoff: string,
) {
  const finished = "finishedAt" in input ? input : null;
  const results = await db.batch([
    db
      .prepare(
        `
      INSERT INTO daily_runs (id,run_day,started_at,target_day,finished_at,steps,rows_written)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        target_day=excluded.target_day, finished_at=excluded.finished_at,
        steps=excluded.steps, rows_written=excluded.rows_written
      WHERE daily_runs.started_at=excluded.started_at
        AND daily_runs.finished_at IS NULL AND excluded.finished_at IS NOT NULL
    `,
      )
      .bind(
        input.id,
        runDay,
        input.startedAt,
        input.targetDay,
        finished?.finishedAt ?? null,
        finished ? JSON.stringify(finished.steps) : null,
        finished?.rowsWritten ?? null,
      ),
    deleteExpiredDailyRuns(db, cutoff),
  ]);
  return results.reduce((sum, result) => sum + result.meta.rows_written, 0);
}

/** LitScout's first daily run: the local day of the earliest one kept. */
export const firstDailyRun = (db: IngestDatabase) =>
  db.prepare(
    "SELECT run_day AS day FROM daily_runs ORDER BY started_at,id LIMIT 1",
  );

export const recentDailyRuns = (db: IngestDatabase, cutoff: string) =>
  db
    .prepare(
      `
    SELECT id,started_at AS startedAt,target_day AS targetDay,
      finished_at AS finishedAt,steps,rows_written AS rowsWritten
    FROM daily_runs WHERE started_at>=? ORDER BY started_at DESC,id DESC LIMIT 12
  `,
    )
    .bind(cutoff);

export async function cutoverDailyRuns(
  db: IngestDatabase,
  days: readonly string[],
  cutoff: string,
) {
  // Choose the first completed digest run on each local date. If it is
  // missing, show the latest completed report or the latest open attempt.
  const [presence, selected] = await db.batch([
    db
      .prepare("SELECT 1 FROM daily_runs WHERE started_at>=? LIMIT 1")
      .bind(cutoff),
    db
      .prepare(
        `
      SELECT d.value AS day, r.id, r.started_at AS startedAt, r.target_day AS targetDay,
        r.finished_at AS finishedAt, r.steps, r.rows_written AS rowsWritten,
        (SELECT min(created_at) FROM digests
         WHERE day=r.target_day AND kind='daily' AND lang IN ('en','zh')) AS digestAt
      FROM json_each(?) d
      JOIN daily_runs r ON r.id=(
        SELECT id FROM daily_runs
        WHERE run_day=d.value AND started_at>=?
          AND started_at>=date(d.value,'-1 day') AND started_at<date(d.value,'+2 days')
        ORDER BY
          CASE
            WHEN json_extract(steps,'$.digest.status')='done' THEN 0
            WHEN finished_at IS NOT NULL THEN 1
            ELSE 2
          END,
          CASE WHEN json_extract(steps,'$.digest.status')='done' THEN finished_at END,
          started_at DESC, id DESC
        LIMIT 1
      )
      ORDER BY d.key
    `,
      )
      .bind(JSON.stringify(days), cutoff),
  ]);
  return {
    hasRuns: presence!.results.length > 0,
    runs: (
      selected!.results as (StoredDailyRun & {
        day: string;
        digestAt: string | null;
      })[]
    ).map(({ day, digestAt, ...run }) => ({
      day,
      digestAt,
      run: dailyRunView(run),
    })),
  };
}

export type StoredDailyRun = Omit<DailyRunView, "steps"> & {
  steps: string | null;
};

export function dailyRunView(run: StoredDailyRun): DailyRunView {
  return { ...run, steps: run.steps ? JSON.parse(run.steps) : null };
}
