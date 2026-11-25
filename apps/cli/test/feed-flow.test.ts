import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, mkdtemp, writeFile, mkdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { migrationStatements } from "@litscout/db/test/harness";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import type { FlowDeps } from "../src/flow-runtime";
let mf: Miniflare, directory: string, deps: FlowDeps;
const output: string[] = [];
const token = "lsk_" + "A".repeat(52);
const clients: string[][] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "litscout-feed-"));
  await writeFile(path.join(directory, "venues.json"), '{"venues":[]}');
  await build({
    entryPoints: ["apps/worker/src/index.ts"],
    outfile: ".artifacts/flow-worker.js",
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    define: { __GIT_SHA__: '"test"' },
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: ".artifacts/flow-worker.js",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      durableObjects: {
        PAIRING_STORE: { className: "PairingStore", useSQLite: true },
        SOURCE_LIMITER: { className: "SourceLimiter", useSQLite: true },
      },
      outboundService: () => new Response("Network disabled", { status: 503 }),
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const statement of migrationStatements())
    await db.prepare(statement).run();
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toString("hex");
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_flow','flow',?,'[\"read\",\"ingest\"]')",
    )
    .bind(hash)
    .run();
  const html = await readFile(
    "apps/cli/test/fixtures/round3/arxiv-new.html",
    "utf8",
  );
  const recent = await readFile(
    "apps/cli/test/fixtures/round3/arxiv-recent.html",
    "utf8",
  );
  const config = defineConfig({
    instance: {
      publicUrl: "http://127.0.0.1",
      webUrl: "https://reader.example",
      language: "en",
    },
    sources: {
      arxiv: { categories: ["cs.CV"] },
      huggingface: { dailyPapers: true, upvotesDays: 1 },
    },
    topics: [{ name: "Vision", keywords: ["stereo", "depth"] }],
    agent: { summaries: { client: "cmd", command: ["mock", "{prompt}"] } },
  });
  deps = {
    cwd: directory,
    dir: path.join(directory, "state"),
    env: {},
    isTTY: false,
    templateDir: "templates/self-host",
    bundlePath: "unused",
    print: (s) => output.push(s),
    prompt: vi.fn(),
    run: vi.fn(),
    fetchVenues: vi.fn(),
    loadConfig: async () => config,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "127.0.0.1")
        return mf.dispatchFetch(
          url,
          init as Parameters<Miniflare["dispatchFetch"]>[1],
        );
      if (url.hostname === "arxiv.org")
        return new Response(url.pathname.endsWith("/recent") ? recent : html);
      if (url.hostname === "huggingface.co")
        return Response.json([{ paper: { id: "2610.12345", upvotes: 5 } }]);
      throw new Error("Unexpected network");
    }) as typeof fetch,
    flow: {
      preflight: async (
        client: import("@litscout/pipeline/agents").Client,
      ) => ({ client, usable: true, reason: "fake" }),
      token,
      now: () => new Date("2026-11-16T02:30:00Z"),
      sleep: async () => {},
      agent: async (argv, papers) => {
        clients.push(argv);
        return {
          code: 0,
          text: papers
            .map(
              (p) =>
                `=== ${p.paperId}\ntldr: What\nmotivation: Why\nmethod: How\nresult: Found\nconclusion: Means`,
            )
            .join("\n"),
        };
      },
    },
  };
});
afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const command = async (...args: string[]) => {
  output.length = 0;
  const code = await runCommand([...args, "--json"], deps);
  return { code, result: JSON.parse(output.at(-1)!) };
};
it("daily fetch runs recorded sources through the real local Worker and reruns with no content writes", async () => {
  const first = await command("daily", "fetch", "--day", "2026-11-16");
  expect(first.code, JSON.stringify(first.result)).toBe(0);
  expect(first.result.data.added).toBeGreaterThan(0);
  expect(first.result.data.deferredExplanation).toContain(
    "150-paper limit per feed day",
  );
  const before = JSON.parse(
    await readFile(path.join(deps.dir, "write-budget.json"), "utf8"),
  );
  const second = await command("daily", "fetch", "--day", "2026-11-16");
  expect(second.code).toBe(2);
  expect(
    JSON.parse(
      await readFile(path.join(deps.dir, "write-budget.json"), "utf8"),
    ),
  ).toEqual(before);
  const status = await command("daily", "status");
  expect(status.result.data[0]).toMatchObject({
    day: "2026-11-16",
    crawled: true,
  });
});
it("summary contracts, todo, mocked run and digest context/put work end to end", async () => {
  expect((await command("contracts")).result.data).toHaveProperty("summaries");
  const todo = await command("summaries", "todo", "--day", "2026-11-16");
  expect(todo.result.data.chunks.length).toBeGreaterThan(0);
  expect(
    (
      await command(
        "summaries",
        "run",
        "--day",
        "2026-11-16",
        "--client",
        "cmd",
      )
    ).code,
  ).toBe(0);
  expect(clients.length).toBeGreaterThan(0);
  expect(
    (await command("summaries", "todo", "--day", "2026-11-16")).result.data
      .chunks,
  ).toEqual([]);
  const context = await command("digest", "context", "--day", "2026-11-16");
  expect(context.result.data.all.length).toBeGreaterThan(0);
  const file = path.join(directory, "digest.json");
  await writeFile(
    file,
    JSON.stringify({
      day: "2026-11-16",
      topics: {},
      radar: [
        {
          paperId: context.result.data.all[0].paperId,
          level: "borrow",
          reason: "Interesting",
          project: "FYP · stereo conversion",
        },
      ],
      reportText: "Read the paper.",
    }),
  );
  expect((await command("digest", "put", file)).code).toBe(0);
  const brief = await mf.dispatchFetch(
    "http://127.0.0.1/api/v1/feed/days/2026-11-16/digest",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(await brief.json()).toMatchObject({
    success: true,
    data: {
      bodyMd: expect.stringContaining("FYP · stereo conversion · borrow"),
      radar: [{ project: "FYP · stereo conversion", projectId: null }],
    },
  });
  expect(
    (await command("digest", "final", "--day", "2026-11-16")).result.data
      .status,
  ).toBe("exists");
  expect((await command("weekly", "--day", "2026-11-22")).code).toBe(0);
});
it("legacy dry-run reads a fixture git data branch without a checkout or Worker writes", async () => {
  const repo = path.join(directory, "legacy");
  await mkdir(repo);
  await cp("packages/sync/test/fixtures", repo, { recursive: true });
  execFileSync("git", ["init", "-b", "data", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=" + ["fixture", "example.invalid"].join("@"),
      "commit",
      "-m",
      "test: create legacy fixture",
    ],
    { stdio: "ignore" },
  );
  const before = await (
    await mf.getD1Database("DB")
  )
    .prepare("SELECT COUNT(*) AS n FROM papers")
    .first("n");
  const result = await command(
    "migrate",
    "legacy",
    "--repo",
    repo,
    "--from",
    "2026-11-10",
    "--to",
    "2026-11-11",
    "--dry-run",
  );
  expect(result.code).toBe(0);
  expect(result.result.data.counts).toHaveLength(2);
  expect(result.result.data.estimatedRows).toBeGreaterThan(0);
  expect(
    await (
      await mf.getD1Database("DB")
    )
      .prepare("SELECT COUNT(*) AS n FROM papers")
      .first("n"),
  ).toBe(before);
  expect(
    execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf8",
    }),
  ).toBe("");
  const imported = await command(
    "migrate",
    "legacy",
    "--repo",
    repo,
    "--from",
    "2026-11-10",
    "--to",
    "2026-11-11",
  );
  expect(imported.code, JSON.stringify(imported.result)).toBe(0);
  const db = await mf.getD1Database("DB");
  expect(
    await db
      .prepare("SELECT COUNT(*) FROM feed_items WHERE day='2026-11-10'")
      .first("COUNT(*)"),
  ).toBe(3);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) FROM summaries WHERE client='legacy' AND lang='zh'",
      )
      .first("COUNT(*)"),
  ).toBe(1);
  const again = await command(
    "migrate",
    "legacy",
    "--repo",
    repo,
    "--from",
    "2026-11-10",
    "--to",
    "2026-11-11",
  );
  expect(again.code).toBe(0);
});
it("compares twenty imported papers field by field across five recorded weekdays", async () => {
  const repo = path.join(directory, "legacy-twenty");
  await mkdir(path.join(repo, "data"), { recursive: true });
  const fixture = JSON.parse(
    await readFile(
      "packages/pipeline/test/fixtures/five-days.golden.json",
      "utf8",
    ),
  );
  const expected: {
    day: string;
    id: string;
    title: string;
    summary?: string;
    abstract?: string;
    source?: string;
    doi?: string;
    authors: string[];
    categories?: string[];
  }[] = [];
  for (const d of fixture.days) {
    const sample = d.papers.slice(0, 4);
    expected.push(...sample.map((p: object) => ({ ...p, day: d.day })));
    await writeFile(
      path.join(repo, "data", `${d.day}.jsonl`),
      sample.map((p: object) => JSON.stringify(p)).join("\n"),
    );
  }
  execFileSync("git", ["init", "-b", "data", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=" + ["fixture", "example.invalid"].join("@"),
      "commit",
      "-m",
      "test: record twenty legacy papers",
    ],
    { stdio: "ignore" },
  );
  const imported = await command(
    "migrate",
    "legacy",
    "--repo",
    repo,
    "--from",
    "2026-11-09",
    "--to",
    "2026-11-13",
  );
  expect(imported.code, JSON.stringify(imported.result)).toBe(0);
  const db = await mf.getD1Database("DB");
  for (const p of expected) {
    const scheme = p.id.startsWith("doi:")
      ? "doi"
      : p.id.startsWith("openreview:")
        ? "openreview"
        : p.id.startsWith("url:")
          ? "url"
          : "arxiv";
    const value =
      scheme === "arxiv" ? p.id : p.id.replace(/^(doi|openreview|url):/, "");
    const stored = await db
      .prepare(
        "SELECT p.* FROM papers p JOIN paper_ids i ON i.paper_id=p.id WHERE i.scheme=? AND i.value=?",
      )
      .bind(scheme, value)
      .first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      title: p.title,
      abstract: p.summary || p.abstract || null,
      source: p.source ?? "arxiv",
    });
    expect(JSON.parse(stored!.authors as string)).toEqual(
      p.authors.map((name) => ({ name })),
    );
    expect(JSON.parse(stored!.categories as string)).toEqual(
      p.categories ?? [],
    );
  }
  expect(expected).toHaveLength(20);
});

it("T1 a real already-ingested listing stays pending on a later UTC run day", async () => {
  const before = await (
    await mf.getD1Database("DB")
  )
    .prepare("SELECT COUNT(*) AS n FROM papers")
    .first("n");
  const original = deps.flow;
  try {
    deps.flow = { ...original, now: () => new Date("2026-11-18T03:30:00Z") };
    const result = await command("daily", "fetch", "--day", "2026-11-18");
    expect(result.result.data).toMatchObject({
      status: "pending",
      added: 0,
      message: expect.stringMatching(/2026-11-18 pending/),
    });
    expect(
      await (
        await mf.getD1Database("DB")
      )
        .prepare("SELECT COUNT(*) AS n FROM papers")
        .first("n"),
    ).toBe(before);
  } finally {
    deps.flow = original;
  }
});
it("L1 real late Tuesday keeps Monday's papers on Monday and persists Tuesday pending in the local Worker", async () => {
  const original = deps.flow;
  try {
    deps.flow = { ...original, now: () => new Date("2026-11-17T03:30:00Z") };
    const result = await command("daily", "fetch", "--day", "2026-11-17");
    expect(result.result.data).toMatchObject({
      status: "pending",
      day: "2026-11-17",
      added: 0,
    });
    const db = await mf.getD1Database("DB");
    expect(
      await db
        .prepare("SELECT COUNT(*) FROM feed_items WHERE day='2026-11-16'")
        .first("COUNT(*)"),
    ).toBe(91);
    expect(
      await db
        .prepare("SELECT COUNT(*) FROM feed_items WHERE day='2026-11-17'")
        .first("COUNT(*)"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT status FROM feed_days WHERE day='2026-11-17'")
        .first("status"),
    ).toBe("pending");
    const cursor = await db
      .prepare("SELECT value FROM sync_cursors WHERE name='arxiv-listing'")
      .first<string>("value");
    expect(JSON.parse(cursor!)).toMatchObject({
      listingDate: "2026-11-16",
      runDay: "2026-11-16",
    });
  } finally {
    deps.flow = original;
  }
});

it("reopens a venue-only final day and targets it after the next day's crawl adds its late listing", async () => {
  const day = "2026-11-17";
  const runDay = "2026-11-18";
  const db = await mf.getD1Database("DB");
  await db.batch([
    db
      .prepare("UPDATE api_tokens SET scopes=? WHERE id='tok_flow'")
      .bind(JSON.stringify(["read", "ingest", "write"])),
    db.prepare(
      "INSERT INTO papers(id,title,title_norm,abstract) VALUES ('pap_early','Venue paper','venue paper','A venue abstract')",
    ),
    db
      .prepare(
        "INSERT INTO feed_days(day,status) VALUES (?,'final') ON CONFLICT(day) DO UPDATE SET status='final'",
      )
      .bind(day),
    db
      .prepare(
        "INSERT INTO feed_items(day,paper_id,source) VALUES (?,'pap_early','venue')",
      )
      .bind(day),
    db
      .prepare(
        "INSERT INTO digests(day,body_md,final) VALUES (?,'Closed early',1)",
      )
      .bind(day),
  ]);
  expect((await command("daily", "status")).result.data).toContainEqual(
    expect.objectContaining({
      day,
      status: "closed-early",
      final: true,
      crawled: false,
      suggestion: `litscout day reopen ${day}`,
    }),
  );
  const reopen = await command("day", "reopen", day, "--yes");
  expect(reopen.code, JSON.stringify(reopen.result)).toBe(0);
  expect(reopen.result.data).toMatchObject({
    oldStatus: "final",
    newStatus: "crawled",
  });

  const original = deps;
  const listing = `<div id="dlpage">
    <h3>Showing new listings for Tuesday, 17 November 2026</h3>
    <dl><dt><a name="item1"></a><a href="/abs/2611.99999" title="Abstract">arXiv:2611.99999</a></dt>
      <dd><div class="list-title">Title: A late arXiv paper</div>
      <div class="list-authors"><a>Test Author</a></div>
      <div class="list-subjects"><span class="primary-subject">Computer Vision (cs.CV)</span></div>
      <p class="mathjax">A paper from the late list.</p></dd></dl></div>`;
  try {
    deps = {
      ...original,
      flow: { ...original.flow, now: () => new Date(runDay + "T03:30:00Z") },
      fetch: async (input, init) =>
        new URL(String(input)).pathname === "/list/cs.CV/new"
          ? new Response(listing)
          : original.fetch(input, init),
    };
    const fetched = await command("daily", "fetch", "--day", runDay);
    expect(fetched.code, JSON.stringify(fetched.result)).toBe(0);
    expect(fetched.result.data.arxivAdded).toBe(1);
    const { result } = await command("daily", "status");
    expect(
      result.data.find((row: { day: string }) => row.day === day),
    ).toMatchObject({
      status: "crawled",
      target: true,
      crawled: true,
      digested: false,
    });
    expect(
      result.data.find((row: { day: string }) => row.day === runDay),
    ).toMatchObject({
      status: "pending",
      crawled: false,
    });
    expect((await command("summaries", "todo")).result.data).toMatchObject({
      day,
      chunks: [
        expect.arrayContaining([
          expect.objectContaining({ title: "A late arXiv paper" }),
        ]),
      ],
    });
  } finally {
    deps = original;
  }
});
