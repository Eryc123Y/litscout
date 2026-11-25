import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";
import { doctorResponse } from "./helpers/doctor";
it("F5/A4 budget and doctor display recovered server usage and the same client checks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-budget-command-"));
  try {
    const budget = {
        day: "2026-11-17",
        used: 52000,
        reserved: 0,
        migration: 25990,
        staleLeasesReleased: 3,
        limit: 80000,
        resetAt: "2026-11-18T00:00:00.000Z",
      },
      out: string[] = [];
    const check = vi.fn(async (client) => ({
      client,
      usable: true,
      reason: "fake",
    }));
    await mkdir(path.join(dir, "vault"));
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      doctorResponse(url, budget),
    );
    const deps = {
      dir,
      cwd: dir,
      nodeVersion: "22.13.0",
      flow: { token: "synthetic", preflight: check },
      fetch: fetcher,
      run: vi.fn(async (args: readonly string[]) =>
        args[0] === "--version"
          ? "4.151.0"
          : args[0] === "whoami"
            ? "Authenticated"
            : "{}",
      ),
      print: (s: string) => out.push(s),
      loadConfig: async () =>
        defineConfig({ instance: { publicUrl: "https://local" } }),
    } as unknown as SetupDeps;
    for (const command of ["budget", "doctor"]) {
      expect(await runCommand([command, "--json"], deps)).toBe(0);
      const data = JSON.parse(out.at(-1)!).data;
      expect(command === "budget" ? data : data.budget).toMatchObject(budget);
      if (command === "doctor") expect(data.agentChecks).toHaveLength(3);
    }
    expect(check).toHaveBeenCalledTimes(3);
    expect(await runCommand(["budget"], deps)).toBe(0);
    expect(out.at(-1)).toContain("Migration: 25990 writes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
