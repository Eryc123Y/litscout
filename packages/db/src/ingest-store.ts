export type IngestDatabase = Pick<D1Database, "prepare" | "batch">;
type Values = Readonly<Record<string, unknown>>;
const encode = (v: unknown): string | number | null =>
  v === undefined || v === null
    ? null
    : typeof v === "object"
      ? JSON.stringify(v)
      : typeof v === "boolean"
        ? Number(v)
        : (v as string | number);
const fields = new Map<string, string>();
function field(name: string) {
  const cached = fields.get(name);
  if (cached) return cached;
  if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid SQL identifier");
  const escaped = '"' + name + '"';
  fields.set(name, escaped);
  return escaped;
}
/** Conditional SQL upserts keep identical payloads out of SQLite's writes and FTS triggers. */
export function upsertStatement(
  db: IngestDatabase,
  table: string,
  keys: readonly string[],
  values: Values,
  versioned = false,
  updateGuard = "1",
) {
  const columns = Object.keys(values),
    changing = columns.filter((c) => !keys.includes(c));
  const assignments = changing.map((c) => `${field(c)}=excluded.${field(c)}`);
  if (versioned) assignments.push("rev=rev+1");
  if (["papers", "digests", "sync_cursors"].includes(table))
    assignments.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const sql = `INSERT INTO ${field(table)} (${columns.map(field).join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT (${keys.map(field).join(",")}) ${changing.length ? `DO UPDATE SET ${assignments.join(",")} WHERE (${changing.map((c) => `${field(c)} IS NOT excluded.${field(c)}`).join(" OR ")}) AND (${updateGuard})` : "DO NOTHING"}`;
  return db.prepare(sql).bind(...Object.values(values).map(encode));
}
export async function writeBatch(
  db: IngestDatabase,
  statements: D1PreparedStatement[],
) {
  if (!statements.length) return 0;
  const results = await db.batch(statements);
  return results.reduce((n, r) => n + r.meta.rows_written, 0);
}
export const stableId = async (prefix: string, value: string) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return (
    prefix +
    [...bytes]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 26)
  );
};
