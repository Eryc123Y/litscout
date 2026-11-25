import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { migrationStatements } from "@litscout/db/test/harness";
import { splitSql } from "../src/sql";

it("splits statements on semicolons outside quotes and trigger bodies", () => {
  const sql = [
    "PRAGMA defer_foreign_keys=TRUE;",
    `INSERT INTO "t" ("a","b") VALUES('x; y','it''s');`,
    `INSERT INTO "t" ("a") VALUES(replace('one\\ntwo','\\n',char(10)));`,
    `CREATE TRIGGER tr AFTER INSERT ON t BEGIN`,
    `  INSERT INTO u(v) VALUES (new.a);`,
    `  UPDATE w SET n = n + 1;`,
    `END;`,
    `CREATE TABLE "q;x" (c TEXT DEFAULT ';');`,
    "",
  ].join("\n");
  expect(splitSql(sql)).toEqual([
    "PRAGMA defer_foreign_keys=TRUE;",
    `INSERT INTO "t" ("a","b") VALUES('x; y','it''s');`,
    `INSERT INTO "t" ("a") VALUES(replace('one\\ntwo','\\n',char(10)));`,
    `CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  INSERT INTO u(v) VALUES (new.a);\n  UPDATE w SET n = n + 1;\nEND;`,
    `CREATE TABLE "q;x" (c TEXT DEFAULT ';');`,
  ]);
});

it("splits every repository migration exactly as the test harness does", () => {
  const files = readdirSync("packages/db/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files)
    expect(
      splitSql(readFileSync(`packages/db/migrations/${file}`, "utf8")),
      file,
    ).toEqual(migrationStatements([file]));
});

it("ignores comment-only and blank input", () => {
  expect(splitSql("-- nothing here\n\n  ")).toEqual([]);
  expect(splitSql("SELECT 1; -- trailing\n")).toEqual(["SELECT 1;"]);
});
