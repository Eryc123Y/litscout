import { expect, it } from "vitest";
import { app } from "../src/app";
it.each([
  ["papers", 40],
  ["summaries", 50],
  ["radar", 40],
  ["legacy", 40],
] as const)(
  "F2 rejects oversized %s arrays before validation or D1",
  async (kind, cap) => {
    const body =
      kind === "legacy"
        ? { runs: Array(21).fill(null), ratings: Array(20).fill(null) }
        : { [kind]: Array(cap + 1).fill(null) };
    const r = await app.request(
      `/api/v1/ingest/${kind}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { LOCAL_DEV: "true" },
    );
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: expect.stringContaining(String(cap)),
      },
    });
  },
);
it.each(["/ingest/papers", "/ingest/feed-day", "/digests/2026-11-17"])(
  "F2 bounds %s actual bytes without trusting content-length",
  async (route) => {
    const r = await app.request(
      `/api/v1${route}`,
      {
        method: route.startsWith("/digests") ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "中".repeat(180000) }),
      },
      { LOCAL_DEV: "true" },
    );
    expect(r.status).toBe(413);
  },
);
