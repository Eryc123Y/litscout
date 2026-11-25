import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { flowApi, type FlowDeps } from "../src/flow-runtime";
const usage = {
  day: "2026-11-17",
  used: 53000,
  reserved: 0,
  staleLeasesReleased: 0,
  limit: 80000,
  resetAt: "2026-11-18T00:00:00.000Z",
};
it.each([
  JSON.stringify({ day: "2026-11-17", rows: 80000, reserved: 31318 }),
  "damaged cache",
])(
  "R2 healthy server overrides stale or damaged local cache: %s",
  async (cached) => {
    const dir = await mkdtemp(path.join(tmpdir(), "litscout-server-budget-"));
    try {
      const file = path.join(dir, "write-budget.json");
      await writeFile(file, cached);
      const calls: string[] = [];
      const fetcher = vi.fn(async (url, init) => {
        const route = new URL(String(url)).pathname;
        calls.push(`${init.method} ${route}`);
        return route.endsWith("/budget")
          ? Response.json({ success: true, data: usage })
          : Response.json({
              success: true,
              data: {},
              meta: { rowsWritten: 5 },
            });
      });
      const api = await flowApi(
        {
          dir,
          fetch: fetcher,
          flow: { token: "synthetic", now: () => new Date(usage.day) },
        } as unknown as FlowDeps,
        defineConfig({ instance: { publicUrl: "https://local" } }),
      );
      await api.write(
        "/ingest/feed-day",
        { day: usage.day, status: "crawled" },
        10,
      );
      await api.write(
        "/ingest/feed-day",
        { day: usage.day, status: "crawled" },
        10,
      );
      expect(calls).toEqual([
        "GET /api/v1/budget",
        "POST /api/v1/ingest/feed-day",
        "POST /api/v1/ingest/feed-day",
      ]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(usage);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
it("R2 an offline run reports a labelled cached answer and sends no writes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-offline-budget-"));
  try {
    await writeFile(path.join(dir, "write-budget.json"), JSON.stringify(usage));
    const fetcher = vi.fn(async () => {
      throw new Error("private upstream diagnostic");
    });
    const api = await flowApi(
      {
        dir,
        fetch: fetcher,
        flow: { token: "synthetic", sleep: async () => {} },
      } as unknown as FlowDeps,
      defineConfig({ instance: { publicUrl: "https://local" } }),
    );
    await expect(api.write("/ingest/feed-day", {}, 10)).rejects.toThrow(
      "Last cached budget (may be stale): 2026-11-17, used 53000",
    );
    expect(fetcher.mock.calls).toHaveLength(3);
    expect(await readFile(path.join(dir, "write-budget.json"), "utf8")).toBe(
      JSON.stringify(usage),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
