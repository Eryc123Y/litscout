import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "./harness";
import { readDayCounts } from "../src/bounded-read";
import SQLite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { migrationFiles } from "./harness";
let db: D1Database, close: () => Promise<void>;
const day = "2026-11-16";
beforeAll(async () => {
  const h = await databaseHarness("d1");
  db = h.db.$client as unknown as D1Database;
  close = h.close;
  await db.prepare("INSERT INTO feed_days(day) VALUES (?)").bind(day).run();
  await db
    .prepare(
      "INSERT INTO papers(id,title,title_norm,abstract,first_seen_on,source,venue) VALUES ('pap_count','Title','title',NULL,?,'arxiv','Venue')",
    )
    .bind(day)
    .run();
  await db
    .prepare(
      "INSERT INTO feed_items(day,paper_id,source,topics,shortlisted) VALUES (?,'pap_count','arxiv','[\"Vision\"]',1)",
    )
    .bind(day)
    .run();
});
afterAll(async () => close?.());
it("backfills populated databases when upgrading from schema version 4", () => {
  const old = new SQLite(":memory:");
  try {
    for (const file of migrationFiles.filter((f) => f < "0006"))
      old.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
    old.exec(
      `INSERT INTO feed_days(day) VALUES ('${day}'); INSERT INTO papers(id,title,title_norm,first_seen_on,source) VALUES ('pap_old','Old','old','${day}','arxiv'); INSERT INTO feed_items(day,paper_id,source,topics) VALUES ('${day}','pap_old','arxiv','["Old topic"]');`,
    );
    old.exec(
      readFileSync("packages/db/migrations/0006_feed_read_counts.sql", "utf8"),
    );
    expect(
      old
        .prepare(
          "SELECT n FROM feed_read_counts WHERE day=? AND kind='total' AND key=''",
        )
        .get(day),
    ).toEqual({ n: 1 });
    expect(old.prepare("SELECT version FROM litscout_schema").get()).toEqual({
      version: 5,
    });
  } finally {
    old.close();
  }
});
it("reads stored counts with one primary-key lookup", async () => {
  const queries: string[] = [];
  const tracked = {
    prepare(sql: string) {
      queries.push(sql);
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
  };
  expect(await readDayCounts(tracked, day)).toMatchObject({
    counts: {
      total: 1,
      shortlisted: 1,
      topics: { Vision: 1 },
      sources: { arxiv: 1 },
      venueCounts: { Venue: 1 },
    },
    noAbstract: 1,
  });
  expect(queries).toEqual([
    "SELECT kind,key,n FROM feed_read_counts WHERE day=? AND n>0",
  ]);
});
it("keeps cached counts correct for topic/config edits, summaries, metadata, soft deletion and cascade deletion", async () => {
  await db
    .prepare(
      "UPDATE feed_items SET topics='[\"New topic\"]',shortlisted=0 WHERE paper_id='pap_count'",
    )
    .run();
  expect((await readDayCounts(db, day)).counts).toMatchObject({
    total: 1,
    topics: { "New topic": 1 },
    shortlisted: 0,
  });
  const content = JSON.stringify({
    tldr: "T",
    motivation: "M",
    method: "M",
    result: "R",
    conclusion: "C",
  });
  await db
    .prepare(
      "INSERT INTO summaries(paper_id,lang,kind,content) VALUES ('pap_count','en','five_part',?),('pap_count','zh','five_part',?)",
    )
    .bind(content, content)
    .run();
  expect((await readDayCounts(db, day)).counts.summarised).toBe(1);
  await db.prepare("DELETE FROM summaries WHERE lang='en'").run();
  expect((await readDayCounts(db, day)).counts.summarised).toBe(1);
  await db.prepare("DELETE FROM summaries WHERE lang='zh'").run();
  expect((await readDayCounts(db, day)).counts.summarised).toBe(0);
  await db
    .prepare(
      "UPDATE papers SET abstract='Available',venue='Other' WHERE id='pap_count'",
    )
    .run();
  expect(await readDayCounts(db, day)).toMatchObject({
    counts: { venueCounts: { Other: 1 } },
    noAbstract: 0,
  });
  await db
    .prepare("UPDATE papers SET deleted_at='2026-11-17' WHERE id='pap_count'")
    .run();
  expect((await readDayCounts(db, day)).counts.total).toBe(0);
  await db
    .prepare("UPDATE papers SET deleted_at=NULL WHERE id='pap_count'")
    .run();
  expect((await readDayCounts(db, day)).counts.total).toBe(1);
  await db.prepare("DELETE FROM papers WHERE id='pap_count'").run();
  expect((await readDayCounts(db, day)).counts).toMatchObject({
    total: 0,
    topics: {},
    sources: {},
    venueCounts: {},
  });
});
it("R11 preserves counters through ignored merge conflicts and parent-key cascades", async () => {
  await db
    .prepare(
      "INSERT INTO papers(id,title,title_norm,abstract,source) VALUES ('pap_keep','K','k','A','arxiv'),('pap_drop','D','d','A','arxiv')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO feed_items(day,paper_id,source) VALUES (?,'pap_keep','arxiv'),(?,'pap_drop','arxiv'),(?,'pap_drop','huggingface')",
    )
    .bind(day, day, day)
    .run();
  const content =
    '{"tldr":"T","motivation":"M","method":"M","result":"R","conclusion":"C"}';
  await db
    .prepare(
      "INSERT INTO summaries(paper_id,lang,kind,content) VALUES ('pap_keep','en','five_part',?),('pap_drop','en','five_part',?),('pap_drop','zh','five_part',?)",
    )
    .bind(content, content, content)
    .run();
  await db
    .prepare(
      "UPDATE OR IGNORE feed_items SET paper_id='pap_keep' WHERE paper_id='pap_drop'",
    )
    .run();
  await db.prepare("DELETE FROM feed_items WHERE paper_id='pap_drop'").run();
  await db
    .prepare(
      "UPDATE OR IGNORE summaries SET paper_id='pap_keep' WHERE paper_id='pap_drop'",
    )
    .run();
  await db.prepare("DELETE FROM papers WHERE id='pap_drop'").run();
  expect((await readDayCounts(db, day)).counts).toMatchObject({
    total: 2,
    summarised: 2,
    sources: { arxiv: 1, huggingface: 1 },
  });
  await db
    .prepare("UPDATE papers SET id='pap_renamed' WHERE id='pap_keep'")
    .run();
  expect((await readDayCounts(db, day)).counts).toMatchObject({
    total: 2,
    summarised: 2,
  });
  await db
    .prepare("UPDATE feed_days SET day='2026-11-14' WHERE day=?")
    .bind(day)
    .run();
  expect((await readDayCounts(db, "2026-11-14")).counts).toMatchObject({
    total: 2,
    summarised: 2,
  });
  await db.prepare("DELETE FROM feed_days WHERE day='2026-11-14'").run();
  expect((await readDayCounts(db, "2026-11-14")).counts.total).toBe(0);
});
