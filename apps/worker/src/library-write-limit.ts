import { z } from "zod";
import type { MiddlewareHandler } from "hono";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";
import { allowLimitedRequest } from "./auth/request-limit";
import type { AppEnv } from "./env";

// Per-instance daily caps stop runaway clients; the D1 write budget is the
// real cost guard. Activity includes opening and rating papers, so a heavy
// reading day must fit comfortably.
const writeCaps = {
  save: { perMinute: 20, perDay: 200 },
  activity: { perMinute: 60, perDay: 2000 },
};
type WriteKind = keyof typeof writeCaps;
const dailyCap = z.coerce.number().int().min(1).max(5000);
/**
 * Instance-wide daily caps. LIBRARY_DAILY_CAPS ("save:200,activity:2000")
 * overrides them; invalid parts keep the defaults.
 */
export function dailyCaps(env: Pick<AppEnv, "LIBRARY_DAILY_CAPS">) {
  const caps = {
    save: writeCaps.save.perDay,
    activity: writeCaps.activity.perDay,
  };
  for (const part of (env.LIBRARY_DAILY_CAPS ?? "").split(",")) {
    const [kind, value] = part.split(":").map((item) => item.trim());
    const parsed = dailyCap.safeParse(value);
    if ((kind === "save" || kind === "activity") && parsed.success)
      caps[kind] = parsed.data;
  }
  return caps;
}

export async function allowLibraryWrite(
  env: AppEnv,
  identity: string,
  kind: WriteKind,
) {
  const cap = writeCaps[kind];
  const perDay = dailyCaps(env)[kind];
  const perIdentity = await allowLimitedRequest(
    env,
    `library:${kind}:${identity}`,
    cap.perMinute,
  );
  if (!perIdentity.allowed) return perIdentity;
  return allowLimitedRequest(
    env,
    `library:${kind}:instance`,
    perDay,
    "utc-day",
  );
}

function libraryWriteKind(path: string, method: string): WriteKind | null {
  if (method === "POST") {
    if (["/api/v1/library", "/api/v1/library/save"].includes(path))
      return "save";
    if (
      ["/api/v1/events", "/api/v1/notes", "/api/v1/vault/requests"].includes(
        path,
      ) ||
      /^\/api\/v1\/suggestions\/[^/]+\/(?:accept|dismiss)$/.test(path)
    )
      return "activity";
  }
  if (
    ["PATCH", "DELETE"].includes(method) &&
    /^\/api\/v1\/(?:library|notes|vault\/requests)\/[^/]+$/.test(path)
  )
    return "activity";
  return null;
}

export const limitLibraryWrites: MiddlewareHandler<WorkerBindings> = async (
  c,
  next,
) => {
  const { path, method } = c.req;
  const kind = libraryWriteKind(path, method);
  if (!kind) return next();
  const token = c.get("apiToken");
  const result = await allowLibraryWrite(
    c.env,
    token ? `token:${token.id}` : "owner",
    kind,
  );
  if (result.allowed) return next();
  c.header("Retry-After", String(result.retryAfter));
  return apiJson(
    c,
    {
      success: false,
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    },
    429,
  );
};
