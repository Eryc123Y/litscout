import { publicFeed, publicDays, publicPaper } from "./public-shape";
export { publicFeed, publicDays } from "./public-shape";
import { apiJson } from "./api-response";
import { paperQuerySchema } from "@litscout/pipeline/read-contracts";
import { readPaper } from "@litscout/db/bounded-read";
import { Hono } from "hono";
import { z } from "zod";

import {
  viewFeedDays,
  viewFeedDay,
  viewFeedDaysPage,
  viewFeedCounts,
} from "./feed-view";
import { daySchema } from "@litscout/pipeline/contracts/index";
import { instanceSchema } from "@litscout/pipeline/web-contracts";
import type { InstanceInfo } from "@litscout/pipeline/web-contracts";
import type { AppEnv } from "./env";
import type { WorkerBindings } from "./api-auth";
const displaySchema = instanceSchema.omit({ publicFeed: true });
const defaultDisplay = {
  name: "LitScout",
  language: "en" as const,
  timezone: "UTC",
  topics: [] as string[],
  topVenues: [] as string[],
};
let cached:
  { raw: string; publicFeed: boolean; info: InstanceInfo } | undefined;
export function instanceInfo(env: AppEnv): InstanceInfo {
  const raw = env.INSTANCE_CONFIG ?? "{}",
    publicFeed = env.PUBLIC_FEED === "true";
  if (cached?.raw === raw && cached.publicFeed === publicFeed)
    return cached.info;
  let config: unknown = {};
  try {
    config = JSON.parse(raw);
  } catch {
    /* Optional display config fails closed. */
  }
  const parsed = displaySchema.safeParse(config),
    info = { ...(parsed.success ? parsed.data : defaultDisplay), publicFeed };
  cached = { raw, publicFeed, info };
  return info;
}
const publicUnread = z.never();
const publicDaysQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: daySchema.optional(),
  view: z.enum(["page"]).optional(),
});
export const publicApi = new Hono<WorkerBindings>();
publicApi.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.env.PUBLIC_FEED !== "true")
    return apiJson(
      c,
      {
        success: false,
        error: { code: "NOT_FOUND", message: "Public feed is disabled" },
      },
      404,
    );
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
publicApi.get("/days", async (c) => {
  const query = publicDaysQuery.parse(c.req.query());
  if (query.view === "page") {
    const page = await viewFeedDaysPage(c.env.DB!, query.limit, query.before);
    return apiJson(c, {
      success: true,
      data: { ...page, items: publicDays(page.items) },
    });
  }
  return apiJson(c, {
    success: true,
    data: publicDays(await viewFeedDays(c.env.DB!, query.limit, query.before)),
  });
});
publicApi.get("/days/:day/counts", async (c) =>
  apiJson(c, {
    success: true,
    data: await viewFeedCounts(c.env.DB!, daySchema.parse(c.req.param("day"))),
  }),
);
publicApi.get("/days/:day", async (c) => {
  if (c.req.query("unread") !== undefined)
    publicUnread.parse(c.req.query("unread"));
  const keywordOnly = instanceInfo(c.env).keywordOnly;
  return apiJson(c, {
    success: true,
    data: publicFeed(
      await viewFeedDay(
        c.env.DB!,
        daySchema.parse(c.req.param("day")),
        c.req.query(),
        true,
        keywordOnly,
        instanceInfo(c.env).topVenues,
      ),
      keywordOnly,
    ),
  });
});
publicApi.get("/papers/:id", async (c) => {
  const q = paperQuerySchema.parse(c.req.query());
  const paper = await readPaper(
    c.env.DB!,
    c.req.param("id"),
    q.day,
    true,
    q.source,
  );
  return paper
    ? apiJson(c, { success: true, data: publicPaper(paper) })
    : apiJson(
        c,
        {
          success: false,
          error: { code: "NOT_FOUND", message: "Paper not found" },
        },
        404,
      );
});
