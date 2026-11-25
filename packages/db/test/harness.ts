import SQLite from "better-sqlite3";
import { drizzle as sqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as d1 } from "drizzle-orm/d1";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import type { Database } from "../src/database";
export const migrationFiles = readdirSync("packages/db/migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort();
export function migrationStatements(files = migrationFiles): string[] {
  return files.flatMap((file) =>
    readFileSync(`packages/db/migrations/${file}`, "utf8")
      .match(/\s*(?:CREATE TRIGGER[\s\S]+?END;|[^;]+;)/g)!
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
export async function databaseHarness(
  backend: "sqlite" | "d1",
  files = migrationFiles,
): Promise<{ db: Database; close: () => Promise<void> }> {
  if (backend === "sqlite") {
    const client = new SQLite(":memory:");
    for (const file of files)
      client.exec(readFileSync(`packages/db/migrations/${file}`, "utf8"));
    return {
      db: sqlite(client),
      close: async () => {
        client.close();
      },
    };
  }
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('local')}}",
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      outboundService: () => new Response("Network disabled", { status: 503 }),
    }),
  );
  try {
    const client = await mf.getD1Database("DB");
    for (const statement of migrationStatements(files))
      await client.prepare(statement).run();
    return { db: d1(client), close: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
