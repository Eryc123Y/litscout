import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { SCHEMA_VERSION } from "@litscout/db";
import type { AppEnv } from "./env";
import { unavailable } from "./diagnostics";
import { isTrial, runtimeOf } from "./server-status";
declare const __GIT_SHA__: string;
export async function health(env: AppEnv) {
  let reachable = false;
  let schemaVersion: number | null = null;
  try {
    if (env.DB) {
      const db = drizzle(env.DB);
      await db.all(sql`SELECT 1`);
      reachable = true;
      schemaVersion =
        (
          await db.all<{ version: number }>(
            sql`SELECT version FROM litscout_schema LIMIT 1`,
          )
        )[0]?.version ?? 0;
    }
  } catch {
    reachable = false;
  }
  const ok = reachable && schemaVersion === SCHEMA_VERSION;
  if (!ok)
    unavailable("Health check: DB unavailable or schema version mismatch");
  return {
    ok,
    details: {
      version: "0.0.0",
      gitSha: typeof __GIT_SHA__ === "undefined" ? "development" : __GIT_SHA__,
      runtime: runtimeOf(env),
      ...(isTrial(env) ? { trial: true } : {}),
      database: { reachable, schemaVersion },
      bindings: {
        DB: Boolean(env.DB),
        OAUTH_KV: typeof env.OAUTH_KV?.get === "function",
      },
    },
  };
}
