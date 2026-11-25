import {
  mkdir,
  mkdtemp,
  rm,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import {
  paperSchema,
  type PaperInput,
} from "@litscout/pipeline/contracts/index";
import type { CrawlResult } from "@litscout/pipeline/daily";
import { parseCommand, runCommand } from "../src/setup-commands";
import type { FlowDeps } from "../src/flow-runtime";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const day = "2026-11-17",
  reset = "2026-11-18T00:00:00.000Z";
const papers = Array.from({ length: 100 }, (_, i) =>
  paperSchema.parse({
    key: `2611.${String(i).padStart(5, "0")}`,
    title: `Paper ${String.fromCharCode(256 + i)}`,
    authors: [`Author ${i}`],
    abstract: "Text",
    source: "arxiv",
    identifiers: [
      { scheme: "arxiv", value: `2611.${String(i).padStart(5, "0")}` },
    ],
  }),
);
const content = {
  tldr: "One",
  motivation: "Two",
  method: "Three",
  result: "Four",
  conclusion: "Five",
};
async function harness(byteLimit?: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-quota-"));
  dirs.push(dir);
  let now = new Date(day + "T03:30:00Z"),
    budgetUsed = 0,
    limited = true,
    denied = false,
    partial = false,
    uploadFailure: number | "network" | "timeout" | undefined,
    rejectedKeys = new Set([papers[50]!.key]);
  const stored = new Map<string, PaperInput>(),
    cursors = new Map<string, string>(),
    dayWrites = new Map<string, string>(),
    summaries = new Set<string>(),
    output: string[] = [];
  const crawl = vi.fn(async (): Promise<CrawlResult> => ({
    days: {
      [day]: byteLimit
        ? papers.map((paper, index) =>
            index === 50 ? { ...paper, abstract: "x".repeat(15_000) } : paper,
          )
        : papers,
    },
    gaps: [],
    cursor: null,
    listing: { listingDate: day, runDay: day },
  }));
  const deps: FlowDeps = {
    dir,
    cwd: dir,
    isTTY: false,
    env: {},
    templateDir: "templates/self-host",
    bundlePath: "unused",
    print: (s) => output.push(s),
    prompt: vi.fn(),
    run: vi.fn(),
    fetchVenues: vi.fn(),
    loadConfig: async () =>
      defineConfig({
        instance: {
          publicUrl: "https://local",
          limits: { ingest: { bytes: byteLimit, papers: 20, summaries: 25 } },
        },
      }),
    flow: { token: "synthetic", now: () => now, sleep: async () => {}, crawl },
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input)),
        body = options?.body ? JSON.parse(options.body as string) : {};
      const success = (data: unknown) =>
        Response.json({ success: true, data, meta: { rowsWritten: 0 } });
      if (url.pathname.endsWith("/budget"))
        return success({
          day: now.toISOString().slice(0, 10),
          used: budgetUsed,
          reserved: 0,
          staleLeasesReleased: 0,
          limit: 80000,
          resetAt: reset,
        });
      if (url.pathname.endsWith("/feed/days"))
        return success(stored.size ? [{ day, status: "pending" }] : []);
      if (url.pathname.endsWith("/feed/history"))
        return success({
          items: [...stored.values()].map((p) => ({
            ...p,
            day,
            paperId: "pap_" + p.key,
            authors: p.authors.map((name) => ({ name })),
            hasAbstract: Boolean(p.abstract),
          })),
          nextCursor: null,
        });
      if (url.pathname.includes("/feed/days/")) {
        const isFull = url.pathname.endsWith("/full");
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const rows = [...stored.values()];
        return success({
          day,
          status: "pending",
          counts: { arxiv: rows.length },
          nextCursor:
            isFull && offset + 50 < rows.length ? String(offset + 50) : null,
          items: (isFull ? rows.slice(offset, offset + 50) : rows).map((p) => ({
            ...p,
            paperId: "pap_" + p.key,
            authors: p.authors.map((name) => ({ name })),
            summaries: [],
          })),
        });
      }
      if (url.pathname.endsWith("/sync/cursors")) {
        const value = cursors.get(url.searchParams.get("name")!);
        return success(value ? { value } : null);
      }
      if (url.pathname.endsWith("/ingest/papers")) {
        const rows = body.papers as PaperInput[];
        if (
          uploadFailure &&
          rows.some((paper) => rejectedKeys.has(paper.key))
        ) {
          if (uploadFailure === "network") throw new TypeError("offline");
          if (uploadFailure === "timeout")
            throw new DOMException("timed out", "TimeoutError");
          return new Response("Fixture rejection", {
            status: uploadFailure,
          });
        }
        if (limited && (!denied || partial)) {
          const used = partial ? 80000 : 76590;
          denied = true;
          return Response.json(
            {
              success: false,
              error: {
                code: "WRITE_BUDGET_EXCEEDED",
                used,
                reserved: 0,
                limit: 80000,
                needed: rows.length * 67 + 4,
                retry_after: reset,
              },
            },
            { status: 429 },
          );
        }
        rows.forEach((p) => stored.set(p.key, p));
        partial = true;
        return success({
          accepted: rows.length,
          papers: rows.map((p) => ({ key: p.key, paperId: "pap_" + p.key })),
        });
      }
      if (url.pathname.endsWith("/ingest/summaries"))
        (body.summaries as { paperId: string }[]).forEach((s) =>
          summaries.add(s.paperId),
        );
      if (url.pathname.endsWith("/ingest/legacy"))
        for (const c of body.cursors ?? []) cursors.set(c.name, c.value);
      if (url.pathname.endsWith("/ingest/feed-day"))
        dayWrites.set(body.day, body.status);
      return success({});
    }) as typeof fetch,
  };
  const command = async (...args: string[]) => {
    output.length = 0;
    const code = await runCommand([...args, "--json"], deps);
    return { code, data: JSON.parse(output.at(-1)!).data };
  };
  return {
    deps,
    command,
    stored,
    summaries,
    crawl,
    cursors,
    dayWrites,
    failUpload: (failure: typeof uploadFailure = 503, keys = rejectedKeys) => {
      limited = false;
      uploadFailure = failure;
      rejectedKeys = keys;
    },
    setBudgetUsed: (used: number) => {
      budgetUsed = used;
    },
    resume: () => {
      limited = false;
      uploadFailure = undefined;
      budgetUsed = 0;
      now = new Date("2026-11-18T00:01:00Z");
    },
  };
}
it("returns budget-short without uploading and reuses the saved crawl after reset", async () => {
  const h = await harness();
  h.setBudgetUsed(79669);
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 2,
    data: {
      status: "budget-short",
      availableRows: 331,
      added: 0,
      resumeAt: reset,
    },
  });
  expect(h.stored.size).toBe(0);
  expect(h.cursors.size).toBe(0);
  h.resume();
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 0,
    data: { day, arxivAdded: 100 },
  });
  expect(h.crawl).toHaveBeenCalledTimes(1);
});
it("W3 daily fetch stops cleanly mid-first-batch and resumes every remaining paper after UTC rollover without recrawling", async () => {
  const h = await harness();
  const stopped = await h.command("daily", "fetch");
  expect(stopped).toMatchObject({
    code: 2,
    data: { status: "budget-stop", resumeAt: reset },
  });
  expect(h.stored.size).toBe(20);
  h.resume();
  const completed = await h.command("daily", "fetch");
  expect(completed.code, JSON.stringify(completed.data)).toBe(0);
  expect(completed.data.day).toBe(day);
  expect(h.stored.size).toBe(100);
  expect(h.crawl).toHaveBeenCalledTimes(1);
});
it("W3 legacy import saves a first-step cursor locally and resumes papers and summaries even if the server cursor is unavailable", async () => {
  const h = await harness();
  const raw = papers.map((p) => ({
    id: p.key,
    title: p.title,
    summary: p.abstract,
    authors: p.authors,
  }));
  const files = {
    [`data/${day}.jsonl`]: raw.map((p) => JSON.stringify(p)).join("\n"),
    [`data/${day}_AI_enhanced_English.jsonl`]: raw
      .map((p) => JSON.stringify({ ...p, AI: content }))
      .join("\n"),
  };
  h.deps.flow!.git = async (_repo, args) =>
    args[0] === "ls-tree"
      ? Object.keys(files).join("\n")
      : args[0] === "show"
        ? files[args[1]!.split(":").slice(1).join(":") as keyof typeof files]!
        : "fixture";
  const args = ["migrate", "legacy", "--repo", ".", "--from", day, "--to", day];
  await expect(
    h.command("legacy", "import", ...args.slice(2), "--max-rows", "0"),
  ).resolves.toMatchObject({
    code: 2,
    data: { status: "max-rows", completedOperations: 0, rowsBudgeted: 0 },
  });
  expect(await h.command(...args)).toMatchObject({
    code: 2,
    data: { status: "budget-stop", resumeAt: reset },
  });
  expect(h.stored.size).toBe(20);
  const filesSaved = await readdir(path.join(h.deps.dir, "resume"), {
    recursive: true,
  });
  const saved = path.join(
    h.deps.dir,
    "resume",
    filesSaved.find(
      (file) => file.includes("legacy-") && file.endsWith(".json"),
    )!,
  );
  expect(JSON.parse(await readFile(saved, "utf8"))).toMatchObject({
    offset: 0,
    runId: expect.stringMatching(/^run_/),
  });
  expect((await stat(saved)).mode & 0o777).toBe(0o600);
  h.cursors.clear();
  h.resume();
  expect(await h.command(...args)).toMatchObject({
    code: 0,
    data: { status: "done" },
  });
  expect(h.stored.size).toBe(100);
  expect(h.summaries.size).toBe(100);
});

it("replays staged venue state after a daily upload stops between chunks", async () => {
  const h = await harness();
  const ledger = path.join(h.deps.dir, "watch-jmlr.json");
  await writeFile(
    path.join(h.deps.dir, "venues.json"),
    JSON.stringify({
      venues: [{ name: "JMLR", kind: "journal", jmlr: true }],
    }),
  );
  const { sourceCrawl } = await import("../src/source-crawl");
  const config = defineConfig({
    sources: { arxiv: { categories: [] }, huggingface: { dailyPapers: false } },
  });
  const readVenue = vi.fn(
    async () =>
      new Response(`<rss><channel><item>
    <title>Fixture paper</title><link>https://jmlr.org/papers/v27/26-0001.html</link>
    </item></channel></rss>`),
  );
  const crawl = sourceCrawl(config, {
    cwd: h.deps.dir,
    dir: h.deps.dir,
    env: { LITSCOUT_STATE_DIR: h.deps.dir },
    fetch: readVenue,
    now: () => new Date(day),
    sleep: async () => {},
    warn: () => {},
  });
  h.deps.flow!.crawl = async (...args) => {
    const venues = await crawl(...args);
    const arxiv = await h.crawl();
    return { ...venues, ...arxiv, cursor: venues.cursor };
  };
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    data: { status: "budget-stop" },
  });
  await expect(stat(ledger)).rejects.toHaveProperty("code", "ENOENT");
  h.resume();
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 0,
    data: { day },
  });
  const saved = JSON.parse(await readFile(ledger, "utf8"));
  expect(saved.seen).toEqual({ "v27/26-0001": "baseline" });
  expect(readVenue).toHaveBeenCalledTimes(1);
});

it.each([503, 500, "network", "timeout"] as const)(
  "retains the checkpoint and cursor after a transient %s upload error",
  async (failure) => {
    const h = await harness();
    h.failUpload(failure);
    const stopped = await h.command("daily", "fetch");
    expect(h.cursors.has("arxiv-listing")).toBe(false);
    expect(stopped).toMatchObject({ code: 1, data: { status: "error" } });
    h.resume();
    await expect(h.command("daily", "fetch")).resolves.toMatchObject({
      code: 0,
      data: { day },
    });
    expect(h.stored.size).toBe(100);
    expect(h.crawl).toHaveBeenCalledTimes(1);
  },
);

it("quarantines a paper with a persistent 422 and finishes the daily upload", async () => {
  const h = await harness();
  h.failUpload(422);
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 0,
    data: {
      day,
      status: "crawled",
      added: 99,
      invalid: [
        expect.objectContaining({
          day,
          id: papers[50]!.key,
          reason: expect.stringContaining("422"),
        }),
      ],
    },
  });
  expect(h.cursors.has("arxiv-listing")).toBe(true);
  await expect(
    h.command("daily", "fetch", "--day", day),
  ).resolves.toMatchObject({ code: 0 });
  expect(h.crawl).toHaveBeenCalledTimes(2);
  expect(h.stored.size).toBe(99);
});

it("blocks when all papers in a small day are rejected and replays its saved crawl", async () => {
  const h = await harness();
  const rows = papers.slice(0, 3);
  const listing = JSON.stringify({ listingDate: "2026-11-16", runDay: day });
  h.cursors.set("arxiv-listing", listing);
  h.cursors.set("venue-feed", "2026-11-16");
  h.crawl.mockResolvedValueOnce({
    days: { [day]: rows },
    gaps: [],
    cursor: day,
    listing: { listingDate: day, runDay: day },
  });
  h.failUpload(400, new Set(rows.map((p) => p.key)));

  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 1,
    data: {
      day,
      status: "error",
      message: expect.stringContaining(
        `${day} upload blocked. 3 of 3 papers rejected (LitScout API HTTP 400).`,
      ),
    },
  });
  expect(h.cursors.get("arxiv-listing")).toBe(listing);
  expect(h.cursors.get("venue-feed")).toBe("2026-11-16");
  expect(h.dayWrites.has(day)).toBe(false);
  expect(h.stored.size).toBe(0);

  h.resume();
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 0,
    data: { day, status: "crawled", added: 3 },
  });
  expect(h.crawl).toHaveBeenCalledTimes(1);
  expect(h.cursors.get("venue-feed")).toBe(day);
  expect(h.cursors.get("arxiv-listing")).not.toBe(listing);
});

it("blocks above the rejection limit across the arXiv and venue uploads of a day", async () => {
  const h = await harness();
  const rows = papers.map((paper, i) =>
    i < 50 ? paper : { ...paper, source: "jmlr" as const },
  );
  h.crawl.mockResolvedValueOnce({
    days: { [day]: rows },
    gaps: [],
    cursor: null,
    listing: { listingDate: day, runDay: day },
  });
  const rejected = [...rows.slice(0, 11), ...rows.slice(50, 60)];
  h.failUpload(400, new Set(rejected.map((p) => p.key)));

  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 1,
    data: {
      status: "error",
      message: expect.stringContaining("21 of 100 papers rejected"),
    },
  });
  expect(h.cursors.size).toBe(0);
  expect(h.dayWrites.has(day)).toBe(false);
  expect(h.stored.size).toBe(79);
});

it("can quarantine one remaining paper when the rest of the day was already uploaded", async () => {
  const h = await harness();
  const rows = [papers[0]!, papers[50]!];
  h.crawl.mockResolvedValueOnce({
    days: { [day]: rows },
    gaps: [],
    cursor: null,
    listing: { listingDate: day, runDay: day },
  });
  h.failUpload(503);
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 1,
    data: { status: "error" },
  });
  expect(h.stored.size).toBe(1);

  h.failUpload(422);
  await expect(h.command("daily", "fetch")).resolves.toMatchObject({
    code: 0,
    data: {
      status: "crawled",
      invalid: [expect.objectContaining({ day, id: papers[50]!.key })],
    },
  });
  expect(h.cursors.has("arxiv-listing")).toBe(true);
  expect(h.crawl).toHaveBeenCalledTimes(1);
});

it("reports a row over the configured byte limit without sending it or blocking the cursor", async () => {
  const h = await harness(12_000);
  h.resume();
  await expect(
    h.command("daily", "fetch", "--day", day),
  ).resolves.toMatchObject({
    code: 0,
    data: {
      added: 99,
      invalid: [
        expect.objectContaining({
          day,
          id: papers[50]!.key,
          reason: "JSON exceeds client byte limit 12000",
        }),
      ],
    },
  });
  expect(h.cursors.has("arxiv-listing")).toBe(true);
  expect(h.stored.has(papers[50]!.key)).toBe(false);
});

// Runs a real D1 harness: about 6 s alone, so allow for a busy machine.
it(
  "continues with a fresh budget reservation when an earlier upload lease expires mid-run",
  { timeout: 60_000 },
  async () => {
    const { databaseHarness } = await import("@litscout/db/test/harness");
    const {
      reserveWriteBudget,
      releaseStaleLeases,
      settleWriteBudget,
      writeBudgetUsage,
    } = await import("@litscout/db/write-budget");
    const { WriteBudget, apiClient } = await import("@litscout/pipeline/api");
    const fixture = await databaseHarness("d1");
    try {
      const db = fixture.db
        .$client as import("@litscout/db/ingest-store").IngestDatabase;
      let now = new Date(day + "T09:00:00Z");
      const received: string[] = [];
      const fetch: typeof globalThis.fetch = async (_, init) => {
        const { papers: batch } = JSON.parse(String(init?.body)) as {
          papers: PaperInput[];
        };
        const lease = await reserveWriteBudget(db, 100, now, 21);
        expect(lease).not.toBeNull();
        if (!received.length) {
          now = new Date(day + "T09:10:01Z");
          expect(await releaseStaleLeases(db, now)).toMatchObject({
            released: 1,
          });
        }
        received.push(...batch.map((p) => p.key));
        const budgetRowsWritten = await settleWriteBudget(
          db,
          lease!,
          5,
          false,
          {
            now,
          },
        );
        return Response.json({
          success: true,
          data: { accepted: batch.length },
          meta: { rowsWritten: 5, budgetRowsWritten },
        });
      };
      const budget = new WriteBudget(
        { day, rows: 0 },
        () => now,
        async () => {},
      );
      const api = apiClient(
        "https://fixture.invalid",
        "synthetic",
        fetch,
        budget,
        async () => {},
        { papers: 1 },
      );
      await expect(
        api.write("/ingest/papers", { day, papers: papers.slice(0, 2) }, 400),
      ).resolves.toMatchObject({ accepted: 2 });
      expect(received).toEqual(papers.slice(0, 2).map((p) => p.key));
      expect(await writeBudgetUsage(db, day)).toMatchObject({ reserved: 0 });
      expect(budget.state.reserved).toBe(0);
    } finally {
      await fixture.close();
    }
  },
);

it("pins an implicit legacy window across UTC rollover for the same arguments", async () => {
  const { deps } = await harness();
  const { legacyCommand } = await import("../src/legacy-command");
  const dates = ["2026-11-16", "2026-11-17", "2026-11-18"];
  let today = dates[1]!;
  deps.flow!.now = () => new Date(today + "T03:30:00Z");
  deps.flow!.git = async (_repo, args) =>
    args[0] === "ls-tree"
      ? dates
          .filter((date) => date <= today)
          .map((date) => `data/${date}.jsonl`)
          .join("\n")
      : args[0] === "show"
        ? JSON.stringify({ id: "2611.00010", title: "Fixture paper" })
        : "fixture";
  const api = {
    get: async () => null,
    planRows: () => 10,
    write: async (route: string, body: unknown) =>
      route === "/ingest/papers"
        ? {
            papers: (body as { papers: { key: string }[] }).papers.map(
              ({ key }) => ({ key, paperId: "pap_fixture" }),
            ),
          }
        : {},
  };
  const args = ["--repo", ".", "--days", "2", "--max-rows", "45"];
  await expect(legacyCommand(args, deps, api)).resolves.toMatchObject({
    status: "max-rows",
    daysImported: [dates[0]],
    daysLeft: [dates[1]],
  });
  today = dates[2]!;
  await expect(legacyCommand(args, deps, api)).resolves.toMatchObject({
    status: "done",
    daysImported: [dates[1]],
    daysLeft: [],
  });
});

it("imports the configured legacy window without arguments and stops once it is done", async () => {
  const { deps } = await harness();
  const { legacyCommand, legacyOptions } =
    await import("../src/legacy-command");
  const window = { repo: ".", from: "2026-11-16", to: "2026-11-17" };
  expect(legacyOptions(["--max-rows", "500"], window)).toMatchObject({
    repo: ".",
    from: "2026-11-16",
    to: "2026-11-17",
    maxRows: 500,
  });
  // Explicit arguments still win over the configured window.
  expect(
    legacyOptions(
      ["--repo", "other", "--from", "2026-11-01", "--to", "2026-11-02"],
      window,
    ),
  ).toMatchObject({ repo: "other", from: "2026-11-01", to: "2026-11-02" });
  expect(() => legacyOptions([])).toThrow(/--repo/);

  deps.flow!.now = () => new Date("2026-11-19T03:30:00Z");
  deps.flow!.git = async (_repo, args) =>
    args[0] === "ls-tree"
      ? ["data/2026-11-16.jsonl", "data/2026-11-17.jsonl"].join("\n")
      : args[0] === "show"
        ? JSON.stringify({ id: "2611.00011", title: "Fixture paper" })
        : "fixture";
  const write = vi.fn(async (route: string, body: unknown) =>
    route === "/ingest/papers"
      ? {
          papers: (body as { papers: { key: string }[] }).papers.map(
            ({ key }) => ({
              key,
              paperId: "pap_fixture",
            }),
          ),
        }
      : {},
  );
  const api = { get: async () => null, planRows: () => 10, write };
  const args = ["--max-rows", "500"];
  await expect(
    legacyCommand(args, deps, api, [], "configured-instance", window),
  ).resolves.toMatchObject({ status: "done" });
  write.mockClear();
  await expect(
    legacyCommand(args, deps, api, [], "configured-instance", window),
  ).resolves.toMatchObject({ status: "done", alreadyDone: true });
  expect(write).not.toHaveBeenCalled();
});

it("keeps the done marker to the configured window, resolved from the config folder", async () => {
  const { deps } = await harness();
  const { legacyCommand, legacyOptions, legacyStatus } =
    await import("../src/legacy-command");
  const window = { repo: "legacy", from: "2026-11-16", to: "2026-11-16" };
  expect(legacyOptions(["--max-rows", "5"], window)).toMatchObject({
    fromConfig: true,
  });
  expect(
    legacyOptions([
      "--repo",
      ".",
      "--from",
      "2026-11-16",
      "--to",
      "2026-11-16",
    ]),
  ).toMatchObject({ fromConfig: false });
  // A digest folder for the configured window belongs in the config.
  expect(() => legacyOptions(["--dir", "old"], window)).toThrow(/legacy\.dir/);

  deps.flow!.now = () => new Date("2026-11-19T03:30:00Z");
  deps.flow!.git = async (_repo, args) =>
    args[0] === "ls-tree"
      ? "data/2026-11-16.jsonl"
      : args[0] === "show"
        ? JSON.stringify({ id: "2611.00014", title: "Fixture paper" })
        : "fixture";
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
  // Explicit windows import again on request; no marker is written.
  const explicit = [
    "--repo",
    ".",
    "--from",
    "2026-11-16",
    "--to",
    "2026-11-16",
  ];
  for (let run = 0; run < 2; run++)
    await expect(
      legacyCommand([...explicit, "--max-rows", "500"], deps, api),
    ).resolves.not.toHaveProperty("alreadyDone");
  // A relative configured repository resolves from the config folder, as in doctor.
  const configDir = path.join(deps.dir, "config");
  await mkdir(path.join(configDir, "legacy"), { recursive: true });
  const fromElsewhere = { ...deps, cwd: deps.dir, configDir };
  await expect(
    legacyCommand(["--max-rows", "500"], fromElsewhere, api, [], "e", window),
  ).resolves.toMatchObject({ status: "done" });
  await expect(
    legacyStatus(fromElsewhere, window, "e", configDir),
  ).resolves.toMatchObject({ ok: true, done: true });
});

it("fails the legacy step loudly when --keep-rows cannot read the balance", async () => {
  const h = await harness();
  h.resume();
  h.deps.flow!.git = async (_repo, args) =>
    args[0] === "ls-tree"
      ? "data/2026-11-16.jsonl"
      : args[0] === "show"
        ? JSON.stringify({ id: "2611.00015", title: "Fixture paper" })
        : "fixture";
  const output: string[] = [];
  const base = h.deps.fetch!;
  const deps: FlowDeps = {
    ...h.deps,
    print: (s) => output.push(s),
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) =>
      new URL(String(input)).pathname.endsWith("/budget")
        ? new Response("unavailable", { status: 503 })
        : base(input, options)) as typeof fetch,
    loadConfig: async () =>
      defineConfig({
        instance: { publicUrl: "https://local" },
        legacy: { repo: ".", from: "2026-11-16", to: "2026-11-16" },
      }),
  };
  const code = await runCommand(
    ["legacy", "import", "--keep-rows", "2000", "--json"],
    deps,
  );
  expect(JSON.parse(output.at(-1)!).data).toMatchObject({
    status: "budget-unread",
    budgetUnread: true,
    // The job's log says why the balance could not be read.
    budgetReason:
      "Cannot read server budget (LitScout API HTTP 503); no writes sent. No cached server budget available",
  });
  expect(code).toBe(1);
  expect(h.stored.size).toBe(0);
});

it("parses --keep-rows for the legacy import and refuses it on a dry run", async () => {
  const { legacyOptions } = await import("../src/legacy-command");
  const window = { repo: ".", from: "2026-11-16", to: "2026-11-17" };
  expect(legacyOptions(["--keep-rows", "2000"], window)).toMatchObject({
    keepRows: 2000,
    maxRows: undefined,
  });
  expect(
    legacyOptions(["--keep-rows", "2000", "--max-rows", "500"], window),
  ).toMatchObject({ keepRows: 2000, maxRows: 500 });
  expect(() =>
    legacyOptions(["--keep-rows", "2000", "--dry-run"], window),
  ).toThrow(/only when importing/);
  expect(() => legacyOptions(["--keep-rows", "-1"], window)).toThrow();
  // The runbook's step 10, as written.
  expect(() =>
    parseCommand([
      "legacy",
      "import",
      "--keep-rows",
      "2000",
      "--json",
      "--config",
      "litscout.config.ts",
    ]),
  ).not.toThrow();
});

it("runs and dry-runs the configured legacy window from the documented command", async () => {
  const h = await harness();
  const { feedOptions } = await import("../src/feed-command");
  // The documented forms parse without --repo; a partial window still needs it.
  expect(() =>
    feedOptions(["legacy", "import", "--max-rows", "500"]),
  ).not.toThrow();
  expect(() =>
    feedOptions(["legacy", "import", "--dry-run"], "litscout.config.ts"),
  ).not.toThrow();
  expect(() =>
    feedOptions(["legacy", "import", "--from", "2026-11-01"]),
  ).toThrow(/--repo/);
  expect(() =>
    feedOptions(
      ["legacy", "import", "--repo", ".", "--dry-run"],
      "litscout.config.ts",
    ),
  ).toThrow(/do not use --config/);

  h.deps.flow!.git = async (_repo, args) =>
    args[0] === "ls-tree"
      ? "data/2026-11-16.jsonl"
      : args[0] === "show"
        ? JSON.stringify({ id: "2611.00012", title: "Fixture paper" })
        : "fixture";
  const output: string[] = [];
  const deps: FlowDeps = {
    ...h.deps,
    print: (s) => output.push(s),
    loadConfig: async () =>
      defineConfig({
        instance: { publicUrl: "https://local" },
        legacy: { repo: ".", from: "2026-11-16", to: "2026-11-16" },
      }),
  };
  const run = async (...args: string[]) => {
    output.length = 0;
    const code = await runCommand([...args, "--json"], deps);
    return { code, data: JSON.parse(output.at(-1)!).data };
  };
  const dry = await run("legacy", "import", "--dry-run");
  expect(dry.code).toBe(0);
  expect(dry.data).toMatchObject({
    status: "dry-run",
    counts: [{ day: "2026-11-16", papers: 1 }],
  });
  expect(h.stored.size).toBe(0);
  // The documented command reaches the import with the configured window;
  // the done marker is covered by the test above.
  expect(await run("legacy", "import", "--max-rows", "5000")).toMatchObject({
    code: 2,
    data: { status: "budget-stop", resumeAt: reset },
  });
});

it("builds and uploads the Health report from the steps run since daily start", async () => {
  const h = await harness();
  h.resume();
  const uploads: unknown[] = [];
  const base = h.deps.fetch!;
  const output: string[] = [];
  const deps: FlowDeps = {
    ...h.deps,
    print: (s) => output.push(s),
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/ingest/daily-run"))
        uploads.push(JSON.parse(String(options?.body)));
      return base(input, options);
    }) as typeof fetch,
  };
  const run = async (...args: string[]) => {
    output.length = 0;
    const code = await runCommand([...args, "--json"], deps);
    return { code, data: JSON.parse(output.at(-1)!).data };
  };
  const start = await run("daily", "start");
  expect(start.code).toBe(0);
  const fetched = await run("daily", "fetch");
  expect(fetched.data.status).not.toBe("error");
  const report = await run("daily", "report");
  expect(report.code, JSON.stringify(report.data)).toBe(0);
  const finished = uploads.at(-1) as Record<string, unknown>;
  expect(finished).toMatchObject({
    id: start.data.id,
    startedAt: start.data.startedAt,
    targetDay: start.data.targetDay,
    steps: {
      fetch: { status: "done" },
      summaries: { status: "skipped" },
      digest: { status: "skipped" },
      sync: { status: "skipped" },
      legacy: { status: "skipped" },
    },
  });
  expect(finished.rowsWritten).toEqual(expect.any(Number));
  // The run is closed: a second report needs a new daily start.
  expect((await run("daily", "report")).code).not.toBe(0);
  // The documented FILE form still works for recovery runs.
  expect(() => parseCommand(["daily", "report", "health.json"])).not.toThrow();
});

it("does not let a mistyped command mark a finished step as failed", async () => {
  const h = await harness();
  h.resume();
  const uploads: unknown[] = [];
  const base = h.deps.fetch!;
  const output: string[] = [];
  const deps: FlowDeps = {
    ...h.deps,
    print: (s) => output.push(s),
    fetch: (async (input: RequestInfo | URL, options?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/ingest/daily-run"))
        uploads.push(JSON.parse(String(options?.body)));
      return base(input, options);
    }) as typeof fetch,
  };
  const run = (...args: string[]) => runCommand([...args, "--json"], deps);
  expect(await run("daily", "start")).toBe(0);
  await run("daily", "fetch");
  // A usage error is a typo, not a failed step.
  expect(await run("daily", "fetch", "--bogus")).not.toBe(0);
  expect(await run("daily", "report")).toBe(0);
  expect(uploads.at(-1)).toMatchObject({
    steps: { fetch: { status: "done" } },
  });
});

it("says in daily start that the scheduler runs in Shadow mode, so the old pipeline goes first", async () => {
  // 2026-11-19: the agent skipped the old pipeline twice because it read the
  // runbook's shadow rule as not applying. daily start now says it outright.
  const h = await harness();
  const home = path.join(h.deps.dir, "home");
  const folder = path.join(home, ".gemini/config/sidecars/litscout-daily");
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "sidecar.json"),
    JSON.stringify({
      args: [
        "agent",
        "Run LitScout for today by following `/repo/docs/runbook/daily.md` exactly, passing `--config /cfg.ts` to every litscout command. End with the report as the final message.",
      ],
    }),
  );
  const output: string[] = [];
  const run = async (deps: FlowDeps) => {
    output.length = 0;
    await runCommand(["daily", "start", "--json"], deps);
    return JSON.parse(output.at(-1)!).data;
  };
  const withHome = {
    ...h.deps,
    env: { HOME: home },
    print: (s: string) => output.push(s),
  };
  expect(await run(withHome)).toMatchObject({
    scheduler: {
      mode: "shadow",
      next: expect.stringContaining("old pipeline's original prompt first"),
      oldPrompt: expect.stringContaining("sidecar old-prompt --file"),
    },
  });
  // Without a home to look in (tests, other machines) nothing is claimed.
  expect(
    await run({ ...h.deps, print: (s: string) => output.push(s) }),
  ).not.toHaveProperty("scheduler");
});
