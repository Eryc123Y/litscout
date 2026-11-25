import { pruneStatusQuery } from "@litscout/db/retention";
import { Hono } from "hono";
import { z } from "zod";
import { onTimeBySchema } from "@litscout/core/config";
import { listingCursorSchema } from "@litscout/pipeline/contracts/limits";
import { shiftDay } from "@litscout/pipeline/daily";
import {
  cutoverWeekdays,
  dailyRunInputSchema,
  dailyRunPath,
  dailyRunReservation,
  healthPath,
  legacyRunPrefix,
  type HealthStatus,
} from "@litscout/pipeline/health-contracts";
import {
  cutoverDailyRuns,
  dailyRunCutoff,
  dailyRunView,
  deleteExpiredDailyRuns,
  firstDailyRun,
  hasExpiredDailyRuns,
  recentDailyRuns,
  recordDailyRun,
  type StoredDailyRun,
} from "@litscout/db/daily-runs";
import {
  nextReset,
  reserveWriteBudget,
  settleWriteBudget,
  writeBudgetUsageQuery,
  type WriteBudgetUsage,
} from "@litscout/db/write-budget";
import { completedMirror } from "@litscout/db/alphaxiv";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { unavailable } from "./diagnostics";
import { userDay } from "./instance-day";
import { instanceInfo } from "./public-feed";
import {
  parseServerStatus,
  runtimeOf,
  serverStatusCursor,
} from "./server-status";

export const healthApi = new Hono<WorkerBindings>();

export async function expireDailyRuns(db: D1Database, now: Date) {
  const cutoff = dailyRunCutoff(now);
  if (!(await hasExpiredDailyRuns(db, cutoff))) return;
  const lease = await reserveWriteBudget(db, dailyRunReservation, now);
  if (!lease) return;
  let written: number | undefined;
  try {
    written = (await deleteExpiredDailyRuns(db, cutoff).run()).meta
      .rows_written;
  } finally {
    await settleWriteBudget(db, lease, written ?? 0, written === undefined);
  }
}

healthApi.post(dailyRunPath, async (c) => {
  if (!c.env.DB) return unavailable("Daily run: DB binding missing");
  const now = new Date();
  const cutoff = dailyRunCutoff(now);
  const allowedUntil = new Date(now.getTime() + 300_000).toISOString();
  const run = dailyRunInputSchema
    .refine(
      (value) =>
        value.startedAt >= cutoff &&
        ("finishedAt" in value ? value.finishedAt : value.startedAt) <=
          allowedUntil,
      "Run timestamp outside the reporting window",
    )
    .parse(c.get("ingestBody"));
  const rowsWritten = await recordDailyRun(
    c.env.DB,
    run,
    userDay(c.env, new Date(run.startedAt)),
    cutoff,
  );
  c.header("Cache-Control", "no-store");
  return apiJson(c, {
    success: true,
    data: { id: run.id },
    meta: { rowsWritten },
  });
});

const LINK_CAP = 200;
type ReadingDay = {
  day: string;
  status: string | null;
  arxiv: number;
  feedItems: number;
  summaries: number;
  digestAt: string | null;
  reported: 0 | 1;
  imported: 0 | 1;
};
type DayContext = {
  noListing: ReadonlySet<string>;
  firstRunDay: string | null;
  localClock: Intl.DateTimeFormat;
  onTimeBy: string;
};

function classify(
  row: ReadingDay,
  { noListing, firstRunDay, localClock, onTimeBy }: DayContext,
): HealthStatus {
  if (
    !row.arxiv &&
    (noListing.has(row.day) ||
      row.status === "empty" ||
      [0, 6].includes(new Date(row.day).getUTCDay()))
  )
    return "no-listing";
  // The legacy import brings the old pipeline's digest, often without the
  // day's listing counts. LitScout did not run that day, so it is no miss.
  if (row.imported && row.digestAt && !row.reported) return "imported";
  if (firstRunDay === null || row.day < firstRunDay) return "before-start";
  if (!row.arxiv || !row.digestAt) return "missed";
  const value = localClock.formatToParts(new Date(row.digestAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    value.find((entry) => entry.type === type)?.value;
  const localDay = `${part("year")}-${part("month")}-${part("day")}`;
  const localTime = `${part("hour")}:${part("minute")}`;
  return localDay === row.day && localTime <= onTimeBy ? "on-time" : "late";
}

/** LitScout's start: its earliest run report, or an earlier digest it wrote
 * (not one the legacy import brought), since run reports came later. */
function firstLitScoutDay(firstRun: string | undefined, rows: ReadingDay[]) {
  const firstDigest = rows.find((row) => row.digestAt && !row.imported)?.day;
  const days = [firstRun, firstDigest].filter(
    (day): day is string => typeof day === "string",
  );
  return days.length ? days.sort()[0]! : null;
}

function announcedGaps(value: string | undefined) {
  if (value === undefined) return new Set<string>();
  try {
    const cursor = listingCursorSchema.safeParse(JSON.parse(value));
    return new Set(cursor.success ? cursor.data.noAnnouncement : []);
  } catch {
    return new Set<string>();
  }
}

const cutoverDaysSchema = z
  .string()
  .length(cutoverWeekdays * 11 - 1)
  .transform((value) => value.split(","))
  .pipe(z.array(z.iso.date()).length(cutoverWeekdays))
  .refine((days) => new Set(days).size === days.length);

healthApi.get(healthPath, async (c) => {
  const db = c.env.DB;
  if (!db) return unavailable("Health page: DB binding missing");
  const now = new Date();
  const cutoverDays = c.req.query("cutoverDays");
  if (cutoverDays !== undefined) {
    const days = cutoverDaysSchema.parse(cutoverDays);
    const evidence = await cutoverDailyRuns(db, days, dailyRunCutoff(now));
    c.header("Cache-Control", "no-store");
    return apiJson(c, { success: true, data: evidence });
  }
  const today = userDay(c.env, now);
  const day = now.toISOString().slice(0, 10);
  const days = Array.from({ length: 30 }, (_, index) =>
    shiftDay(today, index - 30),
  );
  const timezone = instanceInfo(c.env).timezone;
  const onTimeBy = onTimeBySchema.catch("11:30").parse(c.env.HEALTH_ON_TIME_BY);
  const localClock = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const [calendar, recent, budget, vault, links, cursors, pruning, first] =
    await db.batch([
      db
        .prepare(
          `
      SELECT d.value AS day, f.status,
        max(coalesce(a.n,0),coalesce(json_extract(f.counts,'$.sources.arxiv'),json_extract(f.counts,'$.arxiv'),0)) AS arxiv,
        coalesce(t.n,0) AS feedItems, coalesce(s.n,0) AS summaries,
        (SELECT min(created_at) FROM digests WHERE day=d.value AND kind='daily' AND lang IN ('en','zh')) AS digestAt,
        EXISTS(SELECT 1 FROM daily_runs WHERE run_day=d.value AND finished_at IS NOT NULL) AS reported,
        EXISTS(SELECT 1 FROM runs WHERE day=d.value AND kind='digest' AND id GLOB ?) AS imported
      FROM json_each(?) d
      LEFT JOIN feed_days f ON f.day=d.value
      LEFT JOIN feed_read_counts a ON a.day=d.value AND a.kind='sources' AND a.key='arxiv'
      LEFT JOIN feed_read_counts t ON t.day=d.value AND t.kind='total' AND t.key=''
      LEFT JOIN feed_read_counts s ON s.day=d.value AND s.kind='summarised' AND s.key=''
    `,
        )
        .bind(legacyRunPrefix + "*", JSON.stringify(days)),
      recentDailyRuns(db, dailyRunCutoff(now)),
      writeBudgetUsageQuery(db, day),
      db.prepare("SELECT note_count AS notes FROM vault_sync WHERE id=1"),
      db.prepare(
        `SELECT id FROM paper_links WHERE user_id='u_owner' AND checked_at IS NULL ORDER BY id LIMIT ${LINK_CAP + 1}`,
      ),
      db
        .prepare(
          "SELECT name,value,updated_at FROM sync_cursors WHERE name IN ('arxiv-listing','alphaxiv:active',?,?)",
        )
        .bind(completedMirror, serverStatusCursor),
      pruneStatusQuery(db),
      firstDailyRun(db),
    ]);
  const rows = (calendar!.results as ReadingDay[]).sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  const mirrors = cursors!.results as {
    name: string;
    value: string;
    updated_at: string;
  }[];
  const cursor = (name: string) => mirrors.find((row) => row.name === name);
  const context: DayContext = {
    noListing: announcedGaps(cursor("arxiv-listing")?.value),
    firstRunDay: firstLitScoutDay(
      (first!.results[0] as { day: string } | undefined)?.day,
      rows,
    ),
    localClock,
    onTimeBy,
  };
  const usage = budget!.results[0] as WriteBudgetUsage;
  const vaultCount = vault!.results[0] as { notes: number } | undefined;
  const readCounts = [
    calendar!,
    recent!,
    budget!,
    vault!,
    links!,
    cursors!,
    pruning!,
    first!,
  ].map(({ meta }) => meta.rows_read);
  const size = calendar!.meta.size_after;
  c.header("Cache-Control", "no-store");
  return apiJson(c, {
    success: true,
    data: {
      timezone,
      onTimeBy,
      runtime: runtimeOf(c.env),
      server: parseServerStatus(cursor(serverStatusCursor)?.value),
      firstRunDay: context.firstRunDay,
      days: rows.map((row) => {
        const status = classify(row, context);
        return {
          day: row.day,
          status,
          reported: Boolean(row.reported),
          digestAt: row.arxiv || status === "imported" ? row.digestAt : null,
        };
      }),
      runs: (recent!.results as StoredDailyRun[]).map(dailyRunView),
      budget: {
        ...usage,
        resetAt: nextReset(day),
        rowsRead: readCounts.every(Number.isFinite)
          ? readCounts.reduce((sum, value) => sum + value, 0)
          : null,
      },
      storage: {
        sizeBytes: size > 0 ? size : null,
        feedItems: rows.reduce((sum, row) => sum + row.feedItems, 0),
        summaries: rows.reduce((sum, row) => sum + row.summaries, 0),
        vaultNotes: vaultCount?.notes ?? 0,
      },
      pruning: pruning!.results[0] ?? null,
      links: {
        unchecked: Math.min(LINK_CAP, links!.results.length),
        capped: links!.results.length > LINK_CAP,
      },
      mirror: {
        activeAt: cursor("alphaxiv:active")?.updated_at ?? null,
        completedAt: cursor(completedMirror)?.updated_at ?? null,
      },
    },
  });
});
