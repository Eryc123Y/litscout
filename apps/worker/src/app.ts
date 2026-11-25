import { retentionApi } from "./retention-api";
import { readServerStatus, serverStatusApi } from "./server-status";
import { apiJson, finalizeApiJson } from "./api-response";
import { limitRequest } from "./auth/request-limit";
import { viewFeedDays, viewPrivateFeedDaysPage } from "./feed-view";
import { Hono } from "hono";
import type { Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { drizzle } from "drizzle-orm/d1";
import { putRun } from "@litscout/db";
import { privateAuth, type WorkerBindings } from "./api-auth";
import type { AppEnv } from "./env";
import { health } from "./health";
import { expireDailyRuns, healthApi } from "./health-api";
import { backupApi } from "./backup-api";
import { restoreApi } from "./restore-api";
import { unavailable, logRequestError } from "./diagnostics";
import { assetResponse } from "./assets";
import { publicApi, instanceInfo } from "./public-feed";
import { feedApi } from "./feed-api";
import { trendsApi } from "./trends-api";
import { libraryApi } from "./library-api";
import { vaultApi } from "./vault-api";
import { alphaXivApi } from "./alphaxiv-api";
import { requestSize } from "./request-size";
import { requireSameOriginJson } from "./api-csrf";
import { limitLibraryWrites } from "./library-write-limit";
import { writeBudget } from "./write-budget";
import { knownApiError } from "./api-errors";
import { setSecurityHeaders } from "./security-headers";
import { stageCronListing } from "./cron-trial";
export const app = new Hono<WorkerBindings>();
app.use(
  "*",
  secureHeaders({
    referrerPolicy: false,
    xContentTypeOptions: false,
    xFrameOptions: false,
  }),
);
app.use("*", async (c, next) => {
  await next();
  setSecurityHeaders(c.res.headers);
});
app.use("/api/v1/*", finalizeApiJson);
app.use("/api/v1/*", async (c, next) => {
  await next();
  if (
    !["GET", "HEAD"].includes(c.req.method) ||
    !c.req.path.startsWith("/api/v1/public/")
  )
    c.header("Cache-Control", "no-store");
});
app.use("/api/v1/public/*", async (c, next) => {
  const denied = await limitRequest(c.req.raw, c.env, c.req.path);
  if (denied) return denied;
  return next();
});
app.use("/api/v1/*", privateAuth);
app.use("/api/v1/*", requireSameOriginJson);
app.use("/api/v1/*", requestSize);
app.use("/api/v1/*", limitLibraryWrites);
app.use("/api/v1/*", writeBudget);
app.use("/app/*", privateAuth);
app.get("/health", async (c) => {
  const state = await health(c.env);
  return c.json({ ok: state.ok }, state.ok ? 200 : 503);
});
async function privateHealth(c: Context<WorkerBindings>) {
  const state = await health(c.env);
  const server =
    state.details.database.reachable && c.env.DB
      ? await readServerStatus(c.env.DB).catch(() => null)
      : null;
  const token = c.get("apiToken");
  return apiJson(
    c,
    {
      success: state.ok,
      data: {
        ...state.details,
        server,
        ...(token && {
          token: {
            scopes: c.get("tokenScopes"),
            legacyVault: token.legacyVault,
          },
        }),
      },
    },
    state.ok ? 200 : 503,
  );
}
app.get("/api/v1/health", privateHealth);
app.get("/api/v1/vault/health", privateHealth);
const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.iso.date().optional(),
  view: z.enum(["page"]).optional(),
});
feedQuery.parse({ before: "2000-01-01", view: "page" });
app.get("/api/v1/feed/days", async (c) => {
  const parsed = feedQuery.safeParse(c.req.query());
  if (!parsed.success)
    return apiJson(
      c,
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid query",
          fields: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      },
      400,
    );
  if (!c.env.DB) return unavailable("Feed query: DB binding missing");
  const days = await (
    parsed.data.view === "page" ? viewPrivateFeedDaysPage : viewFeedDays
  )(c.env.DB, parsed.data.limit, parsed.data.before);
  return apiJson(c, {
    success: true,
    data: days,
    meta: { limit: parsed.data.limit },
  });
});
app.get("/api/v1/instance", (c) => {
  c.header("Cache-Control", "no-store");
  const full =
    c.env.PUBLIC_FEED === "true" || c.get("tokenScopes")?.includes("read");
  return apiJson(c, {
    success: true,
    data: full ? instanceInfo(c.env) : { name: "LitScout" },
  });
});
app.route("/api/v1/public", publicApi);
app.route("/api/v1", libraryApi);
app.route("/api/v1", alphaXivApi);
app.route("/api/v1", vaultApi);
app.route("/api/v1", trendsApi);
app.route("/api/v1", retentionApi);
app.route("/api/v1", serverStatusApi);
app.route("/api/v1", feedApi);
app.route("/api/v1", healthApi);
// Before the export routes, whose /backup/:section would match first.
app.route("/api/v1", restoreApi);
app.route("/api/v1", backupApi);
async function page(request: Request, env: AppEnv) {
  return env.ASSETS
    ? assetResponse(request, env.ASSETS)
    : new Response(
        '<!doctype html><html lang="en"><title>LitScout</title><h1>LitScout</h1><a href="/health">Health</a></html>',
        { headers: { "content-type": "text/html;charset=utf-8" } },
      );
}
// Pages of the old LitScout Daily site (H0). Its hash links (#day=...)
// reach "/" and the web app maps them.
app.get("/index.html", (c) => c.redirect(`/${new URL(c.req.url).search}`, 301));
// 302: the target may change once Trends has a public page.
app.get("/statistic.html", (c) => c.redirect("/app/trends", 302));
const legacyJsonKeys = ["json", "category", "keywords", "author"];
/**
 * The old JSON mode for scripts (?json=<category>&keywords=a,b&author=x)
 * printed the newest day's papers. Its target is the newest public day with
 * papers as JSON, searched for the first keyword of three or more
 * characters; the API has no category or author filter.
 */
async function legacyJsonTarget(
  db: D1Database | undefined,
  query: URLSearchParams,
) {
  const newest = db
    ? await db
        .prepare(
          "SELECT day FROM feed_days WHERE status NOT IN ('pending','empty') ORDER BY day DESC LIMIT 1",
        )
        .first<string>("day")
    : null;
  if (!newest) return "/api/v1/public/days";
  const keyword = (query.get("keywords") ?? "")
    .split(",")
    .map((k) => k.trim())
    .find((k) => Array.from(k).length >= 3);
  return `/api/v1/public/days/${newest}${keyword ? `?${new URLSearchParams({ q: keyword })}` : ""}`;
}
app.get("/", async (c) => {
  const query = new URL(c.req.url).searchParams;
  // A private instance has no public JSON to send old scripts to.
  return c.env.PUBLIC_FEED === "true" &&
    legacyJsonKeys.some((key) => query.has(key))
    ? c.redirect(await legacyJsonTarget(c.env.DB, query), 302)
    : page(c.req.raw, c.env);
});
app.get("/app/*", (c) =>
  page(new Request(new URL("/", c.req.url), c.req.raw), c.env),
);
app.get("/public/*", (c) =>
  c.env.ASSETS
    ? assetResponse(
        new Request(
          new URL(c.req.path.includes(".") ? c.req.path : "/", c.req.url),
          c.req.raw,
        ),
        c.env.ASSETS,
      )
    : apiJson(c, { success: true, data: [] }),
);
for (const path of ["/assets/*", "/favicon.ico", "/robots.txt"])
  app.get(path, (c) =>
    c.env.ASSETS ? assetResponse(c.req.raw, c.env.ASSETS) : c.notFound(),
  );
app.notFound((c) =>
  apiJson(
    c,
    { success: false, error: { code: "NOT_FOUND", message: "Not found" } },
    404,
  ),
);
app.onError((error, c) => {
  const known = knownApiError(error, c);
  if (known) return known;
  logRequestError(error, c.req.path);
  // This is also the fallback for failures in the final JSON serialization.
  return c.json(
    {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      },
    },
    500,
  );
});
// Registration is complete. Prepare the matcher once, outside request CPU.
app.router.match("GET", "/health");
/** Worker Cron records its invocation and expires old run reports. */
export async function scheduled(env: AppEnv, at: number) {
  if (env.CRON_CRAWL_TRIAL === "true") return stageCronListing(env, at);
  if (!env.DB) throw new Error("Database binding DB is not configured");
  const now = new Date(at).toISOString();
  await putRun(
    drizzle(env.DB),
    {
      kind: "cron",
      day: now.slice(0, 10),
      status: "done",
      finishedAt: now,
      stats: { stub: true },
    },
    0,
  );
  await expireDailyRuns(env.DB, new Date(at));
}
