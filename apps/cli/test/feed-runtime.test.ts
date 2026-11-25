import { mkdtemp, writeFile, readFile, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { hostname, tmpdir, uptime } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import {
  agentRunner,
  flowApi,
  withFlowLock,
  type FlowDeps,
} from "../src/flow-runtime";
import { flowOptions } from "../src/flow-options";
import { sourceCrawl } from "../src/source-crawl";
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  uptime: () => 7200,
}));
const directories: string[] = [];
const temporary = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-runtime-"));
  directories.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
it("rejects malformed options before running any client", () => {
  for (const args of [
    ["--unknown"],
    ["--day"],
    ["--day", "--client"],
    ["--day", "a", "--day", "b"],
  ])
    expect(() => flowOptions(args, ["day"])).toThrow();
  expect(flowOptions(["file", "--dry-run"], ["dry-run"])).toEqual({
    values: { "dry-run": "true" },
    positional: ["file"],
  });
});
it("locks all write commands, removes expired locks and always releases after failure", async () => {
  const dir = await temporary(),
    deps = { dir } as FlowDeps;
  await withFlowLock(deps, async () => {
    await expect(withFlowLock(deps, async () => {})).rejects.toThrow(
      "Another feed command",
    );
  });
  await writeFile(path.join(dir, "feed.lock"), "old");
  await utimes(path.join(dir, "feed.lock"), new Date(0), new Date(0));
  await expect(
    withFlowLock(deps, async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow("failure");
  await expect(readFile(path.join(dir, "feed.lock"))).rejects.toHaveProperty(
    "code",
    "ENOENT",
  );
});
it("reads matching credentials, caches server answers and ignores damaged local caches", async () => {
  const dir = await temporary(),
    config = defineConfig({ instance: { publicUrl: "http://127.0.0.1" } });
  await writeFile(
    path.join(dir, "credentials.json"),
    JSON.stringify({
      tokens: [{ token: "synthetic", url: "http://127.0.0.1" }],
    }),
  );
  const usage = {
    day: "2026-11-17",
    used: 53000,
    reserved: 0,
    staleLeasesReleased: 0,
    limit: 80000,
    resetAt: "2026-11-18T00:00:00.000Z",
  };
  const impl = vi.fn(async (url) =>
    Response.json({
      success: true,
      data: String(url).endsWith("/budget") ? usage : [],
      meta: { authRowsWritten: 1 },
    }),
  );
  const deps = {
    dir,
    fetch: impl,
    flow: {
      preflight: async (
        client: import("@litscout/pipeline/agents").Client,
      ) => ({ client, usable: true, reason: "fake" }),
      now: () => new Date("2026-11-17"),
    },
  } as unknown as FlowDeps;
  const api = await flowApi(deps, config);
  await api.get("/budget");
  await api.get("/feed/days");
  expect(
    JSON.parse(await readFile(path.join(dir, "write-budget.json"), "utf8")),
  ).toEqual(usage);
  await writeFile(path.join(dir, "write-budget.json"), "broken");
  await expect(flowApi(deps, config)).resolves.toBeDefined();
  await expect(flowApi(deps, defineConfig({}))).rejects.toThrow("publicUrl");
  await rm(path.join(dir, "write-budget.json"));
  await expect(
    flowApi(deps, defineConfig({ instance: { publicUrl: "https://other" } })),
  ).rejects.toThrow("No valid local token");
});
it("exercises the stdout subprocess adapter with a Node stand-in", async () => {
  const dir = await temporary(),
    deps = { dir } as FlowDeps;
  const options = {
    client: "cmd" as const,
    lang: "en" as const,
    parallel: 1,
    maxChunks: 1,
  };
  const run = agentRunner(deps, "2026-11-17", options);
  const script =
    'process.stdout.write("=== pap_fixture\\ntldr: One\\nmotivation: Two\\nmethod: Three\\nresult: Four\\nconclusion: Five\\n");';
  const papers = [
    { paperId: "pap_fixture", title: "Fixture", abstract: "Abstract" },
  ];
  const answer = await run(
    [process.execPath, "-e", script, "{chunkPrompt}"],
    papers,
    0,
    0,
  );
  expect(answer.code).toBe(0);
  expect(answer.text).toContain("=== pap_fixture");
  expect(
    (await run([process.execPath, "-e", "process.exit(1)"], papers, 1, 0)).code,
  ).toBe(1);
});
it("backfills recorded recent listings via batched Atom abstracts and leaves older gaps explicit", async () => {
  const dir = await temporary();
  await writeFile(path.join(dir, "venues.json"), '{"venues":[]}');
  const html = await readFile(
    "packages/sources/test/fixtures/listings/arxiv_recent_cs_CV.html",
    "utf8",
  );
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/recent")) return new Response(html);
    const ids = url.searchParams.get("id_list")!.split(",");
    return new Response(
      `<feed>${ids.map((id) => `<entry><id>http://arxiv.org/abs/${id}v1</id><summary>Abstract</summary></entry>`).join("")}</feed>`,
    );
  });
  const config = defineConfig({
    sources: {
      arxiv: { categories: ["cs.CV"] },
      huggingface: { dailyPapers: false },
    },
  });
  const crawl = sourceCrawl(config, {
    cwd: dir,
    dir,
    env: {},
    fetch: impl as typeof fetch,
    now: () => new Date("2026-11-09"),
    sleep: async () => {},
    warn: () => {},
  });
  const found = await crawl("2026-11-06", ["2026-10-30"], null, [], {
    listingDate: "2026-10-30",
    runDay: "2026-10-30",
  });
  expect(found.days["2026-11-06"]!.length).toBeGreaterThan(0);
  expect(found.gaps).toContain("2026-11-02");
});
it("crawls a real-shaped venue watchlist, filters topic-only venues and keeps source failures independent", async () => {
  const dir = await temporary();
  await writeFile(
    path.join(dir, "venues.json"),
    JSON.stringify({
      venues: [
        {
          name: "Journal",
          kind: "journal",
          issn: ["1234-5678"],
          match: "topics",
        },
      ],
    }),
  );
  const config = defineConfig({
    sources: { arxiv: { categories: [] }, huggingface: { dailyPapers: false } },
    topics: [{ name: "Vision", keywords: ["stereo"] }],
  });
  const item = (n: number, title: string) => ({
    DOI: `10.1234/crawl${n}`,
    title: [title],
    author: [{ given: "Ada", family: "Lovelace" }],
    created: { "date-parts": [[2026, 11, 11]] },
    published: { "date-parts": [[2026, 11, 11]] },
    type: "journal-article",
    abstract: "<jats:p>Abstract.</jats:p>",
  });
  const fetch = vi.fn(async () =>
    Response.json({
      message: { items: [item(1, "Depth stereo"), item(2, "Off topic")] },
    }),
  );
  const crawl = sourceCrawl(config, {
    cwd: dir,
    dir,
    env: {},
    fetch: fetch as typeof globalThis.fetch,
    now: () => new Date("2026-11-12"),
    sleep: async () => {},
    warn: () => {},
  });
  const result = await crawl("2026-11-12", [], null, []);
  expect(result.days["2026-11-12"]).toHaveLength(1);
  expect(result.days["2026-11-12"]![0]!.venue).toBe("Journal");
  const broken = sourceCrawl(config, {
    cwd: dir,
    dir,
    env: {},
    fetch: vi.fn(
      async () => new Response("busy", { status: 503 }),
    ) as typeof globalThis.fetch,
    now: () => new Date("2026-11-12"),
    sleep: async () => {},
    warn: () => {},
  });
  const failed = await broken("2026-11-12", [], null, []);
  expect(failed.cursor).toBeNull();
  expect(
    failed.warnings?.some((message) =>
      message.includes("Venue watch failed; cursor unchanged"),
    ),
  ).toBe(true);
});

it("puts venue papers found on a weekend on the next Monday, which has the next arXiv listing", async () => {
  const dir = await temporary();
  await writeFile(
    path.join(dir, "venues.json"),
    JSON.stringify({
      venues: [
        { name: "Journal", kind: "journal", issn: ["1234-5678"], match: "all" },
      ],
    }),
  );
  const config = defineConfig({
    sources: { arxiv: { categories: [] }, huggingface: { dailyPapers: false } },
    topics: [{ name: "Vision", keywords: ["stereo"] }],
  });
  const fetch = vi.fn(async () =>
    Response.json({
      message: {
        items: [
          {
            DOI: "10.1234/weekend",
            title: ["Depth stereo"],
            author: [{ given: "Ada", family: "Lovelace" }],
            created: { "date-parts": [[2026, 11, 20]] },
            published: { "date-parts": [[2026, 11, 20]] },
            type: "journal-article",
            abstract: "<jats:p>Abstract.</jats:p>",
          },
        ],
      },
    }),
  );
  for (const day of ["2026-11-21", "2026-11-22"]) {
    const crawl = sourceCrawl(config, {
      cwd: dir,
      dir,
      env: {},
      fetch: fetch as typeof globalThis.fetch,
      now: () => new Date(`${day}T13:45:00Z`),
      sleep: async () => {},
      warn: () => {},
    });
    const result = await crawl(day, [], null, []);
    expect(result.days[day]).toEqual([]);
    expect(result.days["2026-11-23"]).toHaveLength(1);
    expect(result.days["2026-11-23"]![0]!.venue).toBe("Journal");
  }
});

it("keeps a live flow owner even after the lock's stale age", async () => {
  const dir = await temporary();
  const file = path.join(dir, "feed.lock");
  const deps = { dir } as FlowDeps;
  await withFlowLock(deps, async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 3600000);
    await utimes(file, fourHoursAgo, fourHoursAgo);
    const overlap = vi.fn(async () => {});
    await expect(withFlowLock(deps, overlap)).rejects.toThrow(
      "Another feed command",
    );
    expect(overlap).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      pid: process.pid,
      host: hostname(),
      bootTime: expect.any(Number),
    });
  });
  await expect(readFile(file)).rejects.toHaveProperty("code", "ENOENT");
});

it.each(["older than 12 hours", "previous boot"])(
  "recovers a live PID lock from %s and reports why",
  async (reason) => {
    const dir = await temporary();
    const file = path.join(dir, "feed.lock");
    const warn = vi.fn();
    const deps = { dir, flow: { warn } };
    const previousBoot = reason === "previous boot";
    const bootTime = Date.now() - uptime() * 1000;
    await writeFile(
      file,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        bootTime: bootTime - (previousBoot ? 3600000 : 0),
        acquiredAt: previousBoot ? bootTime - 5000 : Date.now(),
      }),
    );
    const modified = new Date(Date.now() - (previousBoot ? 0 : 13 * 3600000));
    await utimes(file, modified, modified);
    await expect(withFlowLock(deps, async () => "ran")).resolves.toBe("ran");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
    await expect(readFile(file)).rejects.toHaveProperty("code", "ENOENT");
  },
);
