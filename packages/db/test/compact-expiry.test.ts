import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { databaseHarness } from "./harness";
import { ingestPapers, preparePaperIngest } from "../src/ingest-papers";
import { readPaper } from "../src/bounded-read";
import { searchPapers } from "../src/papers";
import { expirePage, expiryPage, expiryPreview } from "../src/compact-expiry";
import { prunePage, retentionPage } from "../src/retention";

// Compact rows and their feed occurrences expire 12 months after the paper
// was last listed (ADR 0004, decision 6), oldest first, unless something in
// the kept set points at the paper. Full records are never touched here.
const old = "2025-09-01";
const relisted = "2026-10-20";
const compactBefore = "2026-10-05";
const expireBefore = "2025-11-22";
const ids = ["plain", "second", "relisted", "linked", "picked", "noted"];
const input = ids.map((id, i) => ({
  key: id,
  title: "Expiry specimen " + id,
  abstract: "Full material",
  source: "arxiv",
  topics: ["vision", "graphics"],
  identifiers: [{ scheme: "arxiv", value: "2509." + String(20000 + i) }],
}));
let harness: Awaited<ReturnType<typeof databaseHarness>>;
let db: D1Database;
let paper: Record<string, string>;
const run = (sql: string, ...params: unknown[]) =>
  db
    .prepare(sql)
    .bind(...params)
    .run();
const total = async (day: string) =>
  (
    await db
      .prepare(
        "SELECT n FROM feed_read_counts WHERE day=? AND kind='total' AND key=''",
      )
      .bind(day)
      .first<{ n: number }>()
  )?.n ?? 0;
const compactIds = async () =>
  (
    await db
      .prepare(
        "SELECT paper_id FROM paper_index WHERE has_canonical=0 ORDER BY paper_id",
      )
      .all<{ paper_id: string }>()
  ).results.map((row) => row.paper_id);

beforeAll(async () => {
  harness = await databaseHarness("d1");
  db = harness.db.$client as D1Database;
});
afterAll(async () => harness?.close());
beforeEach(async () => {
  await db.batch(
    [
      "digests",
      "idea_links",
      "ideas",
      "notes",
      "feed_items",
      "paper_index",
      "feed_days",
      "papers",
    ].map((t) => db.prepare("DELETE FROM " + t)),
  );
  const result = await ingestPapers(
    db,
    old,
    input,
    await preparePaperIngest(db, old, input, true),
  );
  paper = Object.fromEntries(
    result.papers.map((row) => [row.key, row.paperId]),
  );
  // Compact every paper (nothing is kept yet), then list one again later
  // and add the references that keep two of them.
  const { rows } = await retentionPage(db, compactBefore, null, 40);
  expect((await prunePage(db, compactBefore, rows)).pruned).toBe(ids.length);
  await ingestPapers(db, relisted, [input[2]!]);
  // Reading, library and mirror rows need a full record, so a compact row
  // is kept only by references without a foreign key.
  await run(
    "INSERT INTO ideas(id,title,body_md,origin) VALUES ('i','Idea','Body','web')",
  );
  await run(
    "INSERT INTO idea_links(idea_id,target_type,target_id,relation) VALUES ('i','paper',?,'cites')",
    paper.linked,
  );
  await run(
    "INSERT INTO digests(day,body_md,picks,radar) VALUES (?,'x',?,'[]')",
    old,
    JSON.stringify([paper.picked]),
  );
  await run(
    "INSERT INTO notes(id,target_type,target_id,body_md,origin) VALUES ('n','paper',?,'note','web')",
    paper.noted,
  );
});

it("lists compact rows last listed before the horizon, oldest first, without the kept set", async () => {
  const { rows } = await expiryPage(db, expireBefore, 40);
  expect(rows.map((row) => row.id).sort()).toEqual(
    [paper.plain!, paper.second!].sort(),
  );
  expect(rows[0]).toMatchObject({ lastDay: old });
  expect(rows.every((row) => row.bound > 0)).toBe(true);
  expect(await expiryPreview(db, expireBefore)).toEqual({
    count: 2,
    oldestDay: old,
    sample: expect.arrayContaining([
      "Expiry specimen plain",
      "Expiry specimen second",
    ]),
  });
  // A full record is never listed, however old.
  expect(
    (await expiryPage(db, relisted, 40)).rows.map((row) => row.id),
  ).not.toContain(paper.relisted);
});

it("removes the compact row, its occurrences, counts and search entry, and nothing else", async () => {
  expect(await total(old)).toBe(ids.length);
  const { rows } = await expiryPage(db, expireBefore, 40);
  const result = await expirePage(db, expireBefore, rows);
  expect(result.expired).toBe(2);
  expect(result.rowsWritten).toBeLessThanOrEqual(
    rows.reduce((sum, row) => sum + row.bound, 0),
  );
  expect(await compactIds()).toEqual(
    [paper.linked!, paper.picked!, paper.noted!].sort(),
  );
  expect(await total(old)).toBe(ids.length - 2);
  expect(await readPaper(db, paper.plain!)).toBeNull();
  const found = (await searchPapers(harness.db, "expiry specimen")).map(
    (p) => p.id,
  );
  expect(found).not.toContain(paper.plain);
  expect(found).toContain(paper.linked);
  // The relisted paper is full again and keeps both occurrences.
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM feed_items WHERE paper_id=?")
      .bind(paper.relisted)
      .first(),
  ).toEqual({ n: 2 });
  expect((await expirePage(db, expireBefore, rows)).expired).toBe(0);
});

it("rechecks inside the deletion: a reference or a listing added after the page keeps the paper", async () => {
  const { rows } = await expiryPage(db, expireBefore, 40);
  await run(
    "INSERT INTO notes(id,target_type,target_id,body_md,origin) VALUES ('late','paper',?,'note','web')",
    paper.plain,
  );
  await run(
    "INSERT INTO feed_days(day,status) VALUES (?, 'done') ON CONFLICT DO NOTHING",
    relisted,
  );
  await run(
    "INSERT INTO feed_items(day,paper_id,source,topics) VALUES (?,?,'arxiv','[]')",
    relisted,
    paper.second,
  );
  expect((await expirePage(db, expireBefore, rows)).expired).toBe(0);
  expect(await compactIds()).toContain(paper.plain);
  expect(await compactIds()).toContain(paper.second);
});

it("leaves a paper whose bound grew since the page", async () => {
  const { rows } = await expiryPage(db, expireBefore, 40);
  const tight = rows.map((row) => ({ ...row, bound: 1 }));
  expect((await expirePage(db, expireBefore, tight)).expired).toBe(0);
  expect(await total(old)).toBe(ids.length);
});

it("finds candidates through the compact-day index, not a scan", async () => {
  const plan = await db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT c.paper_id FROM paper_index c INDEXED BY paper_index_compact_day
      WHERE c.day<? AND c.has_canonical=0`,
    )
    .bind(expireBefore)
    .all<{ detail: string }>();
  expect(plan.results.map((row) => row.detail).join("\n")).toMatch(
    /SEARCH c USING (COVERING )?INDEX paper_index_compact_day/,
  );
});
