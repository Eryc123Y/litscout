import { afterEach, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { migrationStatements } from "@litscout/db/test/harness";
import { ingestPapers } from "@litscout/db/ingest-papers";
import { ingestFeedDay } from "@litscout/db/ingest";
import { planImport, type SchemaRow } from "../src/import-plan";
import { runImport, tableCounts } from "../src/import";
import { applyMigrations } from "../src/migrate";

const open: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((mf) => mf.dispose()));
});
async function d1() {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
    }),
  );
  open.push(mf);
  return (await mf.getD1Database("DB")) as unknown as D1Database;
}
const literal = (v: unknown) =>
  v === null
    ? "NULL"
    : typeof v === "number"
      ? String(v)
      : `'${String(v).replaceAll("'", "''")}'`;
/** An export like `wrangler d1 export --no-schema`: one INSERT per row. */
async function exportData(db: D1Database, tables: string[]) {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  // Reverse order, so the import has to restore the creation order itself.
  for (const table of [...tables].reverse()) {
    // Like wrangler, leave generated columns out.
    const info = await db
      .prepare(`PRAGMA table_xinfo("${table}")`)
      .all<{ name: string; hidden: number }>();
    const cols = info.results.filter((c) => c.hidden === 0).map((c) => c.name);
    const { results } = await db
      .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM "${table}"`)
      .all();
    for (const row of results as Record<string, unknown>[]) {
      lines.push(
        `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map((c) => literal(row[c])).join(",")});`,
      );
    }
  }
  return lines.join("\n");
}
async function schemaOf(db: D1Database) {
  const { results } = await db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY rowid",
    )
    .all<SchemaRow>();
  return results;
}
async function seed(db: D1Database) {
  for (const sql of migrationStatements()) await db.prepare(sql).run();
  const { papers } = await ingestPapers(db as never, "2026-11-20", [
    {
      key: "2611.00001",
      title: "Stereo depth with priors",
      abstract: "Line one.\nLine two; with a semicolon and 'quotes'.",
      authors: ["Ada"],
      source: "arxiv",
      topics: ["Vision"],
      shortlisted: true,
      identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
    },
    {
      key: "2611.00002",
      title: "Language models and memory",
      abstract: null,
      authors: ["Bo"],
      source: "arxiv",
      topics: ["Language"],
      shortlisted: false,
      identifiers: [{ scheme: "arxiv", value: "2611.00002" }],
    },
  ] as never);
  await ingestFeedDay(db as never, {
    day: "2026-11-20",
    status: "final",
    counts: { total: 2 },
  });
  // An archived paper: only a compact row, found through compact_paper_fts.
  await db
    .prepare(
      "INSERT INTO paper_index (paper_id, day, title, topics) VALUES ('pap_archived', '2026-09-01', 'Stereo archive entry', '[]')",
    )
    .run();
  return papers;
}

it("copies every table, rebuilds search and keeps derived counts single", async () => {
  const source = await d1();
  await seed(source);
  const rows = await schemaOf(source);
  const plan = planImport(rows);
  const data = await exportData(source, plan.dataTables);

  const target = await d1();
  const result = await runImport(target, rows, data);
  expect(result.ftsChecked).toBe(3);

  const before = await tableCounts(source, plan.dataTables);
  expect(await tableCounts(target, plan.dataTables)).toEqual(before);
  expect(before.feed_read_counts).toBeGreaterThan(0);
  for (const query of [
    "SELECT count(*) AS n FROM paper_fts WHERE paper_fts MATCH 'stereo'",
    "SELECT count(*) AS n FROM compact_paper_fts WHERE compact_paper_fts MATCH 'stereo'",
    "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'",
    "SELECT count(*) AS n FROM sqlite_master WHERE type='view'",
    "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND sql IS NOT NULL",
    "SELECT abstract AS n FROM papers WHERE title LIKE 'Stereo%'",
  ])
    expect(await target.prepare(query).first("n"), query).toEqual(
      await source.prepare(query).first("n"),
    );
  expect(
    await target
      .prepare(
        "SELECT count(*) AS n FROM paper_fts WHERE paper_fts MATCH 'stereo'",
      )
      .first("n"),
  ).toBe(1);
  expect(
    await target
      .prepare(
        "SELECT count(*) AS n FROM compact_paper_fts WHERE compact_paper_fts MATCH 'stereo'",
      )
      .first("n"),
  ).toBe(1);
});

it("refuses to import into a database that already has tables", async () => {
  const source = await d1();
  await seed(source);
  const rows = await schemaOf(source);
  await expect(runImport(source, rows, "")).rejects.toThrow(/not empty/);
});

it("applies migrations once and records them like wrangler", async () => {
  const db = await d1();
  const first = await applyMigrations(db, "packages/db/migrations");
  expect(first.applied.length).toBeGreaterThan(20);
  expect(first.applied[0]).toBe("0001_schema.sql");
  const again = await applyMigrations(db, "packages/db/migrations");
  expect(again.applied).toEqual([]);
  const names = await db
    .prepare("SELECT name FROM d1_migrations ORDER BY id")
    .all<{ name: string }>();
  expect(names.results.map((r) => r.name)).toEqual(first.applied);
  // A database built from the migrations matches one built by the harness.
  const harness = await d1();
  for (const sql of migrationStatements()) await harness.prepare(sql).run();
  const shape =
    "SELECT type, name FROM sqlite_master WHERE tbl_name NOT IN ('d1_migrations','sqlite_sequence') AND name NOT LIKE '_cf_%' ORDER BY type, name";
  expect((await db.prepare(shape).all()).results).toEqual(
    (await harness.prepare(shape).all()).results,
  );
});

it("ignores the metadata files macOS tar leaves beside migrations", async () => {
  // 11-25: a release packed on a Mac carried "._0001_schema.sql" and its
  // like (AppleDouble files); migrate read them as pending and stopped.
  const dir = mkdtempSync(path.join(tmpdir(), "litscout-migrations-"));
  try {
    cpSync("packages/db/migrations", dir, { recursive: true });
    writeFileSync(
      path.join(dir, "._0001_schema.sql"),
      Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]),
    );
    writeFileSync(path.join(dir, ".DS_Store.sql"), "not SQL");
    const db = await d1();
    const result = await applyMigrations(db, dir);
    expect(result.applied[0]).toBe("0001_schema.sql");
    expect(result.applied.some((name) => name.startsWith("."))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("previews pending migrations without applying them", async () => {
  const db = await d1();
  const preview = await applyMigrations(db, "packages/db/migrations", {
    dryRun: true,
  });
  expect(preview.applied.length).toBeGreaterThan(20);
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='papers'")
      .first("n"),
  ).toBe(0);
});
