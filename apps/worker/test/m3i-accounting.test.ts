import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { hashVaultText } from "@litscout/db/vault-index";
import { ingestSummaries, SummaryCounterConflict } from "@litscout/db/ingest";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";
import { countingDb } from "./helpers/counting-db";

const bindings = workerEnv().env;

const date = "2026-11-17";
const budgetDay = () => new Date().toISOString().slice(0, 10);
const papers = Array.from({ length: 24 }, (_, i) => ({
  key: `2611.${32100 + i}`,
  title: `Stereo depth paper ${i}`,
  abstract: "Binocular vision",
  source: "arxiv",
  venue: "arXiv",
  identifiers: [
    { scheme: "arxiv", value: `2611.${32100 + i}` },
    { scheme: "doi", value: `10.1234/stereo-${i}` },
  ],
  links: [
    { kind: "landing", url: `https://doi.org/10.1234/stereo-${i}` },
    { kind: "pdf_arxiv", url: `https://arxiv.org/pdf/2611.${32100 + i}` },
  ],
  topics: i % 2 ? ["Stereo", "Vision"] : ["Stereo"],
  shortlisted: i < 8,
}));
const content = {
  tldr: "Stereo",
  motivation: "M",
  method: "M",
  result: "R",
  conclusion: "C",
};
let db: D1Database,
  close: () => Promise<void>,
  meter: ReturnType<typeof countingDb>;
const token = "lsk_" + "R".repeat(52);
const call = (path: string, method: string, body: unknown) =>
  app.request(
    "/api/v1" + path,
    {
      method,
      body: JSON.stringify(body),
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
    },
    { ...bindings, DB: meter.db, LOCAL_DEV: "true" },
  );
const ledger = () =>
  db
    .prepare("SELECT rows_written,reserved FROM daily_write_usage WHERE day=?")
    .bind(budgetDay())
    .first<{ rows_written: number; reserved: number }>();

beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  db = h.db.$client as unknown as D1Database;
  meter = countingDb(db);
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_m3i','test',?,?)",
    )
    .bind(
      await hashVaultText(token),
      JSON.stringify(["ingest", "read", "write", "vault"]),
    )
    .run();
});
afterAll(async () => close?.());

it("includes charged migration writes in the budget breakdown", async () => {
  await db.batch([
    db.prepare(`CREATE TABLE migration_write_usage(
      name TEXT PRIMARY KEY, day TEXT NOT NULL, rows_written INTEGER NOT NULL
    ) WITHOUT ROWID`),
    db
      .prepare(
        "INSERT INTO migration_write_usage VALUES ('0017',?,25990),('past','2000-01-01',17)",
      )
      .bind(budgetDay()),
  ]);
  const response = await app.request(
    "/api/v1/budget",
    {
      headers: { authorization: "Bearer " + token },
    },
    { ...bindings, DB: db, LOCAL_DEV: "true" },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { migration: 25990 } });
});

it("records the sum of raw D1 metadata across an authenticated ingest and vault refresh", async () => {
  let written = 0;
  async function upload(path: string, method: string, body: unknown) {
    meter.reset();
    const res = await call(path, method, body);
    expect(res.status, await res.clone().text()).toBe(200);
    const payload = (await res.json()) as {
      data: { papers: { paperId: string }[] };
      meta: {
        rowsWritten: number;
        authRowsWritten: number;
        budgetRowsWritten: number;
      };
    };
    const { rowsWritten, authRowsWritten, budgetRowsWritten } = payload.meta;
    expect(meter.stats().rowsWritten).toBe(
      rowsWritten + authRowsWritten + budgetRowsWritten,
    );
    written += meter.stats().rowsWritten;
    expect(await ledger()).toEqual({ rows_written: written, reserved: 0 });
    return payload;
  }
  const first = await upload("/ingest/papers", "POST", { day: date, papers });
  expect(first.meta.rowsWritten).toBeGreaterThan(papers.length * 27);
  expect(first.meta.authRowsWritten).toBe(1);
  const replay = await upload("/ingest/papers", "POST", { day: date, papers });
  expect(replay.meta.rowsWritten).toBe(0);
  const summaries = first.data.papers
    .slice(0, 8)
    .map(({ paperId }) => ({ paperId, content }));
  const summary = await upload("/ingest/summaries", "POST", {
    day: date,
    summaries,
  });
  expect(summary.meta.rowsWritten).toBe(6 * summaries.length);
  await upload("/ingest/feed-day", "POST", { day: date, status: "summarised" });
  await upload("/digests/" + date, "PUT", {
    day: date,
    bodyMd: "# Stereo digest",
    picks: [summaries[0]!.paperId],
  });

  const path = "Fixture/Reference.md";
  const id = await hashVaultText(path),
    snapshot = await hashVaultText("snapshot");
  await upload("/vault/index", "PUT", {
    snapshot,
    previous: null,
    part: 0,
    notes: [
      {
        id,
        path,
        kind: "paper_note",
        title: papers[0]!.title,
        frontmatter: {},
        hash: id,
        bodyHash: id,
      },
    ],
  });
  await upload("/vault/index", "PUT", {
    snapshot,
    previous: null,
    parts: 1,
    count: 1,
    changes: 1,
  });
  const refresh = await upload("/vault/index", "PUT", {
    snapshot,
    previous: snapshot,
    parts: 1,
    count: 1,
    changes: 0,
  });
  expect(refresh.meta.rowsWritten).toBe(0);
});

it("reserves the summary counter writes for papers that appeared on many days", async () => {
  const id = "pap_repeated";
  await db.batch([
    db
      .prepare(
        "INSERT INTO papers(id,title,title_norm) VALUES (?,'Repeated paper','repeated')",
      )
      .bind(id),
    ...Array.from({ length: 30 }, (_, i) => {
      const day = `2026-10-${String(i + 1).padStart(2, "0")}`;
      return [
        db.prepare("INSERT INTO feed_days(day) VALUES (?)").bind(day),
        db
          .prepare(
            "INSERT INTO feed_items(day,paper_id,source) VALUES (?,?,'arxiv')",
          )
          .bind(day, id),
      ];
    }).flat(),
    db
      .prepare(
        "INSERT INTO daily_write_usage(day,rows_written,reserved) VALUES (?,79975,0) ON CONFLICT(day) DO UPDATE SET rows_written=79975",
      )
      .bind(budgetDay()),
  ]);
  const request = { summaries: [{ paperId: id, content }] };
  const response = await call("/ingest/summaries", "POST", request);
  expect(response.status, await response.clone().text()).toBe(429);
  expect(await ledger()).toEqual({ rows_written: 79975, reserved: 0 });
  const absent = await db
    .prepare("SELECT 1 FROM summaries WHERE paper_id=?")
    .bind(id)
    .first();
  expect(absent).toBe(null);
  // The write transaction also rejects a plan that went stale after reserving.
  await expect(ingestSummaries(db, request, 29)).rejects.toBeInstanceOf(
    SummaryCounterConflict,
  );
  expect(
    await db
      .prepare("SELECT 1 FROM summaries WHERE paper_id=?")
      .bind(id)
      .first(),
  ).toBe(null);

  await db
    .prepare("UPDATE daily_write_usage SET rows_written=70000 WHERE day=?")
    .bind(budgetDay())
    .run();
  meter.reset();
  const retry = await call("/ingest/summaries", "POST", request);
  expect(retry.status).toBe(200);
  expect(await ledger()).toEqual({
    rows_written: 70000 + meter.stats().rowsWritten,
    reserved: 0,
  });
});

it("reserves for hundreds of identifiers and links before merging stored papers", async () => {
  const now = budgetDay();
  await db.batch([
    db.prepare(`INSERT INTO papers(id,title,title_norm,created_at) VALUES
      ('pap_merge_keep','Merge target','merge','2020-01-01'),
      ('pap_merge_drop','Merge duplicate','merge','2020-01-02')`),
    db.prepare(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_merge_keep','arxiv','2611.99999')",
    ),
    db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<400)
      INSERT INTO paper_ids(paper_id,scheme,value) SELECT 'pap_merge_drop','doi','10.1234/merge-'||x FROM n`),
    db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<400)
      INSERT INTO paper_links(id,paper_id,kind,url)
      SELECT 'lnk_merge_'||x,'pap_merge_drop','landing','https://example.org/'||x FROM n`),
    db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<15)
      INSERT INTO feed_days(day) SELECT printf('2026-08-%02d',x) FROM n`),
    db
      .prepare(
        `INSERT INTO feed_items(day,paper_id,source,topics)
      SELECT day,'pap_merge_keep','arxiv',? FROM feed_days WHERE day LIKE '2026-08-%'`,
      )
      .bind(
        JSON.stringify(
          Array.from({ length: 50 }, (_, index) => "Topic " + index),
        ),
      ),
    db.prepare(
      "UPDATE api_tokens SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='tok_m3i'",
    ),
    db
      .prepare(
        `INSERT INTO daily_write_usage(day,rows_written,reserved) VALUES (?,79900,0)
      ON CONFLICT(day) DO UPDATE SET rows_written=79900,reserved=0,
        unaccounted=0,estimate_overrun=0`,
      )
      .bind(now),
  ]);
  const input = {
    day: date,
    papers: [
      {
        key: "2611.99999",
        title: "Merged paper",
        abstract: "An abstract for the surviving paper.",
        source: "arxiv",
        identifiers: [
          { scheme: "arxiv", value: "2611.99999" },
          { scheme: "doi", value: "10.1234/merge-1" },
        ],
      },
    ],
  };
  const denied = await call("/ingest/papers", "POST", input);
  expect(denied.status, await denied.clone().text()).toBe(429);
  const reserved = Number(denied.headers.get("X-Write-Budget-needed"));
  expect(reserved).toBeGreaterThan(800);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM paper_links WHERE paper_id='pap_merge_drop'",
      )
      .first("n"),
  ).toBe(400);
  await db
    .prepare("UPDATE daily_write_usage SET rows_written=70000 WHERE day=?")
    .bind(now)
    .run();
  const merged = await call("/ingest/papers", "POST", input);
  expect(merged.status, await merged.clone().text()).toBe(200);
  const { meta } = await merged.json<{
    meta: {
      rowsWritten: number;
      authRowsWritten: number;
      budgetRowsWritten: number;
    };
  }>();
  const recorded = meta.rowsWritten + meta.authRowsWritten;
  expect(recorded).toBeGreaterThan(2500);
  expect(recorded).toBeLessThanOrEqual(reserved);
  expect(await ledger()).toEqual({
    rows_written: 70000 + recorded + meta.budgetRowsWritten,
    reserved: 0,
  });
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM paper_links WHERE paper_id='pap_merge_keep'",
      )
      .first("n"),
  ).toBe(400);
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM paper_ids WHERE paper_id='pap_merge_keep'",
      )
      .first("n"),
  ).toBe(401);
});

it("shows and enforces the same reduced cap in budget, Health and a rejected write", async () => {
  const day = budgetDay();
  await db
    .prepare(
      `INSERT INTO daily_write_usage(day,rows_written,unaccounted) VALUES (?,75000,42)
      ON CONFLICT(day) DO UPDATE SET rows_written=75000,reserved=0,unaccounted=42`,
    )
    .bind(day)
    .run();
  const read = (route: string) =>
    app.request(
      "/api/v1" + route,
      {},
      { ...bindings, DB: db, LOCAL_DEV: "true" },
    );
  const expected = {
    used: 75000,
    limit: 75000,
    baseLimit: 80000,
    unaccounted: 42,
  };
  expect(await (await read("/budget")).json()).toMatchObject({
    data: expected,
  });
  expect(await (await read("/vault/budget")).json()).toMatchObject({
    data: expected,
  });
  expect(await (await read("/operations/health")).json()).toMatchObject({
    data: { budget: expected },
  });
  const denied = await call("/ingest/feed-day", "POST", {
    day,
    status: "crawled",
  });
  expect(denied.status).toBe(429);
  expect(await denied.json()).toMatchObject({
    error: { limit: 75000, remaining: 0 },
  });
});
