import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import type { FlowDeps } from "../src/flow-runtime";
const day = "2026-11-16";
async function harness(days: unknown[], body = "") {
  const dir = await mkdtemp(join(tmpdir(), "litscout-hot-cli-"));
  await writeFile(join(dir, "project-brief.md"), body);
  const lines: string[] = [];
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      const path = new URL(String(input)).pathname;
      const data = path.endsWith("/feed/days")
        ? days
        : path.includes("/full")
          ? {
              day,
              status: "summarised",
              counts: { arxiv: 0 },
              items: [],
              nextCursor: null,
            }
          : path.includes("/operations")
            ? { ratings: [], radar: [], missed: [], runs: [] }
            : null;
      return Response.json({
        success: true,
        data,
        meta: { authRowsWritten: 0 },
      });
    },
  );
  const config = defineConfig({
    instance: { publicUrl: "https://local" },
    digest: { briefFiles: ["project-brief.md"] },
  });
  const deps = {
    dir,
    cwd: dir,
    fetch: fetcher,
    loadConfig: async () => config,
    print: (s: string) => lines.push(s),
    flow: { token: "synthetic", now: () => new Date(day) },
  } as unknown as FlowDeps;
  return {
    dir,
    fetcher,
    async command(...args: string[]) {
      lines.length = 0;
      const code = await runCommand([...args, "--json"], deps);
      return { code, result: JSON.parse(lines.at(-1)!) };
    },
  };
}
it.each([{ days: [{ day, status: "crawled" }] }, { days: [] }])(
  "H3 daily status keeps data as an array: %j",
  async ({ days }) => {
    const h = await harness(days);
    try {
      const result = await h.command("daily", "status");
      expect(result.code).toBe(0);
      expect(Array.isArray(result.result.data)).toBe(true);
      expect(result.result.data).toHaveLength(days.length);
      expect(Object.keys(result.result.data)).toEqual(days.length ? ["0"] : []);
    } finally {
      await rm(h.dir, { recursive: true, force: true });
    }
  },
);
it("H4 reads a 20000-character local brief without uploading it", async () => {
  const body = "Private local research context. ".repeat(700).slice(0, 20000),
    h = await harness([], body);
  try {
    const result = await h.command("digest", "context", "--day", day);
    expect(result.code, JSON.stringify(result.result)).toBe(0);
    expect(result.result.data.briefs).toEqual([
      { path: "project-brief.md", body },
    ]);
    expect(result.result.data.ingest).toMatchObject({
      requests: [],
      retries: 0,
      failures: [],
    });
    expect(
      h.fetcher.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
    expect(
      h.fetcher.mock.calls.every(([, init]) => init?.body === undefined),
    ).toBe(true);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});
