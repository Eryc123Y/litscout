import path from "node:path";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { doctorCommand } from "../src/doctor-command";
import { legacyCommand } from "../src/legacy-command";
import type { SetupDeps } from "../src/command-types";
import type { FlowDeps } from "../src/flow-runtime";
import { doctorResponse } from "./helpers/doctor";

const publicUrl = "https://worker.example";

it("reports the configured legacy window, a missing repository and a finished window", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-doctor-legacy-"));
  try {
    const deps = {
      cwd: dir,
      dir,
      run: vi.fn(async ([command]) =>
        command === "--version" ? "4.151.0" : "Not logged in",
      ),
      flow: { token: "fixture", preflight: async () => ({ usable: true }) },
      fetch: async (input: URL) => doctorResponse(input),
    } as unknown as SetupDeps;
    const doctor = (legacy?: { repo: string; from: string; to: string }) =>
      doctorCommand(
        deps,
        defineConfig({ instance: { publicUrl }, ...(legacy && { legacy }) }),
        "fixture",
      );
    expect((await doctor()).data.checks.legacy).toEqual({
      ok: true,
      configured: false,
    });

    const window = { repo: "legacy", from: "2026-11-16", to: "2026-11-16" };
    const missing = await doctor(window);
    expect(missing.failed).toBe(true);
    expect(missing.data.checks.legacy).toMatchObject({
      ok: false,
      configured: true,
      hint: expect.stringContaining("legacy.repo"),
    });

    await mkdir(path.join(dir, "legacy"));
    expect((await doctor(window)).data.checks.legacy).toEqual({
      ok: true,
      configured: true,
      from: "2026-11-16",
      to: "2026-11-16",
      done: false,
    });
    // Doctor only looks: it creates no resume folder.
    expect(await readdir(dir)).not.toContain("resume");

    const flowDeps = {
      ...deps,
      flow: {
        token: "fixture",
        now: () => new Date("2026-11-19T03:30:00Z"),
        git: async (_repo: string, args: readonly string[]) =>
          args[0] === "ls-tree"
            ? "data/2026-11-16.jsonl"
            : args[0] === "show"
              ? JSON.stringify({ id: "2611.00013", title: "Fixture paper" })
              : "fixture",
      },
    } as unknown as FlowDeps;
    const write = vi.fn(async (route: string, body: unknown) =>
      route === "/ingest/papers"
        ? {
            papers: (body as { papers: { key: string }[] }).papers.map(
              ({ key }) => ({ key, paperId: "pap_fixture" }),
            ),
          }
        : {},
    );
    const api = { get: async () => null, planRows: () => 10, write };
    await expect(
      legacyCommand(
        ["--max-rows", "500"],
        flowDeps,
        api,
        [],
        publicUrl,
        window,
      ),
    ).resolves.toMatchObject({ status: "done" });
    expect((await doctor(window)).data.checks.legacy).toMatchObject({
      ok: true,
      done: true,
    });
    // A finished window stays finished after the source moves away.
    await rm(path.join(dir, "legacy"), { recursive: true });
    expect((await doctor(window)).data.checks.legacy).toMatchObject({
      ok: true,
      done: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
