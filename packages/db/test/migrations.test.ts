import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  databaseHarness,
  migrationFiles,
  migrationStatements,
} from "./harness";
import SQLite from "better-sqlite3";
import { readFileSync } from "node:fs";
import { backfillVaultTitleKeys } from "../src/vault-title-matches";
import { publishVaultIndex } from "../src/vault-index";
import { paperVaultNote } from "../src/vault-reads";
import costs from "../migrations/costs.json" with { type: "json" };
import { readDayPage, readDayCounts, readPaper } from "../src/bounded-read";
import { listLibrary } from "../src/library";
import { searchTrendPapers } from "../src/trends-source";
import { ingestPapers } from "../src/ingest-papers";
import { ingestSummaryRecords } from "../src/ingest-records";
for (const backend of ["sqlite", "d1"] as const) {
  it(`applies every migration from empty in ${backend}, including FTS triggers`, async () => {
    const { db, close } = await databaseHarness(backend);
    try {
      const tables = await db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='table'`,
      );
      expect(tables.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "papers",
          "paper_index",
          "retention_refs",
          "paper_fts",
          "note_fts",
          "idea_fts",
          "api_tokens",
          "write_leases",
          "feed_read_counts",
          "trend_snapshots",
          "daily_runs",
          "alphaxiv_folder_counts",
        ]),
      );
      expect(
        tables.filter(
          (t) =>
            !t.name.includes("fts") &&
            !t.name.startsWith("sqlite") &&
            !t.name.startsWith("_cf") &&
            t.name !== "litscout_schema",
        ).length,
      ).toBe(41);
      await db.run(
        sql`INSERT INTO ideas(id,title,body_md,origin) VALUES ('idea_test','Stereo','Geometry','cli')`,
      );
      await db.run(
        sql`INSERT INTO notes(id,target_type,target_id,body_md,origin) VALUES ('note_test','paper','pap_test','Binocular','cli')`,
      );
      expect(
        await db.all(
          sql`SELECT rowid FROM idea_fts WHERE idea_fts MATCH 'Geometry'`,
        ),
      ).toHaveLength(1);
      await db.run(sql`UPDATE ideas SET body_md='Camera' WHERE id='idea_test'`);
      expect(
        await db.all(
          sql`SELECT rowid FROM idea_fts WHERE idea_fts MATCH 'Geometry'`,
        ),
      ).toHaveLength(0);
      expect(
        await db.all(
          sql`SELECT rowid FROM note_fts WHERE note_fts MATCH 'Binocular'`,
        ),
      ).toHaveLength(1);
      await db.run(sql`DELETE FROM notes WHERE id='note_test'`);
      await db.run(sql`DELETE FROM ideas WHERE id='idea_test'`);
      expect(
        await db.all(
          sql`SELECT rowid FROM idea_fts WHERE idea_fts MATCH 'Camera'`,
        ),
      ).toHaveLength(0);
    } finally {
      await close();
    }
  });
}

it("bounds the D1 write costs of migrations 0015 through 0019 on a staging-sized fixture", async () => {
  const dailyRuns = "0015_daily_runs.sql";
  const backup = "0016_backup_export.sql";
  const rebuild = "0017_write_cost.sql";
  const budget = "0018_budget_accuracy.sql";
  const expiry = "0019_lease_expiry_day.sql";
  const { db, close } = await databaseHarness(
    "d1",
    migrationFiles.filter((file) => file < dailyRuns),
  );
  try {
    const d1 = db.$client as unknown as D1Database;
    await d1.batch([
      d1.prepare(
        "INSERT INTO papers(id,title,title_norm) VALUES ('p','Paper','paper')",
      ),
      d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3066)
        INSERT INTO paper_ids SELECT 'p','doi','id-'||x FROM n`),
      d1.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<6530)
        INSERT INTO paper_links(id,paper_id,kind,url) SELECT 'link-'||x,'p','landing','url-'||x FROM n`),
    ]);
    const applyAndCount = async (name: string) => {
      const results = await d1.batch(
        migrationStatements([name]).map((statement) => d1.prepare(statement)),
      );
      return results.reduce((sum, result) => sum + result.meta.rows_written, 0);
    };
    expect(await applyAndCount(dailyRuns)).toBeLessThanOrEqual(
      costs[dailyRuns].fixed,
    );
    expect(await applyAndCount(backup)).toBeLessThanOrEqual(
      costs[backup].fixed + 3066 * costs[backup].counts[0]!.writes,
    );
    const actual = await applyAndCount(rebuild);
    const estimated = costs[rebuild].fixed + 3066 * 2 + 6530 * 3;
    expect(actual).toBeGreaterThan(3066 * 2 + 6530 * 3 + 1);
    expect(actual).toBeLessThanOrEqual(estimated);
    expect(await applyAndCount(budget)).toBeLessThanOrEqual(
      costs[budget].fixed,
    );
    expect(await applyAndCount(expiry)).toBeLessThanOrEqual(
      costs[expiry].fixed,
    );
  } finally {
    await close();
  }
});

it("marks existing publisher fallback records when upgrading to verification tracking", () => {
  const db = new SQLite(":memory:");
  try {
    for (const file of migrationFiles.filter((file) => file < "0008"))
      db.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
    db.exec(`INSERT INTO papers (id,title,title_norm,source) VALUES
      ('pap_page','Fallback','fallback','publisher'),
      ('pap_indexed','Indexed','indexed','openalex')`);
    db.exec(
      readFileSync(
        "packages/db/migrations/0008_paper_verification.sql",
        "utf8",
      ),
    );
    expect(
      db.prepare("SELECT id,verified FROM papers ORDER BY id").all(),
    ).toEqual([
      { id: "pap_indexed", verified: 1 },
      { id: "pap_page", verified: 0 },
    ]);
  } finally {
    db.close();
  }
});

it("preserves reserved mirror records and makes room for private rows without a paper", () => {
  const db = new SQLite(":memory:");
  try {
    for (const file of migrationFiles.filter((file) => file < "0009"))
      db.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
    db.exec(`
      INSERT INTO papers(id,title,title_norm) VALUES ('pap_mirror','Original','original');
      INSERT INTO alphaxiv_items (paper_id,alphaxiv_id,folders,synced_at,rev)
      VALUES ('pap_mirror','2611.01234','["Legacy folder"]','2026-11-18T00:00:00.000Z',3);
      INSERT INTO papers(id,title,title_norm) VALUES ('pap_uuid','Has folder ID','has folder id');
      INSERT INTO alphaxiv_items (paper_id,alphaxiv_id,folders,synced_at)
      VALUES ('pap_uuid','2611.01235','["Legacy folder","10000000-0000-4000-8000-00000000000A","10000000-0000-4000-8000-00000000000Z"]','2026-11-18T00:00:00.000Z');
    `);
    const file = migrationFiles.find((name) => name.startsWith("0009"))!;
    db.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
    expect(
      db
        .prepare(
          "SELECT alphaxiv_id,paper_id,paper_type,title,folders,rev FROM alphaxiv_items WHERE paper_id='pap_mirror'",
        )
        .get(),
    ).toEqual({
      alphaxiv_id: "2611.01234",
      paper_id: "pap_mirror",
      paper_type: "public",
      title: "Original",
      rev: 3,
      folders: "[]",
    });
    expect(
      db
        .prepare("SELECT folders FROM alphaxiv_items WHERE paper_id='pap_uuid'")
        .get(),
    ).toEqual({
      folders: JSON.stringify([
        {
          id: "10000000-0000-4000-8000-00000000000a",
          path: "10000000-0000-4000-8000-00000000000A",
          type: "custom",
        },
      ]),
    });
    db.exec(`
      INSERT INTO alphaxiv_items (alphaxiv_id,paper_type,title,synced_at)
      VALUES ('upload_7','private','Private draft','2026-11-18T00:00:00.000Z');
    `);
    expect(
      db
        .prepare(
          "SELECT paper_id FROM alphaxiv_items WHERE paper_type='private'",
        )
        .get(),
    ).toEqual({ paper_id: null });
  } finally {
    db.close();
  }
});

it("upgrades to schema 15 with a covering index and no backup counter writes", () => {
  const db = new SQLite(":memory:");
  try {
    for (const file of migrationFiles.filter((file) => file < "0016"))
      db.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
    db.exec(`
      INSERT INTO papers(id,title,title_norm) VALUES ('pap_backup','Backup','backup');
      INSERT INTO library_items(paper_id,added_via,deleted_at) VALUES ('pap_backup','test','deleted');
    `);
    const migration = migrationFiles.find((file) => file.startsWith("0016"))!;
    db.exec(readFileSync(`packages/db/migrations/${migration}`, "utf8"));
    expect(
      db.prepare("SELECT version FROM litscout_schema").pluck().get(),
    ).toBe(15);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='backup_row_counts' OR sql LIKE '%backup_row_counts%'",
        )
        .all(),
    ).toEqual([]);
    for (const lookup of [
      "SELECT scheme,value FROM paper_ids WHERE paper_id=?",
      "SELECT value FROM paper_ids WHERE paper_id=? AND scheme='doi' ORDER BY value LIMIT 1",
      "SELECT * FROM paper_ids WHERE paper_id=? ORDER BY scheme,value",
      "SELECT 1 FROM paper_ids WHERE paper_id=? AND scheme='arxiv'",
    ]) {
      expect(
        db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all("pap_backup"),
      ).toEqual([
        expect.objectContaining({
          detail: expect.stringContaining(
            "USING COVERING INDEX paper_ids_backup_key",
          ),
        }),
      ]);
    }
  } finally {
    db.close();
  }
});

it("backfills existing compact papers and vault notes on the first sync after migration 0014", async () => {
  const client = new SQLite(":memory:");
  try {
    const migrate = (file: string) =>
      client.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
    for (const file of migrationFiles.filter((file) => file < "0014"))
      migrate(file);
    const snapshot = "a".repeat(64);
    client
      .prepare("UPDATE vault_sync SET snapshot=?,note_count=1")
      .run(snapshot);
    client.exec(`
      INSERT INTO papers(id,title,title_norm) VALUES
        ('canonical','Replacement title','replacementtitle');
      INSERT INTO paper_index(paper_id,day,title) VALUES
        ('canonical','2026-11-18','Méthode ﬁne 立体視'),
        ('compact','2026-11-18','Méthode ﬁne 立体視');
      INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at) VALUES
        ('old','Method.md','paper_note','METHODE — FINE 立体視','{}','old','old','old','2026-11-18');
    `);
    migrate("0014_vault_title_matches.sql");

    const db = drizzle(client);
    expect(await backfillVaultTitleKeys(db)).toMatchObject({
      titleKeysPending: false,
    });
    expect(
      client
        .prepare(
          "SELECT title_norm, has_canonical FROM paper_index ORDER BY paper_id",
        )
        .all(),
    ).toEqual([
      { title_norm: "methode fine 立体視", has_canonical: 1 },
      { title_norm: "methode fine 立体視", has_canonical: 0 },
    ]);
    const refresh = {
      snapshot,
      previous: snapshot,
      parts: 1,
      count: 1,
      changes: 0,
    };
    await publishVaultIndex(db, refresh, "2026-11-18");
    expect(await paperVaultNote(db, "compact")).toMatchObject({
      path: "Method.md",
      matchedBy: "title",
    });
    client.exec("DELETE FROM papers WHERE id='canonical'");
    await publishVaultIndex(db, refresh, "2026-11-18");
    expect(await paperVaultNote(db, "compact")).toEqual({
      path: null,
      pending: false,
    });
  } finally {
    client.close();
  }
});

it("0017 preserves identifier precedence, link metadata and cascading deletes on an upgrade", async () => {
  const prior = migrationFiles.filter((file) => file < "0017");
  const h = await databaseHarness("d1", prior);
  const db = h.db.$client as unknown as D1Database;
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO papers(id,title,title_norm) VALUES ('pap_old','Stereo','stereo')",
      ),
      db.prepare(
        "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_old','arxiv','2611.00123'),('pap_old','doi','10.1234/stereo')",
      ),
      db.prepare(
        "INSERT INTO paper_index(paper_id,day,title,arxiv_id) VALUES ('pap_compact','2026-11-17','Stereo','2611.00123')",
      ),
      db.prepare(`INSERT INTO paper_links(id,paper_id,kind,url,licence,oa_status,source,checked_at,http_status)
        VALUES ('lnk_old','pap_old','pdf_arxiv','https://arxiv.org/pdf/2611.00123','CC BY','green','arxiv','2026-11-17',200)`),
    ]);
    const links = db.prepare("SELECT * FROM paper_links WHERE id='lnk_old'");
    const saved = await links.first();
    await db.batch(
      migrationStatements(["0017_write_cost.sql"]).map((query) =>
        db.prepare(query),
      ),
    );
    expect(await links.first()).toEqual(saved);
    expect(
      await db
        .prepare(
          "SELECT paper_id FROM vault_identifiers WHERE scheme='arxiv' AND value='2611.00123'",
        )
        .all(),
    ).toMatchObject({
      results: [{ paper_id: "pap_old" }],
    });
    expect(
      await db.prepare("SELECT version FROM litscout_schema").first("version"),
    ).toBe(16);
    await db.prepare("DELETE FROM papers WHERE id='pap_old'").run();
    expect(await links.first()).toBe(null);
    expect(
      await db
        .prepare("SELECT 1 FROM paper_ids WHERE paper_id='pap_old'")
        .first(),
    ).toBe(null);
    expect(
      await db
        .prepare(
          "SELECT paper_id FROM vault_identifiers WHERE scheme='arxiv' AND value='2611.00123'",
        )
        .all(),
    ).toMatchObject({
      results: [{ paper_id: "pap_compact" }],
    });
  } finally {
    await h.close();
  }
});

it("flags only existing ingest tokens for legacy vault access", async () => {
  const migration = "0020_vault_token_scope.sql";
  const { db, close } = await databaseHarness(
    "d1",
    migrationFiles.filter((file) => file < migration),
  );
  try {
    const client = db.$client as D1Database;
    const insert = (id: string, scopes: string) =>
      client
        .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
        .bind(id, id, id, scopes)
        .run();
    await insert("old_ingest", '["read","ingest"]');
    await insert("old_read", '["read"]');
    const results = await client.batch(
      migrationStatements([migration]).map((statement) =>
        client.prepare(statement),
      ),
    );
    expect(
      results.reduce((sum, result) => sum + result.meta.rows_written, 0),
    ).toBeLessThanOrEqual(13);
    await insert("new_ingest", '["ingest"]');
    expect(
      await db.all(sql`SELECT id,legacy_vault FROM api_tokens ORDER BY id`),
    ).toEqual([
      { id: "new_ingest", legacy_vault: 0 },
      { id: "old_ingest", legacy_vault: 1 },
      { id: "old_read", legacy_vault: 0 },
    ]);
  } finally {
    await close();
  }
});

it("adds link derivation recipes without rewriting existing papers or links", async () => {
  const file = "0022_derived_arxiv_links.sql";
  const { db, close } = await databaseHarness(
    "d1",
    migrationFiles.filter((entry) => entry < file),
  );
  try {
    const client = db.$client as unknown as D1Database;
    await client.batch([
      client.prepare(
        "INSERT INTO papers(id,title,title_norm) VALUES ('pap_before','Before','before')",
      ),
      client.prepare(
        "INSERT INTO paper_links(id,paper_id,kind,url) VALUES ('lnk_before','pap_before','landing','https://fixture.invalid/before')",
      ),
    ]);
    const writes = await client.batch(
      migrationStatements([file]).map((statement) => client.prepare(statement)),
    );
    expect(
      writes.reduce((sum, result) => sum + result.meta.rows_written, 0),
    ).toBeLessThanOrEqual(costs[file].fixed);
    expect(
      await client.prepare("SELECT id,derived_arxiv_links FROM papers").first(),
    ).toEqual({ id: "pap_before", derived_arxiv_links: "[]" });
    expect(
      await client.prepare("SELECT url FROM paper_links").first("url"),
    ).toBe("https://fixture.invalid/before");
  } finally {
    await close();
  }
});

it("keeps feed occurrences and publishes reverse references when upgrading existing data", async () => {
  const file = "0023_retention.sql";
  const { db, close } = await databaseHarness(
    "d1",
    migrationFiles.filter((entry) => entry < file),
  );
  try {
    const client = db.$client as unknown as D1Database;
    await client.batch([
      client.prepare("INSERT INTO feed_days(day) VALUES ('2026-09-01')"),
      client.prepare(
        "INSERT INTO papers(id,title,title_norm) VALUES ('pap_f','Full','full')",
      ),
      client.prepare(
        "INSERT INTO feed_items(day,paper_id,source,rank_in_source) VALUES ('2026-09-01','pap_f','arxiv',12)",
      ),
      client.prepare(
        `INSERT INTO digests(day,body_md,radar) VALUES ('2026-09-01','Digest','[{"paperId":"pap_f"}]')`,
      ),
      client.prepare(
        "INSERT INTO paper_index(paper_id,day,title) VALUES ('pap_c','2026-08-01','Compact title')",
      ),
    ]);
    const oldCounts = await client
      .prepare("SELECT * FROM feed_read_counts ORDER BY day,kind,key")
      .all();
    const writes = await client.batch(
      migrationStatements([file]).map((sql) => client.prepare(sql)),
    );
    const metered = writes.reduce((sum, r) => sum + r.meta.rows_written, 0);
    expect(metered).toBeLessThanOrEqual(costs[file].fixed + 5 + 1 + 2 + 8);
    expect(
      (
        await client
          .prepare("SELECT * FROM feed_read_counts ORDER BY day,kind,key")
          .all()
      ).results,
    ).toEqual(oldCounts.results);
    expect(
      await client
        .prepare("SELECT paper_id,rank_in_source,rank_sort FROM feed_items")
        .first(),
    ).toEqual({ paper_id: "pap_f", rank_in_source: 12, rank_sort: 12 });
    expect(
      await client
        .prepare("SELECT source FROM retention_refs WHERE paper_id='pap_f'")
        .first(),
    ).toEqual({ source: "digests" });
    expect(
      await client
        .prepare(
          "SELECT rowid FROM compact_paper_fts WHERE compact_paper_fts MATCH 'Compact'",
        )
        .first(),
    ).toBeTruthy();
  } finally {
    await close();
  }
});

it("upgrades a 0014 staging-shaped database through the latest migration within the manifest allowances", async () => {
  // Through the latest: the reads below are today's code, which needs
  // today's columns.
  const files = migrationFiles.filter((name) => name >= "0015");
  const h = await databaseHarness(
    "d1",
    migrationFiles.filter((name) => name < "0015"),
  );
  const client = h.db.$client as D1Database;
  const day = "2026-10-01";
  const later = "2026-10-02";
  const third = "2026-10-03";
  const id = (i: number) => "pap_stage_" + String(i).padStart(4, "0");
  const group = "vision";
  const seed =
    "WITH RECURSIVE seq(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<2399)";
  const statement = (query: string, ...params: unknown[]) =>
    client.prepare(query).bind(...params);
  const getRows = async (query: string, ...params: unknown[]) =>
    (await statement(query, ...params).all()).results;
  try {
    await client.batch([
      statement(
        "INSERT INTO feed_days(day,status) VALUES (?,'final'),(?,'crawled')",
        day,
        later,
      ),
      statement(
        `${seed} INSERT INTO papers(id,title,title_norm,vault_title_norm,venue,abstract,first_seen_on)
        SELECT printf('pap_stage_%04d',i),'Staging vision '||i,'vision'||i,'staging vision '||i,
          'Archive fixture',CASE WHEN i%4=0 THEN NULL ELSE 'Abstract' END,?1 FROM seq`,
        day,
      ),
      statement(`${seed} INSERT INTO paper_ids(paper_id,scheme,value)
        SELECT printf('pap_stage_%04d',i),'arxiv',printf('2610.%05d',i) FROM seq`),
      statement(`${seed} INSERT INTO paper_links(id,paper_id,kind,url)
        SELECT 'stage-link-'||i,printf('pap_stage_%04d',i),'landing','https://arxiv.org/abs/'||printf('2610.%05d',i) FROM seq`),
      statement(
        `${seed} INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted)
        SELECT ?1,printf('pap_stage_%04d',i),'arxiv',i,'["vision"]',i%7=0 FROM seq
        UNION ALL SELECT ?2,printf('pap_stage_%04d',i),'arxiv',i,'["vision"]',0 FROM seq WHERE i%5=0`,
        day,
        later,
      ),
      statement(`INSERT INTO summaries(paper_id,lang,content)
        SELECT id,'en','{"tldr":"Staging summary"}' FROM papers WHERE id LIKE '%0'`),
      statement(
        `INSERT INTO digests(day,body_md,picks,radar) VALUES (?, 'Digest', json_array(?),json_array(json_object('paperId',?)))`,
        day,
        id(0),
        id(2),
      ),
      statement(
        `INSERT INTO library_items(paper_id,added_via,added_at) VALUES (?,'manual','2026-10-01T00:00:00Z')`,
        id(0),
      ),
      statement(
        `INSERT INTO alphaxiv_items(alphaxiv_id,paper_id,title,folders,synced_at)
        VALUES ('stage-mirror',?,'Staging vision 1','[{"id":"fixture-folder","path":"Fixture folder"}]','2026-10-02T00:00:00Z')`,
        id(1),
      ),
      statement(`INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at)
        VALUES ('stage-vault','Stage.md','paper_note','Legacy vault note','{"arxiv":"2610.00001"}','h','h','h','now')`),
      statement(
        `INSERT INTO events(id,paper_id,kind,day,source) VALUES ('stage-rating',?,'rate_up',?,'cli')`,
        id(0),
        day,
      ),
      statement(`INSERT INTO paper_index(paper_id,arxiv_id,day,title,title_norm)
        VALUES ('pap_stage_compact','2608.11111','2026-08-01','Legacy vision','legacy vision')`),
    ]);
    const tableCounts = () =>
      getRows(`SELECT
      (SELECT count(*) FROM papers) papers,(SELECT count(*) FROM paper_ids) ids,
      (SELECT count(*) FROM paper_links) links,(SELECT count(*) FROM feed_items) feed,
      (SELECT count(*) FROM summaries) summaries,(SELECT count(*) FROM digests) digests,
      (SELECT count(*) FROM library_items) library,(SELECT count(*) FROM alphaxiv_items) mirror,
      (SELECT count(*) FROM vault_notes) vault,(SELECT count(*) FROM paper_index) index_count`);
    const counters = () =>
      getRows("SELECT * FROM feed_read_counts ORDER BY day,kind,key");
    const [
      countsBefore,
      countersBefore,
      feedBefore,
      trendsBefore,
      libraryBefore,
    ] = await Promise.all([
      tableCounts(),
      counters(),
      getRows(
        "SELECT f.paper_id AS paperId,p.title FROM feed_items f JOIN papers p ON p.id=f.paper_id WHERE f.day=? ORDER BY f.rank_sort,f.paper_id,f.source LIMIT 30",
        day,
      ),
      getRows(
        "SELECT f.paper_id AS paperId,p.title FROM feed_items f JOIN papers p ON p.id=f.paper_id WHERE f.day=? ORDER BY f.paper_id,f.source LIMIT 48",
        day,
      ),
      getRows(`SELECT paper_id AS paperId,title FROM (
        SELECT l.paper_id,p.title,l.added_at FROM library_items l JOIN papers p ON p.id=l.paper_id
        UNION ALL SELECT paper_id,title,synced_at FROM alphaxiv_items
      ) ORDER BY added_at DESC,paper_id DESC`),
    ]);
    const manifest: Record<
      string,
      {
        fixed: number;
        counts?: {
          table: string;
          writes: number;
          where?: string;
          count?: string;
        }[];
      }
    > = costs;
    for (const file of files) {
      const item = manifest[file]!;
      let estimate = item.fixed;
      for (const {
        table,
        writes,
        count = "count(*)",
        where = "1",
      } of item.counts ?? []) {
        estimate +=
          writes *
          (await statement(
            `SELECT ${count} AS n FROM ${table} WHERE ${where}`,
          ).first<number>("n"))!;
      }
      const results = await client.batch(
        migrationStatements([file]).map((migration) => statement(migration)),
      );
      const observed = results.reduce(
        (sum, result) => sum + result.meta.rows_written,
        0,
      );
      expect(observed, file).toBeLessThanOrEqual(estimate);
    }
    expect(await tableCounts()).toEqual(countsBefore);
    expect(await counters()).toEqual(countersBefore);
    expect(await getRows("PRAGMA foreign_key_check")).toEqual([]);
    const feed = await readDayPage(client, day, { limit: 30 });
    expect(
      feed.items.map(({ paperId, title }) => ({ paperId, title })),
    ).toEqual(feedBefore);
    const trends = await searchTrendPapers(client, {
      month: "2026-10",
      topic: group,
      term: "vision",
    });
    expect(trends.items).toEqual(trendsBefore);
    const library = await listLibrary(h.db, {});
    expect(
      library.items.map((item) => ({
        paperId: "paperId" in item ? item.paperId : null,
        title: item.title,
      })),
    ).toEqual(libraryBefore);
    expect(library.alphaXiv?.folders).toEqual([
      { id: "fixture-folder", path: "Fixture folder" },
    ]);
    expect(
      await getRows(
        "SELECT paper_id FROM retention_refs WHERE source='digests' ORDER BY paper_id",
      ),
    ).toEqual([{ paper_id: id(0) }, { paper_id: id(2) }]);
    expect(await paperVaultNote(h.db, id(1))).toMatchObject({
      path: "Stage.md",
    });
    expect(await readPaper(client, "pap_stage_compact")).toMatchObject({
      compact: true,
    });

    const run = {
      key: "existing",
      title: "Staging vision update",
      source: "arxiv",
      venue: "New venue",
      topics: [group],
      identifiers: [{ scheme: "arxiv", value: "2610.00002" }],
    };
    const joined = {
      ...run,
      key: "merged",
      identifiers: [
        ...run.identifiers,
        { scheme: "arxiv", value: "2610.00003" },
      ],
    };
    await ingestPapers(client, third, [run]);
    await ingestSummaryRecords(client, {
      day: third,
      summaries: [
        {
          paperId: id(2),
          lang: "en",
          content: {
            tldr: "An updated summary",
            motivation: "Fixture motivation",
            method: "Fixture method",
            result: "Fixture result",
            conclusion: "Fixture conclusion",
          },
          client: "cli",
          model: "fixture",
        },
      ],
    });
    expect((await readDayCounts(client, third)).counts).toMatchObject({
      total: 1,
      summarised: 1,
    });
    const merge = await ingestPapers(client, third, [joined]);
    const survivor = merge.papers[0]!.paperId;
    expect(
      await getRows(
        "SELECT paper_id FROM retention_refs WHERE source='digests' ORDER BY paper_id",
      ),
    ).toEqual([{ paper_id: id(0) }, { paper_id: survivor }]);
    await statement("DELETE FROM papers WHERE id=?", survivor).run();
    expect((await readDayCounts(client, third)).counts).toMatchObject({
      total: 0,
      summarised: 0,
    });
    expect(
      await getRows(
        "SELECT paper_id FROM feed_items WHERE paper_id=?",
        survivor,
      ),
    ).toEqual([]);
    expect(await getRows("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await h.close();
  }
}, 30_000);
