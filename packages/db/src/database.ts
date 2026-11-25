import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { Database as SQLiteClient } from "better-sqlite3";
import type { AnyD1Database, DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";
export type Database =
  | (BetterSQLite3Database & { $client: SQLiteClient })
  | (DrizzleD1Database & { $client: AnyD1Database });
export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly conflict: T | null };
const jsonFields = new Set([
  "authors",
  "categories",
  "derived_arxiv_links",
  "topics",
  "counts",
  "content",
  "picks",
  "radar",
  "stats",
  "scopes",
  "tags",
  "folders",
  "annotation",
  "ideas",
  "papers",
  "paper_ids",
  "idea_ids",
  "project_ids",
  "status_request",
  "digest_suggestions",
  "links",
  "notes",
  "payload",
  "report",
]);
const booleans = new Set([
  "verified",
  "shortlisted",
  "final",
  "full_text_read",
  "look_back",
  "starred",
  "read_later",
  "legacy_vault",
]);
const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
export function decodeRow<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      jsonFields.has(key) && typeof value === "string"
        ? JSON.parse(value)
        : booleans.has(key)
          ? Boolean(value)
          : value,
    ]),
  ) as T;
}
export async function rows<T>(db: Database, query: SQL): Promise<T[]> {
  return (await db.all<Record<string, unknown>>(query)).map((row) =>
    decodeRow<T>(row),
  );
}
export async function first<T>(db: Database, query: SQL): Promise<T | null> {
  return (await rows<T>(db, query))[0] ?? null;
}
export function valueSql(value: unknown): SQL {
  return sql`${typeof value === "object" && value !== null ? JSON.stringify(value) : typeof value === "boolean" ? Number(value) : value}`;
}
export function whereSql(keys: Readonly<Record<string, unknown>>): SQL {
  return sql.join(
    Object.entries(keys).map(
      ([key, value]) => sql`${sql.identifier(key)} = ${valueSql(value)}`,
    ),
    sql` AND `,
  );
}
export async function atomic(
  db: Database,
  queries: readonly [SQL, ...SQL[]],
): Promise<number> {
  if ("batch" in db) {
    const dialect = new SQLiteAsyncDialect();
    const results = await db.$client.batch(
      queries.map((q) => {
        const compiled = dialect.sqlToQuery(q);
        return db.$client.prepare(compiled.sql).bind(...compiled.params);
      }),
    );
    return results.reduce(
      (total, result) => total + result.meta.rows_written,
      0,
    );
  }
  return db.transaction((tx) =>
    queries.reduce((total, query) => total + tx.run(query).changes, 0),
  );
}
/** Compare-and-swap is performed in the write statement, not only in the preflight read. */
export async function saveVersioned<T extends { rev: number }>(
  db: Database,
  table: string,
  keys: Record<string, unknown>,
  values: Record<string, unknown>,
  ifRev: number,
): Promise<WriteResult<T>> {
  z.number().int().nonnegative().parse(ifRev);
  const target = sql.identifier(table);
  const where = whereSql(keys);
  const current = await first<T>(
    db,
    sql`SELECT * FROM ${target} WHERE ${where}`,
  );
  if ((current?.rev ?? 0) !== ifRev) return { ok: false, conflict: current };
  const fields = { ...keys, ...values, rev: ifRev + 1 };
  const query = current
    ? sql`UPDATE ${target} SET ${sql.join(
        Object.entries(fields).map(
          ([k, v]) => sql`${sql.identifier(k)} = ${valueSql(v)}`,
        ),
        sql`, `,
      )} WHERE ${where} AND rev=${ifRev} RETURNING *`
    : sql`INSERT INTO ${target} (${sql.join(
        Object.keys(fields).map((k) => sql.identifier(k)),
        sql`, `,
      )}) VALUES (${sql.join(Object.values(fields).map(valueSql), sql`, `)}) ON CONFLICT DO NOTHING RETURNING *`;
  const result = await first<T>(db, query);
  return result
    ? { ok: true, value: result }
    : {
        ok: false,
        conflict: await first<T>(
          db,
          sql`SELECT * FROM ${target} WHERE ${where}`,
        ),
      };
}
