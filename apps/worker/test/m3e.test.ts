import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { writeEvidence } from "@litscout/db/test/evidence";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { collectBackup, verifyBackup } from "@litscout/pipeline/backup";
import {
  backupBundleSchema,
  backupPageSchema,
  backupPaperPageSchema,
  backupSectionSchemas,
  backupSections,
  backupPaperBatchSize,
} from "@litscout/pipeline/backup-contracts";
import { healthSchema } from "@litscout/pipeline/health-contracts";
import { app, scheduled } from "../src/app";
import { countingDb } from "./helpers/counting-db";
import { workerEnv } from "./helpers/worker-env";

const fixtureEnv = workerEnv().env;
const now = new Date("2026-11-20T07:00:00.000Z");
const token = (letter: string) => "lsk_" + letter.repeat(52);
const id = "43d91359-fbdc-4047-a843-30e90031a4df";
const firstRun = "0b7c1e4a-2f5d-4c8e-9a61-3d2e5f7a8b90";
const report = {
  id,
  startedAt: "2026-11-19T02:00:00.000Z",
  targetDay: "2026-11-19",
  finishedAt: "2026-11-19T03:00:00.000Z",
  steps: {
    fetch: { status: "done" },
    summaries: { status: "done", client: "codex", fallback: true },
    digest: { status: "done", client: "claude" },
    sync: { status: "failed", error: "operation-failed" },
    legacy: { status: "skipped" },
  },
  rowsWritten: 430,
};
let counter: ReturnType<typeof countingDb>;
let close: () => Promise<void>;

beforeAll(async () => {
  const harness = await databaseHarness("d1");
  close = harness.close;
  counter = countingDb(harness.db.$client as unknown as D1Database);
  await counter.db.batch(
    [
      ["R", "read"],
      ["I", "ingest"],
      ["W", "write"],
      ["X", "write"],
    ].map(([letter, scope]) =>
      counter.db
        .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
        .bind(
          letter,
          scope,
          createHash("sha256").update(token(letter!)).digest("hex"),
          JSON.stringify([scope]),
        ),
    ),
  );
}, 90_000);
afterAll(async () => close?.());

const request = (
  path: string,
  auth?: string,
  body?: unknown,
  access?: string,
) =>
  app.request(
    "/api/v1" + path,
    {
      method: body ? "POST" : "GET",
      headers: auth
        ? { authorization: "Bearer " + token(auth) }
        : access
          ? {
              "Cf-Access-Jwt-Assertion": access,
              "Sec-Fetch-Site": "same-origin",
            }
          : {},
      body: body ? JSON.stringify(body) : undefined,
    },
    {
      ...fixtureEnv,
      DB: counter.db,
      ACCESS_TEAM_DOMAIN: "test.invalid",
      ACCESS_AUD: "synthetic",
      PUBLIC_FEED: "true",
      INSTANCE_CONFIG: JSON.stringify({
        name: "Research",
        timezone: "Asia/Kuala_Lumpur",
        language: "en",
        topics: ["Vision"],
      }),
      HEALTH_ON_TIME_BY: "11:00",
    },
  );
const payload = async (response: Response) =>
  ((await response.json()) as { data: unknown }).data;

it("records completion idempotently, expires old reports, and shows missing reports and digest timing within F3", async () => {
  vi.setSystemTime(now);
  expect((await request("/operations/health")).status).toBe(401);
  expect((await request("/ingest/daily-run", "R", report)).status).toBe(403);
  expect(
    (
      await request("/ingest/daily-run", "I", {
        ...report,
        steps: {
          ...report.steps,
          sync: { status: "failed", error: token("S") },
        },
      })
    ).status,
  ).toBe(400);
  const start = {
    id,
    startedAt: report.startedAt,
    targetDay: report.targetDay,
  };
  const abandoned = {
    ...start,
    id: "ccae65f9-c16a-4c6c-acc5-70d867ac23c1",
    startedAt: "2026-11-19T04:00:00.000Z",
  };
  expect((await request("/ingest/daily-run", "I", start)).status).toBe(200);
  expect((await request("/ingest/daily-run", "I", abandoned)).status).toBe(200);
  await counter.db
    .prepare(
      "INSERT INTO daily_runs(id,run_day,started_at,target_day) VALUES ('old', '2026-01-01','2026-01-01T01:00:00.000Z','2026-01-01')",
    )
    .run();
  counter.reset();
  expect((await request("/ingest/daily-run", "I", report)).status).toBe(200);
  expect(counter.stats().calls).toBeLessThanOrEqual(40);
  expect(
    await counter.db
      .prepare("SELECT id FROM daily_runs WHERE run_day='2026-01-01'")
      .first(),
  ).toBeNull();
  expect(
    (await request("/ingest/daily-run", "I", { ...report, rowsWritten: 999 }))
      .status,
  ).toBe(200);
  expect((await request("/ingest/daily-run", "I", start)).status).toBe(200);

  await counter.db.batch([
    counter.db.prepare(
      "INSERT INTO feed_days(day,counts) VALUES ('2026-11-17','{\"arxiv\":1}'), ('2026-11-18','{\"arxiv\":1}'), ('2026-11-19','{\"arxiv\":1}')",
    ),
    counter.db.prepare(
      "INSERT INTO digests(day,body_md,created_at,updated_at) VALUES ('2026-11-18','Digest','2026-11-18T03:10:00.000Z','2026-11-18T03:10:00.000Z'),('2026-11-19','Digest','2026-11-19T03:00:00.000Z','2026-11-19T12:00:00.000Z')",
    ),
    counter.db.prepare(
      "INSERT INTO sync_cursors(name,value,updated_at) VALUES ('alphaxiv:completed','opaque','2026-11-19T07:00:00.000Z')",
    ),
    counter.db.prepare("UPDATE api_tokens SET last_used_at=NULL"),
    // LitScout's first run, so the days below count as its own.
    counter.db.prepare(
      `INSERT INTO daily_runs(id,run_day,started_at,target_day) VALUES ('${firstRun}','2026-11-06','2026-11-06T02:00:00.000Z','2026-11-06')`,
    ),
  ]);
  counter.reset();
  const response = await request("/operations/health", "R");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(counter.stats().calls).toBeLessThanOrEqual(40);
  expect(counter.stats().rowsRead).toBeLessThan(800);
  const data = healthSchema.parse(await payload(response));
  expect(data.days).toHaveLength(30);
  expect(data.days).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ day: "2026-11-15", status: "no-listing" }),
      expect.objectContaining({
        day: "2026-11-17",
        status: "missed",
        reported: false,
      }),
      expect.objectContaining({
        day: "2026-11-18",
        status: "late",
        reported: false,
      }),
      expect.objectContaining({
        day: "2026-11-19",
        status: "on-time",
        reported: true,
      }),
    ]),
  );
  expect(data.firstRunDay).toBe("2026-11-06");
  expect(data.days).toContainEqual(
    expect.objectContaining({ day: "2026-11-05", status: "before-start" }),
  );
  expect(data.runs).toEqual([
    expect.objectContaining({ id: abandoned.id, finishedAt: null }),
    expect.objectContaining(report),
    expect.objectContaining({ id: firstRun, finishedAt: null }),
  ]);
  expect(data.budget).toMatchObject({
    limit: 80000,
    resetAt: "2026-11-21T00:00:00.000Z",
  });
  expect(data.mirror.completedAt).toBe("2026-11-19T07:00:00.000Z");

  // A busy schedule can fill the Health screen's 12 visible slots in three days.
  await counter.db.batch(
    Array.from({ length: 13 }, (_, index) =>
      counter.db
        .prepare(
          "INSERT INTO daily_runs(id,run_day,started_at,target_day) VALUES (?, '2026-11-20','2026-11-20T04:00:00.000Z','2026-11-20')",
        )
        .bind(`later-${index}`),
    ),
  );
  await counter.db
    .prepare("UPDATE api_tokens SET last_used_at=NULL WHERE id='R'")
    .run();
  const selected =
    "/operations/health?cutoverDays=2026-11-20,2026-11-19,2026-11-18,2026-11-17,2026-11-16";
  expect((await request(selected)).status).toBe(401);
  expect(
    (await request("/operations/health?cutoverDays=2026-11-20", "R")).status,
  ).toBe(400);
  const evidence = await request(selected, "R");
  expect(evidence.status).toBe(200);
  expect(evidence.headers.get("cache-control")).toBe("no-store");
  expect(await payload(evidence)).toMatchObject({
    hasRuns: true,
    runs: [
      { day: "2026-11-20", run: { finishedAt: null }, digestAt: null },
      { day: "2026-11-19", run: report, digestAt: "2026-11-19T03:00:00.000Z" },
    ],
  });
  expect(
    await counter.db
      .prepare("SELECT last_used_at FROM api_tokens WHERE id='R'")
      .first("last_used_at"),
  ).toBeNull();
  const outside = await request(
    "/operations/health?cutoverDays=2026-11-13,2026-11-12,2026-11-11,2026-11-10,2026-11-09",
    "R",
  );
  expect(await payload(outside)).toEqual({ hasRuns: true, runs: [] });
});

it("trims expired reports on Worker Cron when the daily agent stays offline", async () => {
  await counter.db
    .prepare(
      "INSERT INTO daily_runs(id,run_day,started_at,target_day) VALUES ('expired', '2026-01-01','2026-01-01T01:00:00.000Z','2026-01-01')",
    )
    .run();
  await scheduled({ ...workerEnv().env, DB: counter.db }, now.getTime());
  expect(
    await counter.db
      .prepare("SELECT id FROM daily_runs WHERE id='expired'")
      .first(),
  ).toBeNull();
});

it("requires write on all backup routes and accepts a signed Access caller", async () => {
  // A fixed clock, an hour before the next test's: the exports here start a
  // per-token cooldown, and at the real time it outlived "now" whenever the
  // suite ran within ten minutes before 2026-11-20T07:00Z or later.
  vi.setSystemTime(new Date(now.getTime() - 3_600_000));
  const paths = [
    "/backup",
    ...backupSections.map((section) => "/backup/" + section),
    "/backup/papers?" +
      new URLSearchParams({ include: JSON.stringify([{ id: "pap_unit" }]) }),
  ];
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = { ...(await exportJWK(publicKey)), kid: "backup", alg: "RS256" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [key] })),
  );
  const access = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "backup" })
    .setIssuer("https://test.invalid")
    .setAudience("synthetic")
    .setExpirationTime("5m")
    .sign(privateKey);
  for (const path of paths) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, "R")).status).toBe(403);
    expect((await request(path, "I")).status).toBe(403);
    expect((await request(path, "W")).status).toBe(200);
    expect((await request(path, undefined, undefined, access)).status).toBe(
      200,
    );
  }
  expect((await request("/backup/api_tokens", "W")).status).toBe(400);
  expect((await request("/backup", undefined, undefined, access)).status).toBe(
    429,
  );
});

it("allows one concurrent start per token and reports when another can start", async () => {
  vi.setSystemTime(now);
  const starts = await Promise.all([
    request("/backup", "X"),
    request("/backup", "X"),
  ]);
  expect(starts.map((response) => response.status).sort()).toEqual([200, 429]);
  expect(
    starts
      .find((response) => response.status === 429)
      ?.headers.get("Retry-After"),
  ).toBe("600");
  expect((await request("/backup/library", "X")).status).toBe(200);
  expect((await request("/backup", "W")).status).toBe(200);
  vi.setSystemTime(new Date(now.getTime() + 599_000));
  await counter.db
    .prepare("UPDATE api_tokens SET last_used_at=? WHERE id='X'")
    .bind(new Date().toISOString())
    .run();
  counter.reset();
  const blocked = await request("/backup", "X");
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("Retry-After")).toBe("1");
  expect(counter.stats().calls).toBe(1);
  expect(counter.batchRowsRead()).toBe(0);
  vi.setSystemTime(new Date(now.getTime() + 600_000));
  expect((await request("/backup", "X")).status).toBe(200);
});

it("reports corrupt stored JSON by section and key without exposing its contents", async () => {
  await counter.db
    .prepare(
      "INSERT INTO topics(id,name,keywords) VALUES ('t_bad','Bad','[private content')",
    )
    .run();
  try {
    const response = await request("/backup/topics", "W");
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("topics");
    expect(body).toContain("t_bad");
    expect(body).not.toContain("private content");
    expect((await request("/backup/topics?after=broken", "W")).status).toBe(
      400,
    );
  } finally {
    await counter.db.prepare("DELETE FROM topics WHERE id='t_bad'").run();
  }
});

it("exports private pages, keeps cursors progressing through excluded records, and omits operational secrets", async () => {
  vi.setSystemTime(new Date(now.getTime() + 1_200_000));
  await counter.db.batch([
    ...Array.from({ length: 30 }, (_, i) =>
      counter.db
        .prepare("INSERT INTO papers(id,title,title_norm) VALUES (?,?,?)")
        .bind("pap_" + String(i).padStart(2, "0"), "Paper " + i, "paper " + i),
    ),
    counter.db.prepare(
      "INSERT INTO library_items(paper_id,added_via,deleted_at) SELECT id,'test',CASE WHEN id<'pap_28' THEN 'deleted' END FROM papers",
    ),
    ...Array.from({ length: 23 }, (_, i) =>
      counter.db
        .prepare(
          "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_28','arxiv',?)",
        )
        .bind("2611." + String(i + 1).padStart(5, "0")),
    ),
    counter.db.prepare(
      "INSERT INTO paper_links(id,paper_id,kind,url) VALUES ('link_a','pap_28','landing','https://example.invalid/paper')",
    ),
    ...Array.from({ length: 22 }, (_, i) => {
      const part = String(i).padStart(2, "0");
      return counter.db
        .prepare(
          "INSERT INTO paper_links(id,paper_id,kind,url) VALUES (?,'pap_28','landing',?)",
        )
        .bind("link_" + part, "https://example.invalid/paper/" + part);
    }),
    counter.db.prepare(
      "INSERT INTO paper_links(id,paper_id,kind,url) VALUES ('hidden_link','pap_00','landing','https://example.invalid/hidden')",
    ),
    counter.db.prepare(
      "UPDATE papers SET deleted_at='deleted' WHERE id='pap_00'",
    ),

    counter.db
      .prepare(
        "INSERT INTO vault_requests(id,kind,payload,origin,created_at,claim) VALUES ('req_a','capture','{}','web','2026-11-19T00:00:00.000Z',?)",
      )
      .bind(token("S")),
    counter.db.prepare(
      "INSERT INTO paper_state(paper_id,rating) VALUES ('pap_28','up')",
    ),
    counter.db.prepare(
      "INSERT INTO notes(id,target_id,target_type,origin,body_md) VALUES ('q_a','pap_28','paper','web','Quick note')",
    ),
    counter.db.prepare(
      "INSERT INTO digests(day,kind,body_md,picks) VALUES ('2026-11-11','daily','Daily digest','[\"pap_28\"]')",
    ),
    counter.db.prepare(
      "INSERT INTO digests(day,kind,body_md,picks) VALUES ('2026-11-09','weekly','Weekly digest','[\"pap_28\"]')",
    ),
    counter.db.prepare(
      "INSERT INTO topics(id,name,keywords) VALUES ('t_a','Vision','[\"stereo\"]')",
    ),
    counter.db.prepare(
      "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES ('v_a','Idea.md','idea','Idea','{}','hash','body','fp','2026-11-19T00:00:00.000Z')",
    ),
    counter.db.prepare(
      "INSERT INTO projects(id,slug,title,status,vault_note_id) VALUES ('p_a','research','Research','active','v_a')",
    ),
    counter.db.prepare(
      "INSERT INTO idea_index(id,vault_note_id,title,updated_at) VALUES ('i_a','v_a','Idea','2026-11-19T00:00:00.000Z')",
    ),
    counter.db.prepare(
      "INSERT INTO working_paper_index(id,vault_note_id,title,updated_at) VALUES ('w_a','v_a','Draft','2026-11-19T00:00:00.000Z')",
    ),
    counter.db.prepare(
      "INSERT INTO captures(id,title,source_paper_id,created_at) VALUES ('req_a','Capture','pap_28','2026-11-19T00:00:00.000Z')",
    ),
    counter.db.prepare(
      "INSERT INTO suggestions(id,day,kind,title,body_md,created_by) VALUES ('sg_a','2026-11-19','new_idea','Suggestion','Draft idea','agent')",
    ),
    counter.db.prepare(
      "INSERT INTO alphaxiv_items(alphaxiv_id,paper_type,title,synced_at) VALUES ('draft_1','private','Mirror item','2026-11-19T00:00:00.000Z')",
    ),
    counter.db.prepare(`INSERT INTO papers(id,title,title_norm) VALUES
      ('pap_radar','Radar only','radar only'),
      ('pap_idea','Idea only','idea only'),
      ('pap_request','Request only','request only'),
      ('pap_hidden','Hidden vault reference','hidden vault reference')`),
    counter.db.prepare(
      `UPDATE digests SET radar='["legacy text",{"paperId":"pap_radar"}]' WHERE kind='weekly'`,
    ),
    counter.db.prepare(
      `UPDATE idea_index SET paper_ids='["pap_idea","pap_28"]' WHERE id='i_a'`,
    ),
    counter.db.prepare(
      `UPDATE vault_requests SET payload='{"paperId":"pap_request"}' WHERE id='req_a'`,
    ),
    counter.db
      .prepare(`INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at,deleted_at)
      VALUES ('v_deleted','Deleted.md','idea','Deleted','{}','hash','body','fp','2026-11-19T00:00:00.000Z','deleted')`),
    counter.db
      .prepare(`INSERT INTO working_paper_index(id,vault_note_id,title,paper_ids,updated_at)
      VALUES ('w_deleted','v_deleted','Deleted','["pap_hidden"]','2026-11-19T00:00:00.000Z')`),
    counter.db
      .prepare(`INSERT INTO notes(id,target_id,target_type,origin,body_md,deleted_at)
      VALUES ('q_hidden','pap_hidden','paper','web','Deleted note','deleted')`),
  ]);
  counter.reset();
  const first = await request("/backup/library", "W");
  expect(first.status).toBe(200);
  expect(counter.stats().calls).toBeLessThanOrEqual(40);
  expect(counter.stats().rowsRead).toBeLessThan(100);
  const libraryPage = backupPageSchema(backupSectionSchemas.library);
  const page = libraryPage.parse(await payload(first));
  expect(page.items).toEqual([]);
  expect(page.nextCursor).toBeTruthy();
  const next = libraryPage.parse(
    await payload(
      await request(
        "/backup/library?after=" + encodeURIComponent(page.nextCursor!),
        "W",
      ),
    ),
  );
  expect(next.items.map((item) => item.paper_id)).toEqual(["pap_28", "pap_29"]);
  expect(next.nextCursor).toBeNull();
  counter.reset();
  const records = backupPaperPageSchema.parse(
    await payload(
      await request(
        "/backup/papers?include=" +
          encodeURIComponent(JSON.stringify([{ id: "pap_28" }])),
        "W",
      ),
    ),
  );
  expect(records[0]).toMatchObject({
    paper: { id: "pap_28", title: "Paper 28" },
    identifiers: expect.arrayContaining([
      { paper_id: "pap_28", scheme: "arxiv", value: "2611.00001" },
    ]),
    identifiersAfter: ["arxiv", "2611.00020"],
    linksAfter: ["landing", "https://example.invalid/paper/18"],
    links: expect.arrayContaining([
      expect.objectContaining({
        id: "link_a",
        url: "https://example.invalid/paper",
      }),
    ]),
  });
  expect(counter.stats().calls).toBeLessThanOrEqual(40);
  // Replacing an emitted key changes its rowid. It must stay before the cursor.
  await counter.db
    .prepare(
      "INSERT OR REPLACE INTO paper_ids(paper_id,scheme,value) VALUES ('pap_28','arxiv','2611.00001')",
    )
    .run();
  await counter.db
    .prepare(
      "INSERT OR REPLACE INTO paper_links(id,paper_id,kind,url) VALUES ('link_new','pap_28','landing','https://example.invalid/paper')",
    )
    .run();
  const continuation = backupPaperPageSchema.parse(
    await payload(
      await request("/backup/papers", "W", [
        {
          id: "pap_28",
          identifiersAfter: records[0]!.identifiersAfter,
          linksAfter: records[0]!.linksAfter,
        },
        { id: "pap_00" },
      ]),
    ),
  );
  expect(continuation[0]?.identifiers.map((row) => row.value)).toEqual([
    "2611.00021",
    "2611.00022",
    "2611.00023",
  ]);
  expect(continuation[0]?.paper).toBeNull();
  expect(continuation[0]?.links.map((row) => row.id)).toEqual([
    "link_19",
    "link_20",
    "link_21",
  ]);
  expect(continuation[1]).toMatchObject({
    paper: null,
    identifiers: [],
    links: [],
    identifiersAfter: null,
    linksAfter: null,
  });
  const vault = await request("/backup/vaultRequests", "W");
  expect(vault.status).toBe(200);
  expect(await vault.text()).not.toMatch(/"claim"|Bearer|lsk_/);

  const bundle = backupBundleSchema.parse(
    await collectBackup(async (path, schema, _signal, body) => {
      const response = await request(path, "W", body);
      expect(response.status, path).toBe(200);
      return schema.parse(await payload(response));
    }),
  );
  expect(bundle).toMatchObject({
    instanceName: "Research",
    configuredTopics: [{ name: "Vision", keywords: [] }],
  });
  expect(bundle.expectedCounts).toEqual(bundle.counts);
  expect(bundle.counts).toMatchObject({
    library: 2,
    vaultIndex: 1,
    workingPaperIndex: 1,
    quickNotes: 1,
    digests: 3,
    weeklyDigests: 1,
    paperLinks: 23,
  });
  expect(bundle.data.papers.map(({ id }) => id)).toEqual([
    "pap_28",
    "pap_29",
    "pap_idea",
    "pap_radar",
    "pap_request",
  ]);
  expect(verifyBackup(bundle)).toEqual([]);
  expect(bundle.data.topics[0]?.keywords).toEqual(["stereo"]);
  expect(
    new Set(bundle.data.paperIdentifiers.map(({ value }) => value)).size,
  ).toBe(23);
  for (const section of Object.values(bundle.data))
    expect(section.length).toBeGreaterThan(0);
  expect(JSON.stringify(bundle)).not.toContain(token("S"));

  vi.setSystemTime(new Date(now.getTime() + 1_800_000));
  const changed = await collectBackup(async (path, schema, _signal, body) => {
    const response = await request(path, "W", body);
    expect(response.status, path).toBe(200);
    if (path === "/backup") {
      await counter.db.batch([
        counter.db.prepare(
          "UPDATE library_items SET deleted_at='deleted' WHERE paper_id='pap_29'",
        ),
        counter.db.prepare(
          "INSERT INTO library_items(paper_id,added_via) VALUES ('pap_hidden','test')",
        ),
        counter.db.prepare(
          "INSERT INTO library_items(paper_id,added_via) VALUES ('pap_radar','test')",
        ),
      ]);
    }
    return schema.parse(await payload(response));
  });
  expect(changed.expectedCounts.library).toBe(2);
  expect(changed.counts.library).toBe(3);
  expect(verifyBackup(changed)).toEqual([
    expect.stringMatching(/library.*changed during export/i),
  ]);
});

// 10,000 papers takes minutes on CI runners; run it with LITSCOUT_BENCH=1.
it.each(process.env.LITSCOUT_BENCH === "1" ? [1000, 10000] : [1000])(
  "measures export requests and rows read for %i library papers",
  async (size) => {
    vi.setSystemTime(now);
    const h = await databaseHarness("d1");
    try {
      const meter = countingDb(h.db.$client as unknown as D1Database);
      const db = meter.db;
      await db.batch([
        db
          .prepare(
            `WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?
      ) INSERT INTO papers(id,title,title_norm)
      SELECT printf('pap_%05d',n), 'Paper '||n, 'paper '||n FROM numbers`,
          )
          .bind(size),
        db.prepare(
          "INSERT INTO library_items(paper_id,added_via) SELECT id,'fixture' FROM papers",
        ),
        db.prepare(
          "INSERT INTO paper_ids(paper_id,scheme,value) SELECT id,'url','https://unit.invalid/'||id FROM papers",
        ),
        db.prepare(
          "INSERT INTO paper_links(id,paper_id,kind,url) SELECT 'link_'||id,id,'landing','https://unit.invalid/'||id FROM papers",
        ),
        db
          .prepare(
            "INSERT INTO api_tokens(id,name,hash,scopes,last_used_at) VALUES ('test','test',?,?,?)",
          )
          .bind(
            createHash("sha256").update(token("W")).digest("hex"),
            JSON.stringify(["write"]),
            new Date().toISOString(),
          ),
      ]);
      let requests = 0,
        d1Calls = 0,
        rowsRead = 0,
        countRowsRead = 0;
      const env = { ...workerEnv().env, DB: db };
      const bundle = await collectBackup(
        async (path, schema, _signal, body) => {
          meter.reset();
          const response = await app.request(
            "/api/v1" + path,
            {
              method: body ? "POST" : "GET",
              body: body && JSON.stringify(body),
              headers: { authorization: "Bearer " + token("W") },
            },
            env,
          );
          expect(response.status, path).toBe(200);
          requests++;
          const stats = meter.stats();
          expect(stats.calls, path).toBeLessThanOrEqual(40);
          if (path === "/backup") {
            // Recent bearer token: one auth lookup and one count batch.
            expect(stats.calls).toBe(2);
            countRowsRead = meter.batchRowsRead();
          }
          d1Calls += stats.calls;
          rowsRead += stats.rowsRead;
          return schema.parse(await payload(response));
        },
      );
      expect(backupPaperBatchSize).toBe(19);
      expect(bundle.data.papers).toHaveLength(size);
      expect(bundle.data.paperIdentifiers).toHaveLength(size);
      expect(bundle.data.paperLinks).toHaveLength(size);
      expect(bundle.expectedCounts).toEqual(bundle.counts);
      expect(countRowsRead).toBeGreaterThanOrEqual(size);
      expect(countRowsRead).toBeLessThanOrEqual(16 * size);
      expect(requests).toBe(
        backupSections.length +
          Math.ceil(size / 25) +
          Math.ceil(size / backupPaperBatchSize),
      );
      await writeEvidence(`m3e-backup-${size}.json`, {
        size,
        requests,
        d1Calls,
        rowsRead,
        countRowsRead,
      });
    } finally {
      await h.close();
    }
  },
  120_000,
);
