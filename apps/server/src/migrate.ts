import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { splitSql } from "./sql";

/** The table wrangler keeps applied D1 migrations in, created the same way. */
const migrationsTable = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/**
 * Apply the migration files in `dir` that `d1_migrations` does not list, in
 * name order, and record each one. With `dryRun`, only report them.
 */
export async function applyMigrations(
  db: D1Database,
  dir: string,
  { dryRun = false }: { dryRun?: boolean } = {},
) {
  const files = readdirSync(dir)
    // Not hidden files: a release packed on a Mac can carry "._NAME.sql"
    // metadata files beside the real ones.
    .filter((file) => file.endsWith(".sql") && !file.startsWith("."))
    .sort();
  const hasTable = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
    )
    .first<number>("n");
  const done = new Set(
    hasTable
      ? (
          await db
            .prepare("SELECT name FROM d1_migrations")
            .all<{ name: string }>()
        ).results.map((row) => row.name)
      : [],
  );
  const pending = files.filter((file) => !done.has(file));
  if (dryRun) return { applied: pending };
  await db.prepare(migrationsTable).run();
  for (const file of pending) {
    for (const sql of splitSql(readFileSync(path.join(dir, file), "utf8")))
      await db.prepare(sql).run();
    await db
      .prepare("INSERT INTO d1_migrations (name) VALUES (?)")
      .bind(file)
      .run();
  }
  return { applied: pending };
}
