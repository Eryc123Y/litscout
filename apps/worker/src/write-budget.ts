import { expirePath, prunePath } from "@litscout/pipeline/retention-contracts";
import type { Context, MiddlewareHandler } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { apiTokenTouchDue, touchApiToken } from "@litscout/db/tokens";
import {
  reserveWriteBudget,
  settleWriteBudget,
  writeLimit,
} from "@litscout/db/write-budget";
import { summaryCounterWrites } from "@litscout/db/ingest";
import {
  legacyPaperQuote,
  PaperMergeConflict,
  preparePaperIngest,
} from "@litscout/db/ingest-papers";
import { schemas } from "@litscout/pipeline/contracts/index";
import { trendsSourcePath } from "@litscout/pipeline/trends-contracts";
import { zoteroImportPath } from "@litscout/pipeline/zotero-contracts";
import { restorePath } from "@litscout/pipeline/backup-restore-contracts";
import { healthPath } from "@litscout/pipeline/health-contracts";
import {
  measuredWriteEstimate,
  writeReservation,
} from "@litscout/pipeline/write-reservation";
import type { WorkerBindings } from "./api-auth";
import { quotaResponse } from "./write-quota";

const tokenTouchReservation = 2;
const tokenTouchEstimate = 1;

export async function recordMcpTokenUse(db: D1Database, id: string, now: Date) {
  const lease = await reserveWriteBudget(
    db,
    tokenTouchReservation,
    now,
    tokenTouchEstimate,
  );
  if (!lease) return;
  let rows: number;
  try {
    rows = await touchApiToken(drizzle(db), id, now.toISOString());
  } catch (error) {
    await settleWriteBudget(db, lease, 0, true);
    throw error;
  }
  await settleWriteBudget(db, lease, rows);
}

async function requestCost(c: Context<WorkerBindings>) {
  const path = c.req.path.replace("/api/v1", "");
  const body = c.get("ingestBody");
  if (body === undefined) return { cost: 0, estimate: 0 };
  const cost = writeReservation(path, body);
  const estimate = measuredWriteEstimate(path, body);
  if (path === "/ingest/papers" && c.req.method === "POST") {
    const { day, papers, legacy, maxRows } = schemas.paperBatch.parse(body);
    if (legacy === "plan") return { cost: 0, estimate: 0 };
    const db = c.env.DB!;
    const plan = await preparePaperIngest(db, day, papers, legacy === "import");
    c.set("paperIngestPlan", plan);
    if (legacy === "import") {
      const { rows } = legacyPaperQuote(plan);
      if (maxRows !== undefined && rows > maxRows)
        throw new PaperMergeConflict(
          "Legacy paper costs changed. Retry import.",
        );
      return { cost: Math.max(1, rows), estimate: rows };
    }
    const extra = plan.mergeWrites + plan.historyWrites;
    return { cost: cost + extra, estimate: estimate + extra };
  }
  if (/^\/digests\/[^/]+$/.test(path) && c.req.method === "PUT") {
    const { day, lang, kind } = schemas.digest.parse(body);
    const prior = await c.env
      .DB!.prepare(
        `SELECT count(*) AS n FROM retention_refs
      WHERE source='digests' AND source_key=json_array(?,?,?)`,
      )
      .bind(day, lang, kind)
      .first<number>("n");
    return {
      cost: cost + 2 * (prior ?? 0),
      estimate: estimate + 2 * (prior ?? 0),
    };
  }
  if (path !== "/ingest/summaries" || c.req.method !== "POST")
    return { cost, estimate };
  const summaries = (body as { summaries?: unknown } | null)?.summaries;
  if (!Array.isArray(summaries)) return { cost, estimate };
  const ids = new Set<string>();
  for (const summary of summaries)
    if (typeof summary?.paperId === "string") ids.add(summary.paperId);
  const counters = await summaryCounterWrites(c.env.DB!, [...ids]);
  c.set("summaryCounterAllowance", counters);
  const legacy = schemas.summaryBatch.parse(body);
  if (legacy.legacy) {
    const rows = 5 * summaries.length + counters;
    if (legacy.maxRows !== undefined && rows > legacy.maxRows)
      throw new PaperMergeConflict(
        "Legacy summary costs changed. Retry import.",
      );
    return { cost: Math.max(1, rows), estimate: rows };
  }
  return { cost: cost + counters, estimate };
}
async function finish(
  c: Context<WorkerBindings>,
  lease: NonNullable<Awaited<ReturnType<typeof reserveWriteBudget>>>,
  auth: number,
) {
  const saved = c.get("apiPayload");
  const data =
    saved && saved.status === c.res.status
      ? saved.body
      : ((await c.res.clone().json()) as { meta?: { rowsWritten?: number } });
  const rows = Number(data.meta?.rowsWritten ?? 0);
  const budgetRowsWritten = await settleWriteBudget(
    c.env.DB!,
    lease,
    rows + auth,
    c.res.status >= 500,
  );
  c.set("budgetRowsWritten", budgetRowsWritten);
}
export const writeBudget: MiddlewareHandler<WorkerBindings> = async (
  c,
  next,
) => {
  const reopening =
    c.req.method === "POST" &&
    /^\/api\/v1\/days\/[^/]+\/reopen$/.test(c.req.path);
  if (
    !c.env.DB ||
    c.req.path === "/api/v1/budget" ||
    c.req.path === "/api/v1" + prunePath ||
    c.req.path === "/api/v1" + expirePath ||
    (c.req.path === "/api/v1/ingest/papers" &&
      (c.get("ingestBody") as { legacy?: string } | undefined)?.legacy ===
        "plan") ||
    c.req.path === "/api/v1" + zoteroImportPath ||
    c.req.path === "/api/v1" + restorePath ||
    (c.req.path === "/api/v1" + healthPath &&
      c.req.query("cutoverDays") !== undefined) ||
    (reopening && c.req.query("dryRun") === "1") ||
    (["GET", "HEAD"].includes(c.req.method) &&
      (c.req.path.startsWith("/api/v1/vault/") ||
        c.req.path.startsWith("/api/v1" + trendsSourcePath)))
  )
    return next();
  c.set("authRowsWritten", 0);
  // One versioned feed day and the daily digests in the supported languages.
  const { cost, estimate } = reopening
    ? { cost: 32, estimate: 12 }
    : await requestCost(c);
  const token = c.get("apiToken");
  const now = new Date();
  const due = token && apiTokenTouchDue(token.lastUsedAt, now);
  if (!cost && !due) return next();
  const reservation = cost + (due ? tokenTouchReservation : 0);
  const lease =
    reservation <= writeLimit()
      ? await reserveWriteBudget(
          c.env.DB,
          reservation,
          now,
          estimate + (due ? tokenTouchEstimate : 0),
        )
      : null;
  if (!lease) {
    if (!cost) return next();
    return quotaResponse(c, reservation);
  }
  let auth = 0;
  try {
    if (due) {
      auth = await touchApiToken(
        drizzle(c.env.DB),
        token.id,
        now.toISOString(),
      );
      c.set("authRowsWritten", auth);
    }
    await next();
  } catch (error) {
    await settleWriteBudget(c.env.DB, lease, auth, true);
    throw error;
  }
  await finish(c, lease, auth);
};
