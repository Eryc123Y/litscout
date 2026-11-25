import { digestSuggestionLimit } from "@litscout/core/ingest-limits";
import {
  schemas,
  digestRecordSchema,
} from "@litscout/pipeline/contracts/index";
import { nextStatus, type DayStatus } from "@litscout/pipeline/status";
import {
  stableId,
  upsertStatement,
  writeBatch,
  type IngestDatabase,
} from "./ingest-store";

// The first summary triggers one counter update per feed day, even if a
// paper has several sources on the same day or several summaries in the batch.
const summaryCounters = `SELECT count(*) AS n FROM (
  SELECT f.paper_id,f.day FROM json_each(?) wanted
  CROSS JOIN feed_items f ON f.paper_id=wanted.value
  WHERE NOT EXISTS(SELECT 1 FROM summaries s WHERE s.paper_id=f.paper_id)
  GROUP BY f.paper_id,f.day
)`;
export async function summaryCounterWrites(
  db: IngestDatabase,
  paperIds: string[],
) {
  if (!paperIds.length) return 0;
  const { results } = await db
    .prepare(summaryCounters)
    .bind(JSON.stringify(paperIds))
    .all<{ n: number }>();
  return results[0]!.n;
}

const summaryAllowanceError = "LitScout summary counter allowance exceeded";
export class SummaryCounterConflict extends Error {}

export async function ingestSummaries(
  db: IngestDatabase,
  input: unknown,
  counterAllowance?: number,
  legacy = false,
) {
  const { summaries } = schemas.summaries.parse(input);
  if (!summaries.length) return 0;
  const statements = summaries.map((s) =>
    upsertStatement(
      db,
      "summaries",
      ["paper_id", "lang", "kind"],
      {
        paper_id: s.paperId,
        lang: s.lang,
        kind: "five_part",
        content: s.content,
        model: s.model,
        client: s.client,
      },
      true,
      legacy ? "0" : "1",
    ),
  );
  if (counterAllowance === undefined) return writeBatch(db, statements);
  const paperIds = [...new Set(summaries.map((s) => s.paperId))];
  // Read the fan-out again inside the write transaction. An ingest request
  // could have added another occurrence since the Worker reserved its lease.
  const guard = db
    .prepare(
      `SELECT CASE WHEN (${summaryCounters})>? THEN json_extract('{}',?) END`,
    )
    .bind(JSON.stringify(paperIds), counterAllowance, summaryAllowanceError);
  try {
    return await writeBatch(db, [guard, ...statements]);
  } catch (error) {
    if (error instanceof Error && error.message.includes(summaryAllowanceError))
      throw new SummaryCounterConflict(
        "Feed membership changed. Retry the summary upload.",
      );
    throw error;
  }
}
export async function ingestFeedDay(db: IngestDatabase, input: unknown) {
  const v = schemas.feedDay.parse(input);
  const previous = await db
    .prepare("SELECT * FROM feed_days WHERE day=?")
    .bind(v.day)
    .first<{ status: DayStatus; crawled_at: string | null }>();
  const status = nextStatus(previous?.status ?? "pending", v.status);
  return writeBatch(db, [
    upsertStatement(
      db,
      "feed_days",
      ["day"],
      {
        day: v.day,
        status,
        counts: v.counts,
        crawled_at: v.crawledAt ?? previous?.crawled_at ?? null,
      },
      true,
    ),
  ]);
}
export class FinalDigestConflict extends Error {
  constructor(readonly rowsWritten = 0) {
    super("Final digest requires write scope");
  }
}
export class UnknownSuggestionIdea extends Error {
  constructor(id: string) {
    super("Suggestion references an unknown idea: " + id);
  }
}

export async function ingestDigest(
  db: IngestDatabase,
  input: unknown,
  allowFinalUpdate = false,
) {
  const v = digestRecordSchema.parse(input);
  const suggestions =
    v.kind === "daily"
      ? await Promise.all(
          (v.suggestions ?? []).map(async (item) => ({
            ...item,
            id: await stableId("sg_", JSON.stringify([v.day, item])),
          })),
        )
      : [];
  const targets = suggestions.flatMap(({ kind, ideaIds }) =>
    kind === "paper_for_idea" ? ideaIds : [],
  );
  if (targets.length) {
    const missing = await db
      .prepare(
        `
      SELECT j.value AS id FROM json_each(?) j
      WHERE NOT EXISTS (
        SELECT 1 FROM vault_notes n WHERE n.id=j.value AND n.kind='idea' AND n.deleted_at IS NULL
      ) LIMIT 1
    `,
      )
      .bind(JSON.stringify(targets))
      .first<{ id: string }>();
    if (missing) throw new UnknownSuggestionIdea(missing.id);
  }
  const proposalJson = JSON.stringify(suggestions);
  const digestMatch = [v.day, v.lang, v.bodyMd] as const;
  const rowsWritten = await writeBatch(db, [
    upsertStatement(
      db,
      "digests",
      ["day", "lang", "kind"],
      {
        day: v.day,
        lang: v.lang,
        kind: v.kind,
        body_md: v.bodyMd,
        picks: v.picks,
        radar: v.radar,
        final: v.final,
      },
      true,
      allowFinalUpdate ? "1" : "digests.final=0",
    ),
    // Replace only unresolved suggestions, and publish them in the digest transaction.
    ...(v.kind === "daily" && !v.final
      ? [
          db
            .prepare(
              `
        UPDATE suggestions SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),rev=rev+1
        WHERE user_id='u_owner' AND day=? AND created_by='digest' AND status='new'
          AND deleted_at IS NULL AND id NOT IN (SELECT value ->> 'id' FROM json_each(?))
          AND EXISTS (SELECT 1 FROM digests WHERE day=? AND lang=? AND kind='daily' AND body_md=? AND final=0)
      `,
            )
            .bind(v.day, proposalJson, ...digestMatch),
        ]
      : []),
    ...(suggestions.length
      ? [
          db
            .prepare(
              `
        INSERT INTO suggestions(id, day, kind, title, body_md, idea_ids, paper_ids, project_ids, created_by)
        SELECT j.value ->> 'id', ?, j.value ->> 'kind', j.value ->> 'title',
          j.value ->> 'bodyMd', j.value -> 'ideaIds', j.value -> 'paperIds',
          j.value -> 'projectIds', 'digest'
        FROM json_each(?) j
        WHERE EXISTS (
          SELECT 1 FROM digests WHERE day=? AND lang=? AND kind='daily' AND body_md=? AND final=?
            ${v.final ? "AND (changes()>0 OR ?)" : ""}
        )
        AND NOT EXISTS (
          SELECT 1 FROM suggestions s WHERE s.id=j.value ->> 'id'
            AND (s.status!='new' OR s.deleted_at IS NULL)
        )
        GROUP BY j.value ->> 'id'
        ORDER BY min(CAST(j.key AS INTEGER))
        LIMIT max(0, ? - (
          SELECT count(*) FROM suggestions
          WHERE day=? AND user_id='u_owner' AND created_by='digest' AND status='new' AND deleted_at IS NULL
        ))
        ON CONFLICT(id) DO UPDATE SET deleted_at=NULL,rev=rev+1
      `,
            )
            .bind(
              v.day,
              proposalJson,
              ...digestMatch,
              Number(v.final),
              ...(v.final ? [Number(allowFinalUpdate)] : []),
              digestSuggestionLimit,
              v.day,
            ),
        ]
      : []),
    // Only the daily report reads a day's papers; a weekly report on a
    // Sunday leaves that day's status as it was.
    ...(v.kind === "daily"
      ? [
          db
            .prepare(
              "UPDATE feed_days SET status=?,rev=rev+1 WHERE day=? AND status NOT IN ('final',?) AND EXISTS (SELECT 1 FROM digests WHERE day=? AND lang=? AND kind=? AND body_md=? AND picks=? AND radar=? AND final=?)",
            )
            .bind(
              v.final ? "final" : "digested",
              v.day,
              v.final ? "final" : "digested",
              v.day,
              v.lang,
              v.kind,
              v.bodyMd,
              JSON.stringify(v.picks),
              JSON.stringify(v.radar),
              Number(v.final),
            ),
        ]
      : []),
  ]);
  if (!allowFinalUpdate) await checkFinalDigest(db, v, rowsWritten);
  return rowsWritten;
}
export async function ingestRadar(db: IngestDatabase, input: unknown) {
  const { radar } = schemas.radar.parse(input);
  const queries = await Promise.all(
    radar.map(async (r) =>
      upsertStatement(db, "radar_grades", ["id"], {
        id: await stableId("rad_", [r.day, r.paperId, r.projectId].join(":")),
        day: r.day,
        paper_id: r.paperId,
        project_id: r.projectId,
        level: r.level,
        full_text_read: r.fullTextRead,
        reason: r.reason,
        action: r.action,
        look_back: r.lookBack,
      }),
    ),
  );
  return writeBatch(db, queries);
}
export async function ingestLegacy(db: IngestDatabase, input: unknown) {
  const v = schemas.legacy.parse(input);
  return writeBatch(db, [
    ...v.cursors.map((c) =>
      upsertStatement(db, "sync_cursors", ["name"], {
        name: c.name,
        value: c.value,
      }),
    ),
    ...runStatements(db, v.runs),
    ...v.missed.map((m) =>
      upsertStatement(
        db,
        "missed",
        ["id"],
        {
          id: m.id,
          paper_id: m.paperId,
          found_on: m.foundOn,
          where: m.where,
          note: m.note,
        },
        true,
      ),
    ),
    ...v.ratings.map((r) =>
      upsertStatement(db, "events", ["id"], {
        id: r.id,
        paper_id: r.paperId,
        day: r.day,
        kind: r.kind,
        source: r.source,
        at: r.at,
      }),
    ),
  ]);
}

function runStatements(
  db: IngestDatabase,
  runs: ReturnType<typeof schemas.legacy.parse>["runs"],
) {
  return runs.map((r) =>
    upsertStatement(
      db,
      "runs",
      ["id"],
      {
        id: r.id,
        kind: r.kind,
        day: r.day,
        status: r.status,
        started_at: r.startedAt,
        finished_at: r.finishedAt,
        stats: r.stats,
        error: r.error,
      },
      true,
    ),
  );
}

async function checkFinalDigest(
  db: IngestDatabase,
  v: ReturnType<typeof digestRecordSchema.parse>,
  rowsWritten: number,
) {
  const stored = await db
    .prepare(
      "SELECT body_md,picks,radar,final FROM digests WHERE day=? AND lang=? AND kind=?",
    )
    .bind(v.day, v.lang, v.kind)
    .first<{
      body_md: string;
      picks: string;
      radar: string;
      final: number;
    }>();
  if (
    stored?.final &&
    (stored.body_md !== v.bodyMd ||
      stored.picks !== JSON.stringify(v.picks) ||
      stored.radar !== JSON.stringify(v.radar) ||
      !v.final)
  )
    throw new FinalDigestConflict(rowsWritten);
}
