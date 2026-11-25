import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  backupPaperBatchSchema,
  backupSectionSchema,
} from "@litscout/pipeline/backup-contracts";
import {
  backupKeyWidth,
  readBackupCounts,
  readBackupPapers,
  readBackupSection,
} from "@litscout/db/backup";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { unavailable } from "./diagnostics";
import { allowLimitedRequest, backupCooldownOff } from "./auth/request-limit";
import { instanceInfo } from "./public-feed";

export const backupApi = new Hono<WorkerBindings>();
backupApi.get("/backup", async (c) => {
  const db = c.env.DB;
  if (!db) return unavailable("Export: DB binding missing");
  if (c.req.method === "HEAD") return apiJson(c, { success: true });
  const site = c.req.header("Sec-Fetch-Site");
  const origin = c.req.header("Origin");
  const token = c.get("apiToken");
  if (
    (site !== "same-origin" && !(site === undefined && token)) ||
    (origin !== undefined && origin !== new URL(c.req.url).origin)
  )
    return apiJson(
      c,
      {
        success: false,
        error: {
          code: "FORBIDDEN",
          message: "Start the export from this origin.",
        },
      },
      403,
    );
  const bucket = token ? `token:${token.id}` : "owner";
  const limit = backupCooldownOff(c.env)
    ? { allowed: true, retryAfter: 0 }
    : await allowLimitedRequest(c.env, `backup:${bucket}`, 1, 600);
  if (!limit.allowed) {
    c.header("Retry-After", String(limit.retryAfter));
    return apiJson(
      c,
      {
        success: false,
        error: {
          code: "BACKUP_COOLDOWN",
          message: `An export recently started. Try again in ${limit.retryAfter} seconds.`,
        },
      },
      429,
    );
  }
  const instance = instanceInfo(c.env);
  const configuredTopics = instance.topics.map((name) => ({
    name,
    keywords: [],
  }));
  return apiJson(c, {
    success: true,
    data: {
      instanceName: instance.name,
      expectedCounts: {
        ...(await readBackupCounts(db)),
        configuredTopics: configuredTopics.length,
      },
      configuredTopics,
    },
  });
});
async function paperPage(c: Context<WorkerBindings>, input: unknown) {
  const db = c.env.DB;
  if (!db) return unavailable("Export: DB binding missing");
  const batch = backupPaperBatchSchema.parse(input);
  return apiJson(c, { success: true, data: await readBackupPapers(db, batch) });
}
backupApi.get("/backup/papers", (c) =>
  paperPage(c, JSON.parse(z.string().max(4096).parse(c.req.query("include")))),
);
// A stored identifier can be too large for a URL when percent-encoded.
backupApi.post("/backup/papers", async (c) => paperPage(c, await c.req.json()));
backupApi.get("/backup/:section", async (c) => {
  const db = c.env.DB;
  if (!db) return unavailable("Export: DB binding missing");
  const section = backupSectionSchema.parse(c.req.param("section"));
  const raw = z.string().max(2048).optional().parse(c.req.query("after"));
  const after =
    raw === undefined
      ? undefined
      : z
          .array(z.string().max(512))
          .length(backupKeyWidth(section))
          .parse(JSON.parse(raw));
  return apiJson(c, {
    success: true,
    data: await readBackupSection(db, section, after),
  });
});
