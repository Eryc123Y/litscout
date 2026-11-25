import { Hono } from "hono";
import {
  trendsPath,
  trendsUploadPath,
  trendsSourcePath,
  trendsQuery,
  trendsUpload,
  trendSearchQuery,
  trendSourceQuery,
  trendReferencesQuery,
  type TrendsQuery,
} from "@litscout/pipeline/trends-contracts";
import { putTrends, readTrends } from "@litscout/db/trends";
import {
  readTrendSource,
  searchTrendPapers,
  trendReferences,
  trendWindow,
} from "@litscout/db/trends-source";
import { apiJson } from "./api-response";
import type { WorkerBindings } from "./api-auth";
import type { AppEnv } from "./env";
import { instanceInfo } from "./public-feed";
import { userDay } from "./instance-day";
import { unavailable } from "./diagnostics";

export const trendsApi = new Hono<WorkerBindings>();

export function instanceTrends(
  db: D1Database,
  env: AppEnv,
  query: TrendsQuery,
) {
  return readTrends(
    db,
    query,
    userDay(env, new Date()).slice(0, 7),
    instanceInfo(env).topics[0],
  );
}

trendsApi.get(trendsPath, async (c) => {
  if (!c.env.DB) return unavailable("Trends: DB binding missing");
  return apiJson(c, {
    success: true,
    data: await instanceTrends(
      c.env.DB,
      c.env,
      trendsQuery.parse(c.req.query()),
    ),
  });
});
trendsApi.get(trendsPath + "/search", async (c) => {
  if (!c.env.DB) return unavailable("Trends search: DB binding missing");
  return apiJson(c, {
    success: true,
    data: await searchTrendPapers(
      c.env.DB,
      trendSearchQuery.parse(c.req.query()),
    ),
  });
});
trendsApi.get(trendsSourcePath, async (c) => {
  if (!c.env.DB) return unavailable("Trends source: DB binding missing");
  return apiJson(c, {
    success: true,
    data: await readTrendSource(
      c.env.DB,
      trendSourceQuery.parse(c.req.query()),
    ),
  });
});
trendsApi.get(trendsSourcePath + "/references", async (c) => {
  if (!c.env.DB) return unavailable("Trends source: DB binding missing");
  const { ids } = trendReferencesQuery.parse(c.req.query());
  return apiJson(c, {
    success: true,
    data: await trendReferences(c.env.DB, ids),
  });
});
trendsApi.get(trendsSourcePath + "/window", async (c) => {
  if (!c.env.DB) return unavailable("Trends source: DB binding missing");
  return apiJson(c, { success: true, data: await trendWindow(c.env.DB) });
});
trendsApi.put(trendsUploadPath, async (c) => {
  if (!c.env.DB) return unavailable("Trends refresh: DB binding missing");
  const { rows } = trendsUpload.parse(c.get("ingestBody"));
  const rowsWritten = await putTrends(c.env.DB, rows);
  return apiJson(c, {
    success: true,
    data: { rowsWritten },
    meta: { rowsWritten },
  });
});
