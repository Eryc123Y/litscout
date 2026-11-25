import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { collectBackup, verifyBackup } from "@litscout/pipeline/backup";
import {
  backupBundleSchema,
  backupDataSections,
  type BackupBundle,
} from "@litscout/pipeline/backup-contracts";
import {
  restoreOrder,
  restorePageCost,
  restorePath,
  restoreResultSchema,
  restoreStatusSchema,
  type RestorePage,
} from "@litscout/pipeline/backup-restore-contracts";
import {
  restoreBackup,
  restorePages,
  RestoreBudgetStop,
} from "@litscout/pipeline/backup-restore";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

const fixtureEnv = workerEnv().env;
const now = new Date("2026-11-20T07:00:00.000Z");
const token = (letter: string) => "lsk_" + letter.repeat(52);
type Db = D1Database;
const harnesses: { close: () => Promise<void> }[] = [];

async function instance() {
  const harness = await databaseHarness("d1");
  harnesses.push(harness);
  const db = harness.db.$client as unknown as Db;
  await db.batch(
    [
      ["I", "ingest"],
      ["W", "write"],
    ].map(([letter, scope]) =>
      db
        .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
        .bind(
          letter,
          scope,
          createHash("sha256").update(token(letter!)).digest("hex"),
          JSON.stringify([scope]),
        ),
    ),
  );
  return db;
}

const request = (db: Db, path: string, auth: string, body?: unknown) =>
  app.request(
    "/api/v1" + path,
    {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token(auth),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    {
      ...fixtureEnv,
      DB: db,
      LOCAL_DEV: "true",
      BACKUP_COOLDOWN: "off",
      PUBLIC_FEED: "true",
      INSTANCE_CONFIG: JSON.stringify({
        name: "Research",
        timezone: "Asia/Kuala_Lumpur",
        language: "en",
        topics: ["Vision"],
      }),
    },
  );
const payload = async (response: Response) =>
  ((await response.json()) as { data: unknown }).data;

const exportFrom = async (db: Db) =>
  backupBundleSchema.parse(
    await collectBackup(
      async (path, schema, _signal, body) => {
        const response = await request(db, path, "W", body);
        expect(response.status, path).toBe(200);
        return schema.parse(await payload(response));
      },
      { createdAt: now },
    ),
  );

const writerFor = (db: Db) => async (page: RestorePage) => {
  const response = await request(db, restorePath, "W", page);
  const body = (await response.json()) as {
    data?: unknown;
    meta?: { rowsWritten?: number };
    error?: { code?: string };
  };
  if (response.status === 429 && body.error?.code === "WRITE_BUDGET_EXCEEDED")
    throw new RestoreBudgetStop();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return {
    ...restoreResultSchema.parse(body.data),
    rowsWritten: body.meta?.rowsWritten ?? 0,
  };
};

const status = async (db: Db) =>
  restoreStatusSchema.parse(await payload(await request(db, restorePath, "W")));

async function seed(db: Db) {
  await db.batch([
    db.prepare(`INSERT INTO papers(id,title,title_norm,abstract,authors,categories,derived_arxiv_links,venue,year)
      VALUES ('pap_a','Stereo Video','stereo video','An abstract','["Ada Lovelace"]','["cs.CV"]',
        '[{"kind":"landing","id":"2611.00001"}]','CVPR',2026)`),
    db.prepare(
      "INSERT INTO papers(id,title,title_norm) VALUES ('pap_b','Radar Pick','radar pick')",
    ),
    db.prepare(`INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title,title_norm,topics,venue)
      VALUES ('cmp_c','2601.00002',NULL,'2026-01-05','Compact Paper','compact paper','["Vision"]',NULL)`),
    db.prepare(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_a','arxiv','2611.00001'),('pap_a','doi','10.1000/example')",
    ),
    db.prepare(
      "INSERT INTO paper_links(id,paper_id,kind,url) VALUES ('link_a','pap_a','landing','https://example.invalid/a'),('link_b','pap_a','pdf','https://example.invalid/a.pdf')",
    ),
    db.prepare(
      `INSERT INTO library_items(paper_id,added_via,tags) VALUES ('pap_a','web','["thesis"]')`,
    ),
    db.prepare(
      "INSERT INTO paper_state(paper_id,rating,starred) VALUES ('pap_a','up',1)",
    ),
    db.prepare(
      "INSERT INTO notes(id,target_id,target_type,origin,body_md) VALUES ('q_a','pap_a','paper','web','Quick note')",
    ),
    db.prepare(
      `INSERT INTO digests(day,kind,body_md,picks,radar) VALUES ('2026-11-11','daily','Daily digest','["pap_a","cmp_c"]','[{"paperId":"pap_b"}]')`,
    ),
    db.prepare(
      `INSERT INTO digests(day,kind,body_md,picks) VALUES ('2026-11-09','weekly','Weekly digest','["pap_a"]')`,
    ),
    db.prepare(
      `INSERT INTO topics(id,name,keywords) VALUES ('t_a','Vision','["stereo"]')`,
    ),
    db.prepare(
      "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES ('v_a','Idea.md','idea','Idea','{\"status\":\"open\"}','hash','body','fp','2026-11-19T00:00:00.000Z')",
    ),
    db.prepare(
      `INSERT INTO projects(id,slug,title,status,vault_note_id,keywords) VALUES ('p_a','research','Research','active','v_a','["depth"]')`,
    ),
    db.prepare(
      `INSERT INTO idea_index(id,vault_note_id,title,project_id,paper_ids,updated_at) VALUES ('i_a','v_a','Idea','p_a','["pap_b"]','2026-11-19T00:00:00.000Z')`,
    ),
    db.prepare(
      `INSERT INTO working_paper_index(id,vault_note_id,title,idea_ids,paper_ids,updated_at) VALUES ('w_a','v_a','Draft','["i_a"]','["pap_a"]','2026-11-19T00:00:00.000Z')`,
    ),
    db.prepare(
      `INSERT INTO vault_requests(id,kind,target_note_id,payload,origin,created_at) VALUES ('req_a','capture','v_a','{"paperId":"pap_b"}','web','2026-11-19T00:00:00.000Z')`,
    ),
    db.prepare(
      "INSERT INTO captures(id,title,source_paper_id,created_at) VALUES ('req_a','Capture','pap_a','2026-11-19T00:00:00.000Z')",
    ),
    db.prepare(
      `INSERT INTO suggestions(id,day,kind,title,body_md,created_by,request_id,paper_ids) VALUES ('sg_a','2026-11-19','new_idea','Suggestion','Draft idea','agent','req_a','["pap_b"]')`,
    ),
    db.prepare(
      `INSERT INTO alphaxiv_items(alphaxiv_id,paper_type,paper_id,title,folders,synced_at) VALUES ('ax_1','public','pap_a','Stereo Video','[{"id":"f1","path":"Reading"}]','2026-11-19T00:00:00.000Z')`,
    ),
    db.prepare(
      "INSERT INTO alphaxiv_items(alphaxiv_id,paper_type,title,synced_at) VALUES ('draft_1','private','Mirror item','2026-11-19T00:00:00.000Z')",
    ),
    // The costliest rows each section can hold: long indexed text and every
    // partial index a paper note can enter.
    db
      .prepare(
        "INSERT INTO papers(id,title,title_norm,tldr) VALUES ('pap_long',?,'long',?)",
      )
      .bind(words("title", 150), words("summary", 300)),
    db
      .prepare(
        "INSERT INTO notes(id,target_id,target_type,origin,body_md) VALUES ('q_long','pap_long','paper','web',?)",
      )
      .bind(words("note", 500).slice(0, 4000)),
    db.prepare(
      `INSERT INTO library_items(paper_id,added_via) VALUES ('pap_long','web')`,
    ),
    db.prepare(
      "INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES ('v_note','Note.md','paper_note','Paper note','{}','hash','body','fp','2026-11-19T00:00:00.000Z')",
    ),
  ]);
}
const words = (stem: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${stem}${i}`).join(" ");

let bundle: BackupBundle;
beforeAll(async () => {
  const source = await instance();
  await seed(source);
  bundle = await exportFrom(source);
}, 90_000);
afterAll(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()));
});

it("restores every exported section in an order the foreign keys accept", () => {
  expect([...restoreOrder].sort()).toEqual([...backupDataSections].sort());
  expect(verifyBackup(bundle)).toEqual([]);
  for (const section of backupDataSections)
    expect(bundle.counts[section], section).toBeGreaterThan(0);
});

it("round-trips an export into an empty instance, then writes nothing on a second run", async () => {
  const target = await instance();
  expect(await status(target)).toMatchObject({ personalRows: 0 });
  const result = await restoreBackup(writerFor(target), bundle);
  const rows = backupDataSections.reduce(
    (sum, section) => sum + bundle.counts[section],
    0,
  );
  expect(result).toMatchObject({ status: "done", inserted: rows, skipped: 0 });
  expect(result.rowsWritten).toBeGreaterThan(rows);
  const again = await exportFrom(target);
  // Bodies are not exported: restored projects, ideas and drafts get an
  // empty fingerprint so the next vault sync uploads them again.
  const resynced = new Set(["project", "idea", "working_paper"]);
  expect(again.data).toEqual({
    ...bundle.data,
    vaultIndex: bundle.data.vaultIndex.map((row) =>
      resynced.has(row.kind) ? { ...row, fingerprint: "" } : row,
    ),
  });
  expect(bundle.data.vaultIndex.some((row) => resynced.has(row.kind))).toBe(
    true,
  );
  expect((await status(target)).personalRows).toBeGreaterThan(0);

  const used = await target
    .prepare("SELECT rows_written FROM daily_write_usage")
    .first<number>("rows_written");
  expect(used).toBeGreaterThanOrEqual(result.rowsWritten);

  const twice = await restoreBackup(writerFor(target), bundle);
  expect(twice).toMatchObject({ status: "done", inserted: 0, skipped: rows });
}, 90_000);

it("reserves at least what each row writes on its own", async () => {
  const target = await instance();
  for (const page of restorePages(bundle))
    for (const item of page.items) {
      const single = { section: page.section, items: [item] } as RestorePage;
      const response = await request(target, restorePath, "W", single);
      expect(response.status, page.section).toBe(200);
      const written = (
        (await response.json()) as { meta: { rowsWritten: number } }
      ).meta.rowsWritten;
      expect(written, page.section).toBeLessThanOrEqual(
        restorePageCost(single),
      );
    }
}, 90_000);

it("reserves enough for a full page of long, distinct text", async () => {
  const target = await instance();
  const at = "2026-11-19T00:00:00.000Z";
  const text = (stem: string, n: number, page: number) =>
    Array.from({ length: n }, (_, i) => `${stem}${page}w${i}`).join(" ");
  const papers = Array.from({ length: 25 }, (_, i) => ({
    ...bundle.data.papers.find((paper) => paper.id === "pap_b"),
    id: `pap_page_${i}`,
    title: text("title", 120, i),
    tldr: text("summary", 250, i),
  }));
  const notes = papers.map((paper, i) => ({
    ...bundle.data.quickNotes[0]!,
    id: `q_page_${i}`,
    target_id: paper.id,
    body_md: text("note", 600, i).slice(0, 4000),
    created_at: at,
  }));
  for (const page of [
    { section: "papers", items: papers },
    { section: "quickNotes", items: notes },
  ] as RestorePage[]) {
    const response = await request(target, restorePath, "W", page);
    expect(response.status, page.section).toBe(200);
    const body = (await response.json()) as {
      data: { inserted: number };
      meta: { rowsWritten: number };
    };
    expect(body.data.inserted).toBe(25);
    expect(body.meta.rowsWritten, page.section).toBeLessThanOrEqual(
      restorePageCost(page),
    );
  }
}, 90_000);

it("skips rows whose paper or note is missing instead of failing the page", async () => {
  const target = await instance();
  const response = await request(target, restorePath, "W", {
    section: "library",
    items: bundle.data.library,
  });
  expect(response.status).toBe(200);
  expect(await payload(response)).toEqual({
    inserted: 0,
    skipped: bundle.data.library.length,
  });
  const ideas = await request(target, restorePath, "W", {
    section: "ideaIndex",
    items: bundle.data.ideaIndex,
  });
  expect(await payload(ideas)).toEqual({ inserted: 0, skipped: 1 });
}, 90_000);

it("needs the write scope and a valid page", async () => {
  const target = await instance();
  const page = { section: "topics", items: bundle.data.topics };
  expect((await request(target, restorePath, "I", page)).status).toBe(403);
  expect((await request(target, restorePath, "I")).status).toBe(403);
  const invalid = await request(target, restorePath, "W", {
    section: "topics",
    items: [{ ...bundle.data.topics[0], extra: true }],
  });
  expect(invalid.status).toBe(400);
  const empty = await request(target, restorePath, "W", {
    section: "topics",
    items: [],
  });
  expect(empty.status).toBe(400);
}, 90_000);

it("stops on the daily write budget without writing the page", async () => {
  const target = await instance();
  await target
    .prepare(
      "INSERT INTO daily_write_usage(day,rows_written) VALUES (date('now'),80000)",
    )
    .run();
  const result = await restoreBackup(writerFor(target), bundle);
  expect(result).toMatchObject({ status: "budget", next: 0, inserted: 0 });
  expect(
    await target.prepare("SELECT count(*) AS n FROM topics").first("n"),
  ).toBe(0);
}, 90_000);
