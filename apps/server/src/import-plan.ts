/** A row of `sqlite_master`: a table, index or trigger and its SQL. */
export type SchemaRow = { type: string; name: string; sql: string | null };

export type ImportPlan = {
  /** Plain tables whose rows are copied, in creation order. */
  dataTables: string[];
  /** Run before the rows: tables, FTS tables, views and the triggers that fill FTS tables. */
  before: string[];
  /** Run after the rows: indexes and every other trigger. */
  after: string[];
  /** Integrity checks for FTS tables that index another table. */
  ftsChecks: string[];
};

const ftsShadow = /^_(?:data|idx|content|docsize|config)$/;
const written =
  /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["'`[]?(\w+)/gi;

const statement = (sql: string) => {
  const trimmed = sql.trim();
  return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
};

/**
 * Creation order, except that a table's foreign-key parents come just before
 * it. A later migration can rebuild a table with a reference to a table made
 * after it; rows must still go into the parent first.
 */
function referenceOrder(tables: { name: string; sql: string }[]): string[] {
  const names = new Set(tables.map((table) => table.name));
  const parents = new Map(
    tables.map((table) => [
      table.name,
      [...table.sql.matchAll(/\bREFERENCES\s+["'`[]?(\w+)/gi)]
        .map((match) => match[1]!)
        .filter((parent) => parent !== table.name && names.has(parent)),
    ]),
  );
  const position = new Map(tables.map((table, i) => [table.name, i]));
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const own = [...new Set(parents.get(name))].sort(
      (a, b) => position.get(a)! - position.get(b)!,
    );
    for (const parent of own) visit(parent);
    order.push(name);
  };
  for (const table of tables) visit(table.name);
  return order;
}

/** Tables a trigger's body writes to. */
function triggerTargets(sql: string): string[] {
  const begin = sql.search(/\bBEGIN\b/i);
  const body = begin === -1 ? sql : sql.slice(begin);
  return [...body.matchAll(written)].map((match) => match[1]!);
}

/**
 * Order a copy of a database so it ends up as the original was. FTS tables
 * fill through their own triggers while rows go in; triggers that keep
 * counts or other derived rows are created afterwards, because those rows
 * are copied too and would otherwise be counted twice.
 */
export function planImport(rows: SchemaRow[]): ImportPlan {
  const kept = rows.filter(
    (row) =>
      row.sql &&
      !row.name.startsWith("sqlite_") &&
      !row.name.startsWith("_cf_"),
  ) as (SchemaRow & { sql: string })[];
  const virtual = kept.filter(
    (row) =>
      row.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql),
  );
  const virtualNames = new Set(virtual.map((row) => row.name));
  const isShadow = (name: string) =>
    [...virtualNames].some(
      (table) =>
        name.startsWith(`${table}_`) &&
        ftsShadow.test(name.slice(table.length)),
    );
  const plain = kept.filter(
    (row) =>
      row.type === "table" &&
      !virtualNames.has(row.name) &&
      !isShadow(row.name),
  );
  const ftsTriggers: string[] = [];
  const otherTriggers: string[] = [];
  for (const row of kept.filter((r) => r.type === "trigger")) {
    const targets = triggerTargets(row.sql);
    const fts = targets.filter((t) => virtualNames.has(t));
    if (fts.length && fts.length !== targets.length)
      throw new Error(
        `Trigger ${row.name} writes both an FTS table and another table; it cannot be ordered for import.`,
      );
    (fts.length ? ftsTriggers : otherTriggers).push(statement(row.sql));
  }
  const indexes = kept
    .filter((row) => row.type === "index")
    .map((row) => statement(row.sql));
  // Views hold no rows; they only need the tables they read.
  const views = kept
    .filter((row) => row.type === "view")
    .map((row) => statement(row.sql));
  return {
    dataTables: referenceOrder(plain),
    before: [
      ...plain.map((row) => statement(row.sql)),
      ...virtual.map((row) => statement(row.sql)),
      ...views,
      ...ftsTriggers,
    ],
    after: [...indexes, ...otherTriggers],
    ftsChecks: virtual
      .filter((row) => /\bcontent\s*=\s*'[^']+'/i.test(row.sql))
      .map(
        (row) =>
          `INSERT INTO ${row.name}(${row.name}) VALUES('integrity-check');`,
      ),
  };
}
