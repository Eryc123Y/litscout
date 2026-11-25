import { planImport, type SchemaRow } from "./import-plan";
import { splitSql } from "./sql";

const batchSize = 200;
const insertTarget = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+["'`[]?(\w+)/i;

export type KvEntry = {
  name: string;
  value: string;
  expiration?: number;
  metadata?: unknown;
};

/**
 * Copy a database into an empty one: the schema from `rows` (the source's
 * `sqlite_master`) and the rows from `dataSql` (INSERT statements, one per
 * row, as `wrangler d1 export --no-schema` writes them). Rows are applied
 * table by table in creation order, whatever order the export used.
 */
export async function runImport(
  db: D1Database,
  rows: SchemaRow[],
  dataSql: string,
) {
  const existing = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
    )
    .first<number>("n");
  if (existing)
    throw new Error(
      `Target database is not empty (${existing} tables). Import only into a new state folder.`,
    );
  const plan = planImport(rows);
  const byTable = new Map<string, string[]>(
    plan.dataTables.map((table) => [table, []]),
  );
  for (const sql of splitSql(dataSql)) {
    if (/^PRAGMA\b/i.test(sql)) continue;
    const table = insertTarget.exec(sql)?.[1];
    const bucket = table ? byTable.get(table) : undefined;
    if (!bucket)
      throw new Error(
        `Unexpected statement in the data file: ${sql.slice(0, 80)}`,
      );
    bucket.push(sql);
  }
  await runEach(db, plan.before, "schema");
  let inserted = 0;
  for (const table of plan.dataTables) {
    const statements = byTable.get(table)!;
    for (let i = 0; i < statements.length; i += batchSize) {
      const chunk = statements.slice(i, i + batchSize);
      try {
        await db.batch([
          db.prepare("PRAGMA defer_foreign_keys = on"),
          ...chunk.map((sql) => db.prepare(sql)),
        ]);
      } catch {
        // Find the row: repeat the batch one statement at a time.
        await runEach(db, chunk, `${table} rows ${i + 1}-${i + chunk.length}`);
      }
      inserted += chunk.length;
    }
  }
  await runEach(db, plan.after, "indexes and triggers");
  await runEach(db, plan.ftsChecks, "search index check");
  return {
    tables: plan.dataTables.length,
    rows: inserted,
    ftsChecked: plan.ftsChecks.length,
  };
}

/** Run statements one by one; name the failing one without its values. */
async function runEach(db: D1Database, statements: string[], step: string) {
  for (const [index, sql] of statements.entries()) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Import failed at ${step}, statement ${index + 1} (${sql.slice(0, 48)}…, ${sql.length} characters): ${message}`,
      );
    }
  }
}

/** Row counts of the given tables, one query each (D1 limits compound selects). */
export async function tableCounts(db: D1Database, tables: string[]) {
  const counts: Record<string, number> = {};
  for (const table of tables)
    counts[table] =
      (await db
        .prepare(`SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"`)
        .first<number>("n")) ?? 0;
  return counts;
}

/** Every plain table of a database, for `counts`. */
export async function plainTables(db: D1Database) {
  const { results } = await db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY rowid",
    )
    .all<SchemaRow>();
  return planImport(results).dataTables;
}

export async function importKv(kv: KVNamespace, entries: KvEntry[]) {
  for (const entry of entries)
    await kv.put(entry.name, entry.value, {
      ...(entry.expiration ? { expiration: entry.expiration } : {}),
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    });
  return entries.length;
}
