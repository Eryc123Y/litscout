import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { ingestPapers } from "@litscout/db/ingest-papers";
import { writeBudgetUsage } from "@litscout/db/write-budget";
import { app } from "../src/app";
import { paperDetails, savePaper } from "../src/library-resolution";
import { workerEnv } from "./helpers/worker-env";
import { countingDb } from "./helpers/counting-db";

let harness: Awaited<ReturnType<typeof databaseHarness>>;
let db: D1Database;
let counter: ReturnType<typeof countingDb>;
const utcDay = () => new Date().toISOString().slice(0, 10);
const bindings = (storage: Record<string, unknown> = {}) => ({
  ...workerEnv().env,
  DB: counter.db,
  LOCAL_DEV: "true",
  STORAGE_CONFIG: JSON.stringify(storage),
});
const path = "/api/v1/ingest/prune";
const call = (url: string, env: ReturnType<typeof bindings>, body?: object) =>
  app.request(
    "https://worker.example" + url,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
    env,
  );
const fixture = (arxiv: string) => ({
  key: arxiv,
  source: "arxiv",
  title: "Archived " + arxiv,
  abstract: "Old abstract",
  identifiers: [{ scheme: "arxiv", value: arxiv }],
});
beforeAll(async () => {
  harness = await databaseHarness("d1");
  db = harness.db.$client as D1Database;
  counter = countingDb(db);
  await ingestPapers(
    db,
    "2026-09-01",
    ["2609.10101", "2609.10102", "2609.10103"].map(fixture),
  );
});
afterAll(async () => harness?.close());

it("previews without writes and conserves the crawl reserve and daily cap even with concurrent requests", async () => {
  const env = bindings({ pruneRowsPerDay: 85 });
  const day = utcDay();
  counter.reset();
  const preview = await (
    await call(path, env)
  ).json<{ data: { rows: unknown[] } }>();
  expect(preview.data.rows).toHaveLength(3);
  expect(counter.stats()).toMatchObject({ rowsWritten: 0 });
  await db
    .prepare("INSERT INTO daily_write_usage(day,rows_written) VALUES (?,?)")
    .bind(day, 39_000)
    .run();
  expect(await (await call(path, env, {})).json()).toMatchObject({
    data: { papersPruned: 0 },
  });
  await db.prepare("DELETE FROM daily_write_usage WHERE day=?").bind(day).run();
  const requests = await Promise.all([
    call(path, env, {}),
    call(path, env, {}),
  ]);
  expect(requests.map((r) => r.status)).toEqual([200, 200]);
  const remaining = await db
    .prepare("SELECT count(*) AS n FROM papers")
    .first<number>("n");
  expect(remaining).toBeGreaterThanOrEqual(1);
  expect(remaining).toBeLessThan(3);
  expect((await writeBudgetUsage(db, day)).reserved).toBe(0);
  const report = await call(path, env, { waiting: remaining });
  expect(report.ok).toBe(true);
  const health = await call("/api/v1/operations/health", env);
  expect(await health.json()).toMatchObject({
    data: {
      pruning: {
        lastAt: expect.any(String),
        papersPruned: 3 - remaining!,
        rowsUsed: expect.any(Number),
        waiting: remaining,
      },
    },
  });
  expect(counter.stats().maxParams).toBeLessThanOrEqual(100);
});
it("can be switched off and reads details only on explicit request, then saves the retained ID", async () => {
  expect(
    await (await call(path, bindings({ prune: false }), {})).json(),
  ).toMatchObject({ data: { enabled: false, papersPruned: 0 } });
  const archive = { paper_id: "pap_details_archive", arxiv_id: "2609.11111" };
  await db
    .prepare(
      "INSERT INTO paper_index(paper_id,arxiv_id,day,title) VALUES (?,?,'2026-09-01','Archived details')",
    )
    .bind(archive.paper_id, archive.arxiv_id)
    .run();
  const env = bindings();
  const outbound = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.openalex.org")
      return Response.json({ results: [] });
    if (url.hostname === "export.arxiv.org")
      return new Response(
        `<feed><entry><id>https://arxiv.org/abs/${archive.arxiv_id}</id><title>Recovered paper</title><summary>Recovered abstract</summary><author><name>Example Author</name></author></entry></feed>`,
        { headers: { "Content-Type": "application/atom+xml" } },
      );
    throw new Error("Unexpected metadata request");
  });
  vi.stubGlobal("fetch", outbound);
  expect(
    await paperDetails(env, "arxiv:" + archive.arxiv_id, false),
  ).toMatchObject({
    record: { paperId: archive.paper_id, compact: true },
    detailsStored: false,
  });
  expect(outbound).not.toHaveBeenCalled();
  const details = await call(
    "/api/v1/papers/" + archive.paper_id + "/details",
    env,
  );
  expect(await details.json()).toMatchObject({
    data: {
      abstract: "Recovered abstract",
      authors: [{ name: "Example Author" }],
    },
  });
  expect(
    outbound.mock.calls.map(([url]) => new URL(String(url)).hostname),
  ).toEqual(["api.openalex.org", "export.arxiv.org"]);
  expect(
    await db
      .prepare("SELECT id FROM papers WHERE id=?")
      .bind(archive.paper_id)
      .first(),
  ).toBeNull();
  expect(await savePaper(env, archive.paper_id, false, "mcp")).toMatchObject({
    paperId: archive.paper_id,
    status: "saved",
  });
  expect(
    await db
      .prepare("SELECT id,abstract FROM papers WHERE id=?")
      .bind(archive.paper_id)
      .first(),
  ).toMatchObject({ id: archive.paper_id, abstract: "Recovered abstract" });
});

it("exports a compact research reference and verifies and restores the logical row", async () => {
  const { collectBackup, backupReader, verifyBackup } =
    await import("@litscout/pipeline/backup");
  const { readBackupPapers, restoreCompactPapers } =
    await import("@litscout/db/backup");
  const archived = await db
    .prepare("SELECT paper_id FROM paper_index WHERE has_canonical=0 LIMIT 1")
    .first<string>("paper_id");
  // Create an index-only reference as can happen when syncing older vault data.
  const id = archived ?? "pap_old_vault";
  if (!archived)
    await db
      .prepare(
        `INSERT INTO paper_index(paper_id,day,title,title_norm,arxiv_id)
    VALUES (?,'2026-09-01','Vault archive','vault archive','2609.12345')`,
      )
      .bind(id)
      .run();
  await db
    .prepare(
      `INSERT INTO notes(id,target_type,target_id,body_md,origin)
    VALUES ('note_archive','paper',?,'Archive reference','web')`,
    )
    .bind(id)
    .run();
  const env = { ...bindings(), BACKUP_COOLDOWN: "off" };
  const bundle = await collectBackup(
    backupReader(async (url, init) =>
      app.request(
        new URL(url, "https://worker.example"),
        {
          ...init,
          headers: { ...init?.headers, "Sec-Fetch-Site": "same-origin" },
        },
        env,
      ),
    ),
  );
  expect(verifyBackup(bundle)).toEqual([]);
  expect(bundle.data.papers).toContainEqual(
    expect.objectContaining({ id, compact: true }),
  );
  const restored = await databaseHarness("d1");
  try {
    const into = restored.db.$client as D1Database;
    const compact = bundle.data.papers.filter((p) => "compact" in p);
    await restoreCompactPapers(into, compact);
    await restoreCompactPapers(into, compact);
    expect(
      (
        await readBackupPapers(
          into,
          compact.map(({ id }) => ({ id })),
        )
      ).map(({ paper }) => paper),
    ).toEqual(compact);
    expect(
      await into
        .prepare("SELECT paper_id,has_canonical FROM paper_index")
        .first(),
    ).toEqual({ paper_id: id, has_canonical: 0 });
    expect(
      await into
        .prepare("SELECT count(*) FROM papers")
        .first<number>("count(*)"),
    ).toBe(0);
  } finally {
    await restored.close();
  }
});

it("restores on rating and vault linking using OpenAlex when it has the details", async () => {
  const env = bindings();
  const note = "a".repeat(64);
  await db
    .prepare(
      `INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
    VALUES (?,'Idea.md','idea','Idea','{}',?,?,?,'2026-09-02')`,
    )
    .bind(note, note, note, note)
    .run();
  const actions = [
    [
      "/api/v1/events",
      "pap_rate_archive",
      { paperId: "pap_rate_archive", kind: "rate_up", source: "web" },
    ],
    [
      "/api/v1/vault/requests",
      "pap_link_archive",
      { paperId: "pap_link_archive", kind: "link_paper", targetNoteId: note },
    ],
  ] as const;
  for (const [route, id, body] of actions) {
    const doi = "10.1234/" + id;
    await db
      .prepare(
        "INSERT INTO paper_index(paper_id,doi,day,title) VALUES (?,?,'2026-09-01','Retained title')",
      )
      .bind(id, doi)
      .run();
    const fetcher = vi.fn<typeof fetch>(async (request) => {
      expect(new URL(String(request)).hostname).toBe("api.openalex.org");
      return Response.json({
        id: "https://openalex.org/W123",
        doi: "https://doi.org/" + doi,
        display_name: "Provider title",
        abstract_inverted_index: { Details: [0], returned: [1] },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await call(route, env, body);
    expect(response.ok, await response.clone().text()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await db
        .prepare("SELECT id,abstract FROM papers WHERE id=?")
        .bind(id)
        .first(),
    ).toEqual({ id, abstract: "Details returned" });
  }
});

it("ignores malformed stored identifiers before fetching or constructing links", async () => {
  const env = bindings();
  const id = "pap_bad_archive_ids";
  await db
    .prepare(
      "INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title) VALUES (?,?,?,'2026-09-01','Malformed identifiers')",
    )
    .bind(id, "not an arXiv ID", "not a DOI")
    .run();
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ results: [] }),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    const response = await call("/api/v1/papers/" + id + "/details", env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { available: false, identifiers: [], links: [] },
    });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("loads a compact arXiv DOI using the same normalized identity as OpenAlex", async () => {
  const env = bindings();
  const id = "pap_arxiv_doi_archive";
  const doi = "10.48550/arXiv.2609.55555";
  await db
    .prepare(
      "INSERT INTO paper_index(paper_id,doi,day,title) VALUES (?,?,'2026-09-01','Archive DOI')",
    )
    .bind(id, doi)
    .run();
  const fetcher = vi.fn<typeof fetch>(async (request) => {
    expect(new URL(String(request)).hostname).toBe("api.openalex.org");
    return Response.json({
      id: "https://openalex.org/W321",
      doi: "https://doi.org/" + doi.toLowerCase(),
      display_name: "Provider title",
      abstract_inverted_index: { Details: [0], returned: [1] },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const response = await call("/api/v1/papers/" + id + "/details", env);
    expect(await response.json()).toMatchObject({
      data: { available: true, abstract: "Details returned" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("limits repeated authenticated detail loads before calling metadata providers", async () => {
  const env = bindings();
  const id = "pap_details_limited";
  await db
    .prepare(
      "INSERT INTO paper_index(paper_id,day,title) VALUES (?,'2026-09-01','Limited details')",
    )
    .bind(id)
    .run();
  const limiter = env.PAIRING_STORE.get(
    env.PAIRING_STORE.idFromName("http:compact-details"),
  );
  const limit = vi.spyOn(limiter, "allowRequest").mockResolvedValue({
    allowed: false,
    retryAfter: 20,
    [Symbol.dispose]: () => undefined,
  });
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  try {
    const response = await call("/api/v1/papers/" + id + "/details", env);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("20");
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    limit.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("limits detail loads per caller with a global ceiling", async () => {
  const env = bindings();
  const id = "pap_details_buckets";
  await db
    .prepare(
      "INSERT INTO paper_index(paper_id,day,title) VALUES (?,'2026-09-01','Bucket details')",
    )
    .bind(id)
    .run();
  const names = vi.spyOn(env.PAIRING_STORE, "idFromName");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => Response.json({})),
  );
  try {
    await call("/api/v1/papers/" + id + "/details", env);
    const buckets = names.mock.calls.map(([name]) => name);
    expect(buckets).toContain("http:compact-details:owner");
    expect(buckets).toContain("http:compact-details");
  } finally {
    names.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("keeps archive-only fields and index-only papers out of the public paper route", async () => {
  const id = "pap_public_archive";
  const hidden = "pap_private_archive";
  await db.batch([
    db
      .prepare(
        "INSERT INTO paper_index(paper_id,day,title) VALUES (?,'2026-08-01','Public historical paper'),(?,'2026-08-01','Private historical paper')",
      )
      .bind(id, hidden),
    db.prepare("INSERT OR IGNORE INTO feed_days(day) VALUES ('2026-09-01')"),
    db
      .prepare(
        "INSERT INTO feed_items(day,paper_id,source) VALUES ('2026-09-01',?,'arxiv')",
      )
      .bind(id),
  ]);
  const env = { ...bindings(), PUBLIC_FEED: "true" };
  const response = await call("/api/v1/public/papers/" + id, env);
  expect(response.status).toBe(200);
  const { data } = await response.json<{ data: Record<string, unknown> }>();
  expect(data.title).toBe("Public historical paper");
  expect(data).not.toHaveProperty("firstSeenOn");
  expect(data).not.toHaveProperty("compact");
  expect((await call("/api/v1/public/papers/" + hidden, env)).status).toBe(404);
  expect(
    (await call("/api/v1/public/papers/" + id + "/details", env)).status,
  ).toBe(404);
});

it("rejects a prune lease from the previous UTC day even if the instance is still on the same local day", async () => {
  const { retentionBatch } = await import("../src/retention");
  const env = {
    ...bindings(),
    INSTANCE_CONFIG: JSON.stringify({ timezone: "Asia/Kuala_Lumpur" }),
  };
  const expiredDay = new Date(Date.parse(utcDay()) - 1);
  const result = await ingestPapers(db, "2026-08-01", [fixture("2608.02222")]);
  const id = result.papers[0]!.paperId;
  const outcome = await retentionBatch(env, expiredDay, {}, false, 1);
  expect(outcome.papersPruned).toBe(0);
  expect(
    await db.prepare("SELECT id FROM papers WHERE id=?").bind(id).first("id"),
  ).toBe(id);
});

it("charges failed prune attempts against the daily prune cap even after their lease is settled", async () => {
  const env = bindings({ pruneRowsPerDay: 70 });
  const { retentionBatch } = await import("../src/retention");
  await db.batch([
    db.prepare("DELETE FROM daily_write_usage WHERE day=?").bind(utcDay()),
    db.prepare("DELETE FROM runs WHERE id=?").bind("prune:" + utcDay()),
    db.prepare(
      "CREATE TRIGGER test_abort_prune BEFORE DELETE ON papers BEGIN SELECT RAISE(ABORT,'test batch rollback'); END",
    ),
  ]);
  try {
    await expect(retentionBatch(env, new Date(), {}, false, 1)).rejects.toThrow(
      /test batch rollback/,
    );
    const preview = await retentionBatch(env, new Date(), {}, true, 1);
    expect(preview.available).toBeLessThan(30);
    expect(
      (await retentionBatch(env, new Date(), {}, false, 1)).papersPruned,
    ).toBe(0);
  } finally {
    await db.prepare("DROP TRIGGER test_abort_prune").run();
  }
});

it("prices historical counter fan-out before admitting a small ordinary upload", async () => {
  const env = bindings();
  const incoming = { ...fixture("2608.09998"), venue: "New venue" };
  const id = (
    await ingestPapers(db, "2026-08-01", [{ ...incoming, venue: "Old venue" }])
  ).papers[0]!.paperId;
  await db.batch([
    db.prepare(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100)
      INSERT OR IGNORE INTO feed_days(day) SELECT date('2026-01-01','+'||n||' days') FROM seq`),
    db
      .prepare(
        `WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100)
      INSERT INTO feed_items(day,paper_id,source) SELECT date('2026-01-01','+'||n||' days'),?,'arxiv' FROM seq`,
      )
      .bind(id),
    db
      .prepare(
        "INSERT INTO daily_write_usage(day,rows_written) VALUES (?,79875) ON CONFLICT(day) DO UPDATE SET rows_written=excluded.rows_written",
      )
      .bind(utcDay()),
  ]);
  try {
    const response = await call("/api/v1/ingest/papers", env, {
      day: "2026-08-01",
      papers: [incoming],
    });
    expect(response.status).toBe(429);
    expect(
      await db
        .prepare("SELECT venue FROM papers WHERE id=?")
        .bind(id)
        .first("venue"),
    ).toBe("Old venue");
    expect((await writeBudgetUsage(db, utcDay())).used).toBeLessThanOrEqual(
      80_000,
    );
  } finally {
    await db
      .prepare("DELETE FROM daily_write_usage WHERE day=?")
      .bind(utcDay())
      .run();
  }
});

it("rejects an archive restore at the daily write limit before fetching details", async () => {
  const env = bindings();
  const id = "pap_restore_no_budget";
  await db.batch([
    db
      .prepare(
        "INSERT INTO paper_index(paper_id,arxiv_id,day,title) VALUES (?,'2609.22222','2026-09-01','Archived paper')",
      )
      .bind(id),
    db
      .prepare(
        "INSERT INTO daily_write_usage(day,rows_written) VALUES (?,80000) ON CONFLICT(day) DO UPDATE SET rows_written=excluded.rows_written",
      )
      .bind(utcDay()),
  ]);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
  vi.stubGlobal("fetch", fetcher);
  try {
    const response = await call("/api/v1/library", env, {
      paperId: id,
      source: "web",
    });
    expect(response.status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await db.prepare("SELECT id FROM papers WHERE id=?").bind(id).first(),
    ).toBeNull();
  } finally {
    vi.unstubAllGlobals();
    await db
      .prepare("DELETE FROM daily_write_usage WHERE day=?")
      .bind(utcDay())
      .run();
  }
});

it("uses the instance day for the age boundary on both sides of UTC midnight", async () => {
  const { retentionBatch } = await import("../src/retention");
  const arxiv = "2610.10005";
  const title = fixture(arxiv).title;
  await ingestPapers(db, "2026-10-05", [fixture(arxiv)]);
  const preview = async (timezone: string, instant: string) => {
    const env = {
      ...bindings({ fullDays: 1 }),
      INSTANCE_CONFIG: JSON.stringify({ timezone }),
    };
    const page = await retentionBatch(env, new Date(instant), {}, true, 40);
    return page.rows.find((row) => row.title === title);
  };
  expect(await preview("UTC", "2026-10-05T23:59:59Z")).toMatchObject({
    eligible: false,
    reasons: ["recent"],
  });
  expect(
    await preview("Asia/Kuala_Lumpur", "2026-10-05T23:59:59Z"),
  ).toMatchObject({ eligible: true });
  expect(await preview("UTC", "2026-10-06T00:00:00Z")).toMatchObject({
    eligible: true,
  });
});

it("authenticates prune and legacy quote before parsing and bounds their bodies", async () => {
  const { INGEST_CAPS } = await import("@litscout/core/ingest-limits");
  const { digest } = await import("../src/auth/crypto");
  const env = {
    ...bindings(),
    LOCAL_DEV: "false",
    ACCESS_TEAM_DOMAIN: "unit-team.example",
    ACCESS_AUD: "unit-audience",
  };
  const tokens = {
    read: "lsk_" + "R".repeat(52),
    ingest: "lsk_" + "I".repeat(52),
  };
  for (const [scope, token] of Object.entries(tokens))
    await db
      .prepare(
        "INSERT INTO api_tokens(id,name,hash,scopes,last_used_at) VALUES (?,?,?,?,?)",
      )
      .bind(
        "m4k-" + scope,
        scope,
        await digest(token),
        JSON.stringify([scope]),
        new Date().toISOString(),
      )
      .run();
  const request = (path: string, scope?: keyof typeof tokens, body?: string) =>
    app.request(
      "https://worker.example/api/v1" + path,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(scope ? { authorization: "Bearer " + tokens[scope] } : {}),
        },
        body,
      },
      env,
    );
  try {
    for (const path of ["/ingest/prune", "/ingest/papers"]) {
      expect((await request(path, undefined, "{")).status).toBe(401);
      expect((await request(path, "read", "{")).status).toBe(403);
      expect((await request(path, "ingest", "{")).status).toBe(400);
      expect(
        (await request(path, "ingest", " ".repeat(INGEST_CAPS.bytes + 1)))
          .status,
      ).toBe(413);
    }
    // The preview names papers and why they are kept: private reading state.
    expect((await request("/ingest/prune", "read")).status).toBe(200);
    expect((await request("/ingest/prune", "ingest")).status).toBe(403);
    expect(
      (
        await request(
          "/ingest/prune",
          "ingest",
          JSON.stringify({ waiting: 1e12 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          "/ingest/papers",
          "ingest",
          JSON.stringify({
            day: "2026-09-01",
            legacy: "plan",
            papers: [fixture("2609.10010")],
          }),
        )
      ).status,
    ).toBe(200);
    expect((await request("/papers/pap_test/details", "ingest")).status).toBe(
      403,
    );
  } finally {
    await db
      .prepare("DELETE FROM api_tokens WHERE id IN ('m4k-read','m4k-ingest')")
      .run();
  }
});
