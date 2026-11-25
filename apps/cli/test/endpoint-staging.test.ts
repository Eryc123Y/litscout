import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import { endpointConfig } from "../src/endpoint";
import { doctorResponse } from "./helpers/doctor";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function harness(publicUrl?: string, endpoint?: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-endpoint-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "vault"));
  if (endpoint)
    await writeFile(
      path.join(dir, "state.json"),
      JSON.stringify({
        name: "sample",
        token: "synthetic-management-value",
        endpoint,
      }),
    );
  const out: string[] = [],
    fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/feed/days")
        ? Response.json({ success: true, data: [] })
        : doctorResponse(input),
    );
  const deps = {
    dir,
    cwd: dir,
    isTTY: false,
    templateDir: "templates/self-host",
    bundlePath: "unused",
    nodeVersion: "22.13.0",
    env: {},
    flow: {
      preflight: async (
        client: import("@litscout/pipeline/agents").Client,
      ) => ({ client, usable: true, reason: "fake" }),
      token: "synthetic-api-value",
    },
    loadConfig: async () =>
      defineConfig({
        instance: { name: "sample", ...(publicUrl ? { publicUrl } : {}) },
      }),
    fetch,
    fetchVenues: vi.fn(),
    prompt: vi.fn(),
    print: (line: string) => out.push(line),
    run: vi.fn(async (args: readonly string[]) =>
      args[0] === "--version"
        ? "4.151.0"
        : args[0] === "whoami"
          ? "logged in"
          : args[1] === "info"
            ? "{}"
            : '[{"results":[]}]',
    ),
  };
  return { deps, out, fetch };
}
it("T4 feed commands use the endpoint deploy stored when config has no publicUrl", async () => {
  const h = await harness(undefined, "https://recorded-deployment.example");
  expect(await runCommand(["daily", "status", "--json"], h.deps)).toBe(0);
  expect(String(h.fetch.mock.calls[0]![0])).toContain(
    "https://recorded-deployment.example/api/v1/feed/days",
  );
});
it("T4 an explicit config URL wins and doctor reports the selected URL/source", async () => {
  const h = await harness(
    "https://explicit.example",
    "https://recorded-deployment.example",
  );
  expect(await runCommand(["doctor", "--json"], h.deps)).toBe(0);
  expect(JSON.parse(h.out.at(-1)!)).toMatchObject({
    data: { publicUrl: "https://explicit.example", publicUrlSource: "config" },
  });
  const saved = await harness(undefined, "https://recorded-deployment.example");
  expect(await runCommand(["doctor", "--json"], saved.deps)).toBe(0);
  expect(JSON.parse(saved.out.at(-1)!)).toMatchObject({
    data: {
      publicUrl: "https://recorded-deployment.example",
      publicUrlSource: "deployment",
    },
  });
});
it("defaults the browser origin to the recorded deploy URL without replacing a configured browser host", async () => {
  const endpoint = "https://recorded-deployment.example";
  const webUrl = "https://browser.example";
  const { deps } = await harness(undefined, endpoint);
  for (const configured of [undefined, webUrl]) {
    const { config } = await endpointConfig(
      defineConfig({ instance: { webUrl: configured } }),
      deps.dir,
    );
    expect(config.instance).toMatchObject({
      publicUrl: endpoint,
      webUrl: configured ?? endpoint,
    });
  }
});
it("T4 doctor warns without either URL and makes no health request", async () => {
  const h = await harness();
  await runCommand(["doctor", "--json"], h.deps);
  expect(JSON.parse(h.out.at(-1)!)).toMatchObject({
    data: {
      publicUrl: null,
      publicUrlSource: "none",
      warnings: expect.arrayContaining([
        expect.stringMatching(/publicUrl|public URL/i),
      ]),
    },
  });
  expect(h.fetch).not.toHaveBeenCalled();
});

it("T1 default fetch day is UTC after midnight in the configured timezone", async () => {
  const h = await harness("https://explicit.example"),
    crawl = vi.fn(async (_day: string) => ({
      days: {},
      gaps: [],
      cursor: null,
    }));
  const fetch = vi.fn(async (input: RequestInfo | URL) =>
    Response.json({
      success: true,
      data: String(input).endsWith("/budget")
        ? {
            day: "2026-11-17",
            used: 0,
            reserved: 0,
            staleLeasesReleased: 0,
            limit: 80000,
            resetAt: "2026-11-18T00:00:00.000Z",
          }
        : String(input).includes("/sync/cursors")
          ? null
          : String(input).includes("/feed/days")
            ? []
            : {},
      meta: { rowsWritten: 0 },
    }),
  );
  expect(
    await runCommand(["daily", "fetch", "--json"], {
      ...h.deps,
      fetch,
      loadConfig: async () =>
        defineConfig({
          instance: { publicUrl: "https://explicit.example" },
          agent: { mode: "none" },
        }),
      flow: {
        ...h.deps.flow,
        now: () => new Date("2026-11-17T20:30:00Z"),
        crawl,
      },
    }),
  ).toBe(0);
  expect(crawl.mock.calls[0]![0]).toBe("2026-11-17");
  expect(JSON.parse(h.out.at(-1)!).data).toMatchObject({
    summaryStatus: "skipped-no-llm",
    digestStatus: "skipped-no-llm",
  });
});
