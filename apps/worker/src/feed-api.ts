import { compactDetails } from "./compact-details";
import { allowLimitedRequest } from "./auth/request-limit";
import { getCompactPaper } from "@litscout/db/compact-paper";
import { readWebDigest, readDigestRows } from "@litscout/db/web-digest";
import { readTriageQueue } from "@litscout/db/triage-read";
import {
  digestRowsQuerySchema,
  paperSearchQuery,
} from "@litscout/pipeline/web-contracts";
import { isOperationalCursor } from "./operational-cursor";
import { apiJson } from "./api-response";
import { paperQuerySchema } from "@litscout/pipeline/read-contracts";
import {
  readDayPage,
  readPaper,
  readHistory,
  searchListedPapers,
} from "@litscout/db/bounded-read";
import { viewFeedDay, viewFeedCounts } from "./feed-view";
import { instanceInfo } from "./public-feed";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  schemas,
  daySchema,
  langSchema,
} from "@litscout/pipeline/contracts/index";
import {
  ingestPapers,
  legacyPaperQuote,
  preparePaperIngest,
} from "@litscout/db/ingest-papers";
import { ingestFeedDay, ingestDigest } from "@litscout/db/ingest";
import { reopenDay } from "@litscout/db/day-reopen";
import { readDigest, readOperations } from "@litscout/db/feed-read";
import type { WorkerBindings } from "./api-auth";
import { cursorNameSchema } from "@litscout/pipeline/contracts/limits";
import {
  ingestSummaryRecords,
  ingestRadarRecords,
  ingestLegacyRecords,
} from "@litscout/db/ingest-records";
import {
  releaseStaleLeases,
  writeBudgetUsage,
  migrationWriteUsage,
  nextReset,
} from "@litscout/db/write-budget";
export const feedApi = new Hono<WorkerBindings>();
feedApi.use("*", async (c, next) => {
  if (!c.env.DB)
    return apiJson(
      c,
      {
        success: false,
        error: { code: "UNAVAILABLE", message: "Database unavailable" },
      },
      503,
    );
  await next();
});
feedApi.get("/feed/days/:day", async (c) =>
  apiJson(c, {
    success: true,
    data: await viewFeedDay(
      c.env.DB!,
      daySchema.parse(c.req.param("day")),
      c.req.query(),
      false,
      instanceInfo(c.env).keywordOnly,
      instanceInfo(c.env).topVenues,
    ),
  }),
);
feedApi.get("/feed/days/:day/triage", async (c) =>
  apiJson(c, {
    success: true,
    data: await readTriageQueue(
      c.env.DB!,
      daySchema.parse(c.req.param("day")),
      instanceInfo(c.env).language,
    ),
  }),
);
feedApi.get("/feed/days/:day/counts", async (c) =>
  apiJson(c, {
    success: true,
    data: await viewFeedCounts(c.env.DB!, daySchema.parse(c.req.param("day"))),
  }),
);
feedApi.get("/feed/days/:day/summary-todo", async (c) => {
  const day = daySchema.parse(c.req.param("day"));
  const data = await readDayPage(c.env.DB!, day, c.req.query(), false, true);
  return apiJson(c, { success: true, data });
});
feedApi.get("/feed/history", async (c) =>
  apiJson(c, {
    success: true,
    data: await readHistory(c.env.DB!, c.req.query()),
  }),
);
feedApi.get("/feed/days/:day/full", async (c) =>
  apiJson(c, {
    success: true,
    data: await readDayPage(
      c.env.DB!,
      daySchema.parse(c.req.param("day")),
      c.req.query(),
      false,
      false,
      true,
    ),
  }),
);
feedApi.get("/feed/days/:day/references", async (c) => {
  daySchema.parse(c.req.param("day"));
  const q = digestRowsQuerySchema.parse(c.req.query());
  return apiJson(c, {
    success: true,
    data: { items: await readDigestRows(c.env.DB!, q.ids) },
  });
});
feedApi.get("/papers/:id/details", async (c) => {
  const token = c.get("apiToken");
  const caller = await allowLimitedRequest(
    c.env,
    "compact-details:" + (token ? "token:" + token.id : "owner"),
    20,
  );
  const limited = caller.allowed
    ? await allowLimitedRequest(c.env, "compact-details", 60)
    : caller;
  if (!limited.allowed) {
    c.header("Retry-After", String(limited.retryAfter));
    return apiJson(
      c,
      {
        success: false,
        error: { code: "RATE_LIMITED", message: "Too many detail requests" },
      },
      429,
    );
  }
  const compact = await getCompactPaper(c.env.DB!, c.req.param("id"));
  return compact
    ? apiJson(c, { success: true, data: await compactDetails(c.env, compact) })
    : apiJson(
        c,
        {
          success: false,
          error: { code: "NOT_FOUND", message: "Archived paper not found" },
        },
        404,
      );
});
feedApi.get("/search", async (c) => {
  const query = paperSearchQuery.safeParse(c.req.query());
  if (!query.success)
    return apiJson(
      c,
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: query.error.issues.some((issue) => issue.path[0] === "q")
            ? "Search needs at least three characters"
            : "Check the search filters",
        },
      },
      400,
    );
  const { q, limit, ...filters } = query.data;
  return apiJson(c, {
    success: true,
    data: await searchListedPapers(
      c.env.DB!,
      q,
      limit,
      filters,
      instanceInfo(c.env).topVenues,
    ),
  });
});
feedApi.get("/papers/:id", async (c) => {
  const q = paperQuerySchema.parse(c.req.query());
  const paper = await readPaper(
    c.env.DB!,
    c.req.param("id"),
    q.day,
    false,
    q.source,
  );
  return paper
    ? apiJson(c, { success: true, data: paper })
    : apiJson(
        c,
        {
          success: false,
          error: { code: "NOT_FOUND", message: "Paper not found" },
        },
        404,
      );
});
const operationsQuery = z.object({ from: daySchema, to: daySchema });
const digestQuery = z.object({
  lang: langSchema.default("en"),
  kind: z.enum(["daily", "weekly"]).default("daily"),
});
for (const path of ["/digests/:day", "/feed/days/:day/digest"])
  feedApi.get(path, async (c) => {
    const q = digestQuery.parse(c.req.query());
    return apiJson(c, {
      success: true,
      data: await (path.startsWith("/feed/") ? readWebDigest : readDigest)(
        c.env.DB!,
        daySchema.parse(c.req.param("day")!),
        q.lang,
        q.kind,
      ),
    });
  });
const reopenPreview = z.literal("1").optional();
feedApi.post("/days/:day/reopen", async (c) => {
  const day = daySchema.parse(c.req.param("day"));
  const dryRun = reopenPreview.parse(c.req.query("dryRun")) === "1";
  const { plan, rowsWritten } = await reopenDay(c.env.DB!, day, dryRun);
  if (!dryRun) {
    console.info(
      JSON.stringify({
        event: "day.reopen",
        day,
        oldStatus: plan.oldStatus,
        newStatus: plan.newStatus,
        changed: plan.changed,
        digestsDeleted: plan.digests.length,
      }),
    );
  }
  return apiJson(c, { success: true, data: plan, meta: { rowsWritten } });
});
feedApi.post("/ingest/papers", async (c) => {
  const v = schemas.paperBatch.parse(c.get("ingestBody"));
  if (v.legacy === "plan") {
    const db = c.env.DB!;
    const plan = await preparePaperIngest(db, v.day, v.papers, true);
    return apiJson(c, {
      success: true,
      data: legacyPaperQuote(plan),
    });
  }
  const result = await ingestPapers(
    c.env.DB!,
    v.day,
    v.papers,
    c.get("paperIngestPlan"),
  );
  return apiJson(c, {
    success: true,
    data: {
      papers: result.papers,
      accepted: result.accepted,
      skipped: result.skipped,
      invalid: result.invalid,
    },
    meta: { rowsWritten: result.rowsWritten },
  });
});
for (const [path, handler] of [
  ["/ingest/summaries", ingestSummaryRecords],
  ["/ingest/radar", ingestRadarRecords],
  ["/ingest/legacy", ingestLegacyRecords],
] as const)
  feedApi.post(path, async (c) => {
    const result = await handler(
      c.env.DB!,
      c.get("ingestBody"),
      c.get("summaryCounterAllowance"),
    );
    return apiJson(c, {
      success: true,
      data: {
        accepted: result.accepted,
        skipped: result.skipped,
        invalid: result.invalid,
      },
      meta: { rowsWritten: result.rowsWritten },
    });
  });
feedApi.post("/ingest/feed-day", async (c) =>
  apiJson(c, {
    success: true,
    data: {},
    meta: { rowsWritten: await ingestFeedDay(c.env.DB!, c.get("ingestBody")) },
  }),
);
feedApi.put("/digests/:day", async (c) => {
  const value = schemas.digest.parse(c.get("ingestBody"));
  if (value.day !== daySchema.parse(c.req.param("day")))
    return apiJson(
      c,
      {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "day must match URL" },
      },
      400,
    );
  return apiJson(c, {
    success: true,
    data: {},
    meta: {
      rowsWritten: await ingestDigest(
        c.env.DB!,
        value,
        c.get("tokenScopes")?.includes("write") ?? false,
      ),
    },
  });
});
feedApi.get("/operations", async (c) => {
  const q = operationsQuery.parse(c.req.query());
  return apiJson(c, {
    success: true,
    data: await readOperations(c.env.DB!, q.from, q.to),
  });
});
feedApi.get("/sync/cursors", async (c) => {
  const name = cursorNameSchema.parse(c.req.query("name"));
  const result = await c.env
    .DB!.prepare("SELECT name,value FROM sync_cursors WHERE name=?")
    .bind(name)
    .first<{ name: string; value: string }>();
  if (result && !isOperationalCursor(result.name, result.value))
    return apiJson(
      c,
      {
        success: false,
        error: { code: "NOT_FOUND", message: "Cursor unavailable" },
      },
      404,
    );
  return apiJson(c, { success: true, data: result });
});

async function budgetStatus(c: Context<WorkerBindings>, readOnly: boolean) {
  const now = new Date(),
    day = now.toISOString().slice(0, 10);
  const staleLeasesReleased = readOnly
    ? 0
    : (await releaseStaleLeases(c.env.DB!, now)).released;
  const migration = await migrationWriteUsage(c.env.DB!, day);
  c.header("Cache-Control", "no-store");
  return apiJson(c, {
    success: true,
    data: {
      day,
      ...(await writeBudgetUsage(c.env.DB!, day)),
      ...(migration ? { migration } : {}),
      staleLeasesReleased,
      resetAt: nextReset(day),
    },
  });
}
feedApi.get("/budget", (c) => budgetStatus(c, false));
feedApi.get("/vault/budget", (c) => budgetStatus(c, true));
