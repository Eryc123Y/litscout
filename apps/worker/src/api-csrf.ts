import type { MiddlewareHandler } from "hono";
import type { WorkerBindings } from "./api-auth";
import { apiJson } from "./api-response";

export const requireSameOriginJson: MiddlewareHandler<WorkerBindings> = async (
  c,
  next,
) => {
  if (
    ["GET", "HEAD"].includes(c.req.method) ||
    c.req.header("Authorization") !== undefined
  )
    return next();
  const site = c.req.header("Sec-Fetch-Site");
  const origin = c.req.header("Origin");
  // Some non-browser fetch clients send Sec-Fetch-Mode but omit Origin and Site.
  const nonBrowser = site === undefined && origin === undefined;
  const type = c.req
    .header("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    (site === "same-origin" || nonBrowser) &&
    (origin === undefined || origin === new URL(c.req.url).origin) &&
    type === "application/json"
  )
    return next();
  return apiJson(
    c,
    {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "Access-authenticated writes require same-origin JSON.",
      },
    },
    403,
  );
};
