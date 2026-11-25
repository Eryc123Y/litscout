import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { WorkerBindings } from "./api-auth";
export type ApiPayload = {
  success: boolean;
  data?: unknown;
  error?: unknown;
  meta?: Record<string, unknown>;
};
/** Defer serialization until token and lease accounting have completed. */
export function apiJson(
  c: Context<WorkerBindings>,
  body: ApiPayload,
  status: ContentfulStatusCode = 200,
) {
  if (!c.req.path.startsWith("/api/v1/")) return c.json(body, status);
  c.set("apiPayload", { body, status });
  c.header("Content-Type", "application/json");
  return c.newResponse(null, status);
}
export const finalizeApiJson: MiddlewareHandler<WorkerBindings> = async (
  c,
  next,
) => {
  await next();
  const skipAuth =
    c.req.path.startsWith("/api/v1/public/") ||
    (c.req.path === "/api/v1/instance" &&
      !c.get("tokenScopes")?.includes("read"));
  const auth = skipAuth ? undefined : c.get("authRowsWritten"),
    budget = c.get("budgetRowsWritten");
  const saved = c.get("apiPayload");
  let body: ApiPayload;
  if (saved && saved.status === c.res.status) body = saved.body;
  else {
    if (
      (auth === undefined && budget === undefined) ||
      !c.res.headers.get("content-type")?.includes("application/json")
    )
      return;
    // Framework/configuration errors can supply their own small JSON response.
    body = (await c.res.json()) as ApiPayload;
  }
  const meta = {
    ...body.meta,
    ...(auth === undefined ? {} : { authRowsWritten: auth }),
    ...(budget === undefined ? {} : { budgetRowsWritten: budget }),
  };
  c.res = new Response(
    JSON.stringify({ ...body, ...(Object.keys(meta).length ? { meta } : {}) }),
    { status: c.res.status, headers: c.res.headers },
  );
};
