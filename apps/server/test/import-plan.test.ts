import { expect, it } from "vitest";
import { planImport, type SchemaRow } from "../src/import-plan";

const rows: SchemaRow[] = [
  {
    type: "table",
    name: "sqlite_sequence",
    sql: "CREATE TABLE sqlite_sequence(name,seq)",
  },
  {
    type: "table",
    name: "_cf_KV",
    sql: "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)",
  },
  {
    type: "table",
    name: "d1_migrations",
    sql: "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)",
  },
  {
    type: "table",
    name: "papers",
    sql: "CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT)",
  },
  {
    type: "table",
    name: "feed_read_counts",
    sql: "CREATE TABLE feed_read_counts (day TEXT, n INTEGER)",
  },
  {
    type: "table",
    name: "paper_fts",
    sql: "CREATE VIRTUAL TABLE paper_fts USING fts5(title, content='papers', content_rowid='rowid')",
  },
  {
    type: "table",
    name: "paper_fts_data",
    sql: "CREATE TABLE 'paper_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
  },
  {
    type: "table",
    name: "paper_fts_idx",
    sql: "CREATE TABLE 'paper_fts_idx'(segid, term, pgno)",
  },
  {
    type: "table",
    name: "paper_fts_config",
    sql: "CREATE TABLE 'paper_fts_config'(k PRIMARY KEY, v)",
  },
  { type: "index", name: "sqlite_autoindex_papers_1", sql: null },
  {
    type: "index",
    name: "papers_title",
    sql: "CREATE INDEX papers_title ON papers(title)",
  },
  {
    type: "trigger",
    name: "paper_fts_insert",
    sql: "CREATE TRIGGER paper_fts_insert AFTER INSERT ON papers BEGIN INSERT INTO paper_fts(rowid, title) VALUES (new.rowid, new.title); END",
  },
  {
    type: "trigger",
    name: "count_insert",
    sql: "CREATE TRIGGER count_insert AFTER INSERT ON papers BEGIN UPDATE feed_read_counts SET n = n + 1; END",
  },
];

it("creates tables, then FTS triggers, imports data, then indexes and the other triggers", () => {
  const plan = planImport(rows);
  expect(plan.dataTables).toEqual([
    "d1_migrations",
    "papers",
    "feed_read_counts",
  ]);
  expect(plan.before.map((s) => s.slice(0, 40))).toEqual([
    "CREATE TABLE d1_migrations(id INTEGER PR",
    "CREATE TABLE papers (id TEXT PRIMARY KEY",
    "CREATE TABLE feed_read_counts (day TEXT,",
    "CREATE VIRTUAL TABLE paper_fts USING fts",
    "CREATE TRIGGER paper_fts_insert AFTER IN",
  ]);
  expect(plan.after).toEqual([
    "CREATE INDEX papers_title ON papers(title);",
    "CREATE TRIGGER count_insert AFTER INSERT ON papers BEGIN UPDATE feed_read_counts SET n = n + 1; END;",
  ]);
  // External-content FTS tables can be checked after the import.
  expect(plan.ftsChecks).toEqual([
    "INSERT INTO paper_fts(paper_fts) VALUES('integrity-check');",
  ]);
});

it("refuses a trigger that writes both an FTS table and another table", () => {
  expect(() =>
    planImport([
      ...rows.slice(0, 6),
      {
        type: "trigger",
        name: "mixed",
        sql: "CREATE TRIGGER mixed AFTER INSERT ON papers BEGIN INSERT INTO paper_fts(rowid, title) VALUES (new.rowid, new.title); UPDATE feed_read_counts SET n = n + 1; END",
      },
    ]),
  ).toThrow(/mixed/);
});

it("copies a parent table before a table that references it, even if the parent was created later", () => {
  const plan = planImport([
    {
      type: "table",
      name: "papers",
      sql: "CREATE TABLE papers (id TEXT PRIMARY KEY)",
    },
    {
      type: "table",
      name: "projects",
      sql: 'CREATE TABLE projects (id TEXT, note TEXT REFERENCES "vault_notes"(path), doc TEXT REFERENCES profile_docs(id))',
    },
    {
      type: "table",
      name: "profile_docs",
      sql: "CREATE TABLE profile_docs (id TEXT PRIMARY KEY)",
    },
    {
      type: "table",
      name: "paper_index",
      sql: "CREATE TABLE paper_index (paper_id TEXT PRIMARY KEY)",
    },
    {
      type: "table",
      name: "vault_notes",
      sql: "CREATE TABLE vault_notes (path TEXT PRIMARY KEY, up TEXT REFERENCES vault_notes(path))",
    },
  ]);
  // Creation order is kept wherever references allow it.
  expect(plan.dataTables).toEqual([
    "papers",
    "profile_docs",
    "vault_notes",
    "projects",
    "paper_index",
  ]);
  // Tables are still created in their original order.
  expect(plan.before.map((s) => /TABLE (\w+)/.exec(s)?.[1])).toEqual([
    "papers",
    "projects",
    "profile_docs",
    "paper_index",
    "vault_notes",
  ]);
});

it("recreates views after the tables they read and before the rows", () => {
  const plan = planImport([
    { type: "table", name: "parts", sql: "CREATE TABLE parts (id TEXT)" },
    {
      type: "view",
      name: "staged",
      sql: "CREATE VIEW staged AS SELECT id FROM parts",
    },
    {
      type: "index",
      name: "parts_id",
      sql: "CREATE INDEX parts_id ON parts(id)",
    },
  ]);
  expect(plan.before).toEqual([
    "CREATE TABLE parts (id TEXT);",
    "CREATE VIEW staged AS SELECT id FROM parts;",
  ]);
  expect(plan.dataTables).toEqual(["parts"]);
  expect(plan.after).toEqual(["CREATE INDEX parts_id ON parts(id);"]);
});
