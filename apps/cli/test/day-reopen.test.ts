import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";

const day = "2026-11-18";
const args = ["day", "reopen", day];
const plan = {
  day,
  oldStatus: "final",
  newStatus: "crawled",
  digests: [{ lang: "en" }, { lang: "zh" }],
  changed: true,
};

function harness(dir: string, isTTY = false) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.method).toBe("POST");
    expect(url.pathname).toBe(`/api/v1/days/${day}/reopen`);
    expect(url.hostname).toBe("instance.example");
    return Response.json({
      success: true,
      data: { ...plan, dryRun: url.searchParams.get("dryRun") === "1" },
    });
  });
  const print = vi.fn<(text: string) => void>();
  const prompt = vi.fn<(label: string) => Promise<string>>();
  const deps: SetupDeps = {
    cwd: dir,
    dir,
    templateDir: dir,
    bundlePath: "unused",
    isTTY,
    fetch,
    print,
    prompt,
    run: vi.fn(),
    fetchVenues: vi.fn(),
    loadConfig: async () =>
      defineConfig({ instance: { publicUrl: "https://instance.example" } }),
    flow: { token: "lsk_" + "W".repeat(52) },
  };
  return { deps, fetch, print, prompt };
}

it("prints a JSON preview and requires --yes to apply noninteractively", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-reopen-"));
  try {
    const { deps, fetch, print, prompt } = harness(dir);
    expect(await runCommand([...args, "--json"], deps)).toBe(1);
    expect(print.mock.lastCall?.[0]).toContain("--yes");
    expect(fetch).not.toHaveBeenCalled();
    expect(await runCommand([...args, "--dry-run", "--json"], deps)).toBe(0);
    expect(JSON.parse(print.mock.lastCall![0])).toMatchObject({
      success: true,
      data: { ...plan, dryRun: true },
    });
    expect(await runCommand([...args, "--yes"], deps)).toBe(0);
    expect(print.mock.lastCall?.[0]).toContain("final");
    expect(print.mock.lastCall?.[0]).toContain("en, zh");
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).search),
    ).toEqual(["?dryRun=1", ""]);
    expect(prompt).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("shows the plan before asking and only applies after explicit terminal confirmation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-reopen-"));
  try {
    const { deps, fetch, print, prompt } = harness(dir, true);
    prompt.mockResolvedValueOnce("").mockResolvedValueOnce("yes");
    expect(await runCommand([...args, "--json"], deps)).toBe(2);
    expect(prompt.mock.lastCall?.[0]).toContain("en, zh");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(print.mock.lastCall![0])).toMatchObject({
      data: { ...plan, dryRun: true, cancelled: true },
    });
    expect(await runCommand([...args, "--json"], deps)).toBe(0);
    expect(
      fetch.mock.calls.map(([url]) => new URL(String(url)).search),
    ).toEqual(["?dryRun=1", "?dryRun=1", ""]);
    expect(JSON.parse(print.mock.lastCall![0])).toMatchObject({
      data: { ...plan, dryRun: false },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
