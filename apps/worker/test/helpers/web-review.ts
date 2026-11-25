import {
  beginAlphaXiv,
  finishAlphaXiv,
  writeAlphaXiv,
} from "@litscout/db/alphaxiv";
import { recordDailyRun } from "@litscout/db/daily-runs";
import { shiftDay } from "@litscout/pipeline/daily";

const reviewTitle = "A recorded preprint without a DOI";

export function reviewResolution(request: Request) {
  const url = new URL(request.url);
  if (url.origin === "https://api.openalex.org") {
    const work = {
      id: "https://openalex.org/W42",
      doi: null,
      display_name: reviewTitle,
      type: "preprint",
      publication_year: 2026,
      authorships: [{ author: { display_name: "Fixture Author" } }],
    };
    if (url.pathname === "/works/W42") return Response.json(work);
    if (
      url.pathname === "/works" &&
      url.searchParams.get("search") === reviewTitle
    )
      return Response.json({ results: [work] });
  }
  return new Response("Network disabled", { status: 503 });
}

export async function seedReview(db: D1Database) {
  const takenAt = "2026-11-16T04:42:00.000Z";
  const mirror = { takenAt, digest: "a".repeat(64) };
  await beginAlphaXiv(db, mirror);
  await writeAlphaXiv(db, {
    ...mirror,
    items: [
      {
        paperType: "public",
        paperId: "2611.12345",
        title: "Review fixture mirror paper",
        status: "reading",
        publicationDate: "2026-11-16",
        annotation: null,
        folders: [
          { id: "review-folder", path: "Review folder", type: "custom" },
        ],
      },
    ],
  });
  await finishAlphaXiv(db, mirror);
  await db
    .prepare("UPDATE paper_links SET checked_at=?,http_status=200 WHERE url=?")
    .bind(takenAt, "https://doi.org/10.1109/tvcg.2026.3747406")
    .run();

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const targetDay = shiftDay(today, -1);
  await recordDailyRun(
    db,
    {
      id: "43d91359-fbdc-4047-a843-30e90031a4df",
      targetDay,
      startedAt: targetDay + "T02:20:00.000Z",
      finishedAt: targetDay + "T03:10:00.000Z",
      rowsWritten: 14_320,
      steps: {
        fetch: { status: "done" },
        summaries: { status: "done", client: "codex", fallback: true },
        digest: { status: "done", client: "claude" },
        sync: { status: "done" },
        legacy: { status: "skipped" },
      },
    },
    targetDay,
    shiftDay(today, -30) + "T00:00:00.000Z",
  );
}
