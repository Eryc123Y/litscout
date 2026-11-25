import { titleKey, vaultTitleKey } from "@litscout/core/normalize";
import {
  backupCompactPaperSchema,
  backupPaperSchema,
} from "@litscout/pipeline/backup-contracts";
import {
  restoreItemSchemas,
  restorePageSize,
  restorePersonalSections,
  type RestoreItem,
  type RestorePage,
  type RestoreSection,
} from "@litscout/pipeline/backup-restore-contracts";
import { compactPaperInsert, readBackupCounts } from "./backup";
import type { IngestDatabase } from "./ingest-store";

type Row = Record<string, unknown>;
type Spec = {
  table: string;
  /** Columns stored as JSON text. */
  json?: readonly string[];
  /** Columns the export leaves out, derived from the row. */
  extra?: (row: Row) => Row;
  /** Foreign keys that must exist, or the row is skipped. */
  requires?: Readonly<Record<string, string>>;
  /** Nullable foreign keys, cleared when their row is not there. */
  clears?: Readonly<Record<string, string>>;
};

const specs: Record<Exclude<RestoreSection, "papers">, Spec> = {
  topics: { table: "topics", json: ["keywords"] },
  paperIdentifiers: { table: "paper_ids", requires: { paper_id: "papers" } },
  paperLinks: { table: "paper_links", requires: { paper_id: "papers" } },
  vaultIndex: {
    table: "vault_notes",
    json: ["frontmatter"],
    // Note bodies stay out of export files. An empty fingerprint makes the
    // next sync upload a restored project, idea or draft again, body included.
    extra: (row) =>
      ["project", "idea", "working_paper"].includes(String(row.kind))
        ? { fingerprint: "" }
        : {},
  },
  projects: {
    table: "projects",
    json: ["keywords"],
    // Profile documents are not exported; the next vault sync relinks them.
    clears: {
      profile_doc_id: "profile_docs",
      brief_doc_id: "profile_docs",
      vault_note_id: "vault_notes",
    },
  },
  ideaIndex: {
    table: "idea_index",
    json: ["paper_ids"],
    requires: { vault_note_id: "vault_notes" },
    clears: { project_id: "projects" },
  },
  workingPaperIndex: {
    table: "working_paper_index",
    json: ["idea_ids", "paper_ids"],
    requires: { vault_note_id: "vault_notes" },
    clears: { project_id: "projects" },
  },
  vaultRequests: {
    table: "vault_requests",
    json: ["payload"],
    clears: { target_note_id: "vault_notes" },
  },
  captures: { table: "captures", requires: { id: "vault_requests" } },
  suggestions: {
    table: "suggestions",
    json: ["idea_ids", "paper_ids", "project_ids"],
    clears: { request_id: "vault_requests" },
  },
  library: {
    table: "library_items",
    json: ["tags"],
    requires: { paper_id: "papers" },
  },
  alphaXiv: {
    table: "alphaxiv_items",
    json: ["folders", "annotation"],
    requires: { paper_id: "papers" },
  },
  paperState: { table: "paper_state", requires: { paper_id: "papers" } },
  quickNotes: { table: "notes", extra: () => ({ target_type: "paper" }) },
  digests: { table: "digests", json: ["picks", "radar"] },
  weeklyDigests: { table: "digests", json: ["picks", "radar"] },
};
const fullPaper: Spec = {
  table: "papers",
  json: ["authors", "categories", "derived_arxiv_links"],
  extra: (row) => ({
    title_norm: titleKey(String(row.title)),
    vault_title_norm: vaultTitleKey(String(row.title)),
    // The export leaves out an empty recipe list.
    derived_arxiv_links: row.derived_arxiv_links ?? [],
  }),
};

/**
 * One guarded insert. It never replaces a row: an existing key, or a
 * required parent that is missing, leaves the instance as it was.
 */
function insert(db: IngestDatabase, spec: Spec, row: Row) {
  const values = { ...row, ...spec.extra?.(row) };
  const columns = Object.keys(values);
  const slot = (column: string) => `?${columns.indexOf(column) + 1}`;
  const selected = columns.map((column) => {
    const parent = spec.clears?.[column];
    return parent
      ? `(SELECT id FROM ${parent} WHERE id=${slot(column)})`
      : slot(column);
  });
  const guards = Object.entries(spec.requires ?? {}).map(
    ([column, parent]) =>
      `(${slot(column)} IS NULL OR EXISTS(SELECT 1 FROM ${parent} WHERE id=${slot(column)}))`,
  );
  return db
    .prepare(
      `INSERT INTO ${spec.table}(${columns.join(",")})
      SELECT ${selected.join(",")} WHERE ${guards.join(" AND ") || "1"}
      ON CONFLICT DO NOTHING`,
    )
    .bind(
      ...columns.map((column) => {
        const value = values[column];
        return spec.json?.includes(column) && value !== null
          ? JSON.stringify(value)
          : value;
      }),
    );
}

function statement(db: IngestDatabase, section: RestoreSection, item: Row) {
  if (section !== "papers") return insert(db, specs[section], item);
  return "compact" in item
    ? compactPaperInsert(db, backupCompactPaperSchema.parse(item))
    : insert(db, fullPaper, backupPaperSchema.parse(item));
}

/** Insert one verified export page. Counts rows inserted and rows left as they were. */
export async function restoreBackupPage(db: IngestDatabase, page: RestorePage) {
  const items = page.items as RestoreItem[];
  if (!items.length || items.length > restorePageSize)
    throw new RangeError("Use bounded restore pages");
  const schema = restoreItemSchemas[page.section];
  const results = await db.batch(
    items.map((item) => statement(db, page.section, schema.parse(item) as Row)),
  );
  const inserted = results.filter(({ meta }) => meta.changes > 0).length;
  return {
    inserted,
    skipped: items.length - inserted,
    rowsWritten: results.reduce((sum, { meta }) => sum + meta.rows_written, 0),
  };
}

/** Exported counts, and how many of them are personal rows. */
export async function readRestoreStatus(db: IngestDatabase) {
  const counts = await readBackupCounts(db);
  return {
    personalRows: restorePersonalSections.reduce(
      (sum, section) => sum + counts[section],
      0,
    ),
    counts,
  };
}
