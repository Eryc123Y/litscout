import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand, type SetupDeps } from "../src/setup-commands";

it("opens and finishes one run through the CLI without sending free-form diagnostics", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-run-test-"));
  try {
    const prints: string[] = [],
      reports: unknown[] = [];
    const day = "2026-11-19";
    const now = new Date(day + "T02:20:00.000Z");
    const deps = {
      cwd: dir,
      dir,
      flow: { token: "lsk_" + "I".repeat(52), now: () => now },
      loadConfig: async () =>
        defineConfig({ instance: { publicUrl: "https://local.invalid" } }),
      fetch: vi.fn(async (url: URL, init?: RequestInit) => {
        if (url.pathname === "/api/v1/budget")
          return Response.json({
            success: true,
            data: {
              day,
              limit: 80000,
              used: 0,
              reserved: 0,
              staleLeasesReleased: 0,
              resetAt: "2026-11-20T00:00:00.000Z",
            },
          });
        expect(url.pathname).toBe("/api/v1/ingest/daily-run");
        const report = JSON.parse(String(init?.body));
        reports.push(report);
        return Response.json({
          success: true,
          data: { id: report.id },
          meta: { rowsWritten: 1 },
        });
      }),
      print: (line: string) => prints.push(line),
    } as unknown as SetupDeps;
    expect(await runCommand(["daily", "start", "--json"], deps)).toBe(0);
    const { id, startedAt, targetDay } = JSON.parse(prints.at(-1)!).data;
    const start = { id, startedAt, targetDay };
    expect(start).toMatchObject({
      startedAt: now.toISOString(),
      targetDay: day,
    });
    expect(JSON.parse(prints.at(-1)!).data.ingest.rowsWritten).toBe(1);
    expect(reports).toEqual([start]);

    const report = {
      ...start,
      targetDay: "2026-11-18",
      rowsWritten: null,
      steps: {
        fetch: { status: "done" },
        summaries: { status: "done", fallback: true, client: "codex" },
        digest: { status: "done" },
        sync: { status: "failed", error: "operation-failed" },
        legacy: { status: "skipped" },
      },
    };
    const file = path.join(dir, "report.json");
    await writeFile(
      file,
      JSON.stringify({ ...report, error: "private diagnostic" }),
    );
    expect(await runCommand(["daily", "report", file, "--json"], deps)).toBe(1);
    expect(reports).toHaveLength(1);
    await writeFile(file, JSON.stringify(report));
    now.setUTCMinutes(30);
    expect(await runCommand(["daily", "report", file, "--json"], deps)).toBe(0);
    expect(reports).toEqual([
      start,
      { ...report, finishedAt: now.toISOString() },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
