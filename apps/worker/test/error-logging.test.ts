import { afterEach, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { AppEnv } from "../src/env";
import { workerEnv } from "./helpers/worker-env";
afterEach(() => vi.restoreAllMocks());
function expectPrivateLog(
  calls: readonly (readonly unknown[])[],
  pathname: string,
) {
  expect(calls).toHaveLength(1);
  expect(JSON.parse(String(calls[0]![0]))).toEqual({
    level: "error",
    message: "Request failed",
    context: {
      name: "TypeError",
      message: "synthetic operation failure",
      path: pathname,
    },
  });
  const output = JSON.stringify(calls);
  for (const value of [
    "synthetic-header",
    "synthetic-body",
    "synthetic-query",
    "Bearer ",
  ])
    expect(output).not.toContain(value);
}
it.each(["asset", "database"] as const)(
  "logs a %s failure without logging request headers, query or body",
  async (kind) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fail = () => {
      throw new TypeError("synthetic operation failure");
    };
    const env = {
      ...workerEnv().env,
      PUBLIC_URL: "https://worker.example",
      LOCAL_DEV: "true",
      ASSETS: { fetch: fail },
      DB: { prepare: fail },
    } as unknown as AppEnv;
    const pathname =
      kind === "asset" ? "/assets/broken.txt" : "/api/v1/ingest/papers";
    const request = new Request(
      "https://worker.example" + pathname + "?sensitive=synthetic-query",
      {
        method: kind === "asset" ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + "lsk_" + "A".repeat(52),
          "x-private": "synthetic-header",
        },
        ...(kind === "database"
          ? {
              body: JSON.stringify({
                papers: [],
                day: "2026-11-17",
                note: "synthetic-body",
              }),
            }
          : {}),
      },
    );
    const response = await app.fetch(request, env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
      },
    });
    expectPrivateLog(log.mock.calls, pathname);
  },
);
