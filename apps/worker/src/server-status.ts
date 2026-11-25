import { Hono } from "hono";
import {
  serverStatusPath,
  serverStatusSchema,
  type Runtime,
  type ServerStatus,
} from "@litscout/pipeline/server-contracts";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { unavailable } from "./diagnostics";
import type { AppEnv } from "./env";

/** The sync cursor that holds the own server's newest report. */
export const serverStatusCursor = "server-status";

export const runtimeOf = (env: AppEnv): Runtime =>
  env.LITSCOUT_RUNTIME === "server" ? "server" : "cloudflare";
/** A trial on the reader's own computer: an own server with no sign-in,
 * reachable from that computer only. On Cloudflare the switch does nothing. */
export const isTrial = (
  env: Pick<AppEnv, "LITSCOUT_RUNTIME" | "LOCAL_OWNER">,
) => env.LITSCOUT_RUNTIME === "server" && env.LOCAL_OWNER === "true";

/** A stored report, or null when there is none or it no longer parses. */
export function parseServerStatus(
  value: string | null | undefined,
): ServerStatus | null {
  if (!value) return null;
  try {
    const parsed = serverStatusSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function readServerStatus(db: D1Database) {
  const row = await db
    .prepare("SELECT value FROM sync_cursors WHERE name=?")
    .bind(serverStatusCursor)
    .first<{ value: string }>();
  return parseServerStatus(row?.value);
}

export const serverStatusApi = new Hono<WorkerBindings>();
serverStatusApi.put(serverStatusPath, async (c) => {
  if (!c.env.DB) return unavailable("Server status: DB binding missing");
  const status = serverStatusSchema.parse(c.get("ingestBody"));
  await c.env.DB.prepare(
    `INSERT INTO sync_cursors(name,value,updated_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  )
    .bind(serverStatusCursor, JSON.stringify(status))
    .run();
  return apiJson(c, { success: true, data: { stored: true } });
});
