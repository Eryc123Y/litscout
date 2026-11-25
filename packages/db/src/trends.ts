import {
  shiftMonth,
  trendsPaperPageSize,
  type TrendComparison,
  type TrendRow,
  type TrendsQuery,
  type TrendsResponse,
} from "@litscout/pipeline/trends-contracts";
import {
  upsertStatement,
  writeBatch,
  type IngestDatabase,
} from "./ingest-store";

export function putTrends(db: IngestDatabase, trends: TrendRow[]) {
  return writeBatch(
    db,
    trends.map((row) =>
      upsertStatement(db, "monthly_trends", ["topic", "month"], {
        topic: row.topic,
        month: row.month,
        volume: row.volume,
        shortlisted: row.shortlisted,
        pick_count: row.picks.length,
        radar_hits: row.radar.high + row.radar.medium + row.radar.borrow,
        radar: row.radar,
        save_count: row.activity.filter((paper) => paper.saved).length,
        rating_count: row.activity.filter((paper) => paper.rating).length,
        activity_count: row.activity.length,
        recurring: row.recurring,
        // No migration: the comparison is stored with the rising terms.
        rising: row.comparison
          ? { terms: row.rising, comparison: row.comparison }
          : row.rising,
        picks: row.picks,
        activity: row.activity,
      }),
    ),
  );
}

type History = TrendsResponse["history"];

/** Rising terms are an array on older rows, or terms with their comparison. */
function storedRising(value: string): Pick<Detail, "rising" | "comparison"> {
  const parsed = JSON.parse(value) as
    Detail["rising"] | { terms: Detail["rising"]; comparison: TrendComparison };
  return Array.isArray(parsed)
    ? { rising: parsed }
    : { rising: parsed.terms, comparison: parsed.comparison };
}
type Detail = NonNullable<TrendsResponse["detail"]>;
type StorageDetail = Omit<
  Pick<
    Detail,
    | "volume"
    | "shortlisted"
    | "radar"
    | "recurring"
    | "rising"
    | "pickCount"
    | "saveCount"
    | "ratingCount"
  >,
  "radar" | "recurring" | "rising"
> & {
  radar: string;
  recurring: string;
  rising: string;
  activityCount: number;
};
type ResultPaper = {
  kind: "pick" | "activity";
  paperId: string;
  title: string | null;
  saved: number | null;
  rating: "up" | "down" | null;
};

export async function readTrends(
  db: IngestDatabase,
  { topic, month, pickOffset = 0, activityOffset = 0 }: TrendsQuery,
  currentMonth: string,
  defaultTopic?: string,
): Promise<TrendsResponse> {
  const selectedTopic = topic ?? defaultTopic ?? null;
  const selectedMonth = month ?? currentMonth;
  const response = { topic: selectedTopic, month: selectedMonth, currentMonth };
  if (!selectedTopic) return { ...response, history: [], detail: null };
  const [history, selected, papers] = await db.batch([
    db
      .prepare(
        `
      SELECT month,volume,pick_count AS picks,radar_hits AS radarHits
      FROM monthly_trends WHERE topic=? AND month BETWEEN ? AND ?
      ORDER BY month
    `,
      )
      .bind(selectedTopic, shiftMonth(currentMonth, -11), currentMonth),
    db
      .prepare(
        `
      SELECT volume,shortlisted,pick_count AS pickCount,save_count AS saveCount,
        rating_count AS ratingCount,activity_count AS activityCount,radar,recurring,rising
      FROM monthly_trends WHERE topic=? AND month=?
    `,
      )
      .bind(selectedTopic, selectedMonth),
    db
      .prepare(
        `
      WITH RECURSIVE slot(n) AS (
        VALUES(0) UNION ALL SELECT n+1 FROM slot WHERE n+1<?
      ), selected AS MATERIALIZED (
        SELECT picks, activity, pick_count, activity_count FROM monthly_trends
        WHERE topic=? AND month=?
      ), refs AS MATERIALIZED (
        SELECT 'pick' AS kind,n,json_extract(picks,printf('$[%d]',n+?)) AS paperId,
          NULL AS saved,NULL AS rating
        FROM selected CROSS JOIN slot WHERE n+?<pick_count
        UNION ALL
        SELECT 'activity',n,json_extract(activity,printf('$[%d].paperId',n+?)),
          json_extract(activity,printf('$[%d].saved',n+?)),
          json_extract(activity,printf('$[%d].rating',n+?))
        FROM selected CROSS JOIN slot WHERE n+?<activity_count
      )
      SELECT refs.kind,refs.paperId,refs.saved,refs.rating,p.title
      FROM refs LEFT JOIN papers p ON p.id=refs.paperId AND p.deleted_at IS NULL
      ORDER BY refs.kind,refs.n
    `,
      )
      .bind(
        trendsPaperPageSize,
        selectedTopic,
        selectedMonth,
        pickOffset,
        pickOffset,
        activityOffset,
        activityOffset,
        activityOffset,
        activityOffset,
      ),
  ]);
  const months = history!.results as History;
  const data = selected!.results[0] as StorageDetail | undefined;
  if (!data) return { ...response, history: months, detail: null };
  const { radar, recurring, rising, activityCount, ...metrics } = data;
  const picks: Detail["picks"] = [],
    activity: Detail["activity"] = [];
  for (const { kind, paperId, title, saved, rating } of papers!
    .results as ResultPaper[])
    if (kind === "pick") picks.push({ paperId, title });
    else activity.push({ paperId, title, saved: Boolean(saved), rating });
  const next = (start: number, total: number) =>
    start + trendsPaperPageSize < total ? start + trendsPaperPageSize : null;
  return {
    ...response,
    history: months,
    detail: {
      ...metrics,
      month: selectedMonth,
      picks,
      activity,
      radar: JSON.parse(radar),
      recurring: JSON.parse(recurring),
      ...storedRising(rising),
      nextPickOffset: next(pickOffset, data.pickCount),
      nextActivityOffset: next(activityOffset, activityCount),
    },
  };
}
