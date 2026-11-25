import { readFileSync } from "node:fs";
export type FtsVariant = "compact" | "lean";
function table(name: string, content: string, fields: readonly string[]) {
  const columns = fields.join(", ");
  const values = (prefix: string) =>
    fields.map((c) => `${prefix}.${c}`).join(", ");
  return `CREATE VIRTUAL TABLE ${name}_fts USING fts5(${columns}, content='${content}', content_rowid='rowid', detail=column, columnsize=0);
CREATE TRIGGER ${name}_fts_insert AFTER INSERT ON ${content} BEGIN
 INSERT INTO ${name}_fts(rowid, ${columns}) VALUES (new.rowid, ${values("new")});
END;
CREATE TRIGGER ${name}_fts_delete AFTER DELETE ON ${content} BEGIN
 INSERT INTO ${name}_fts(${name}_fts, rowid, ${columns}) VALUES ('delete', old.rowid, ${values("old")});
END;
CREATE TRIGGER ${name}_fts_update AFTER UPDATE ON ${content} BEGIN
 INSERT INTO ${name}_fts(${name}_fts, rowid, ${columns}) VALUES ('delete', old.rowid, ${values("old")});
 INSERT INTO ${name}_fts(rowid, ${columns}) VALUES (new.rowid, ${values("new")});
END;`;
}
export function ftsMigration(variant: FtsVariant) {
  const current = readFileSync("packages/db/migrations/0002_fts.sql", "utf8");
  const tail = current.slice(
    current.indexOf("CREATE TRIGGER summary_tldr_insert"),
  );
  return [
    table(
      "paper",
      "papers",
      variant === "compact" ? ["title", "abstract", "tldr"] : ["title", "tldr"],
    ),
    table("note", "notes", ["body_md"]),
    table("idea", "ideas", ["title", "body_md"]),
    tail,
  ].join("\n\n");
}
export function selectedVariant(): FtsVariant {
  return /fts5\(title,\s*abstract/.test(
    readFileSync("packages/db/migrations/0002_fts.sql", "utf8"),
  )
    ? "compact"
    : "lean";
}
