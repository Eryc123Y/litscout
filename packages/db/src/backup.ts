import { writeBatch } from "./ingest-store";
import { vaultTitleKey } from "@litscout/core/normalize";
import {
  backupSectionSchemas,
  backupSectionKeys,
  backupPaperSchema,
  backupCompactPaperSchema,
  backupIdentifierSchema,
  backupLinkSchema,
  backupPageSize,
  backupPaperChildPageSize,
  backupPaperReferences,
  backupSections,
  type BackupCounts,
  type BackupSection,
  type BackupPaperCursor,
} from "@litscout/pipeline/backup-contracts";
import type { z } from "zod";
import type { IngestDatabase } from "./ingest-store";

type Row = Record<string, unknown>;
type PageSource = {
  table: string;
  ownerKey?: boolean;
  visible?: string;
  json?: string[];
};
const owned = "user_id='u_owner'";
const live = "deleted_at IS NULL";
const ownerLive = `${owned} AND ${live}`;
const sources: Record<BackupSection, PageSource> = {
  library: {
    table: "library_items",
    ownerKey: true,
    visible: live,
    json: ["tags"],
  },
  alphaXiv: {
    table: "alphaxiv_items",
    ownerKey: true,
    visible: `${live} AND removed_at IS NULL`,
    json: ["folders", "annotation"],
  },
  paperState: {
    table: "paper_state",
    ownerKey: true,
    visible: live,
  },
  quickNotes: {
    table: "notes",
    visible: `${ownerLive} AND target_type='paper'`,
  },
  digests: {
    table: "digests",
    visible: "kind='daily'",
    json: ["picks", "radar"],
  },
  weeklyDigests: {
    table: "digests",
    visible: "kind='weekly'",
    json: ["picks", "radar"],
  },
  topics: { table: "topics", json: ["keywords"] },
  projects: {
    table: "projects",
    visible: ownerLive,
    json: ["keywords"],
  },
  vaultIndex: {
    table: "vault_notes",
    visible: live,
    json: ["frontmatter"],
  },
  ideaIndex: {
    table: "idea_index",
    json: ["paper_ids"],
    visible:
      "EXISTS(SELECT 1 FROM vault_notes v WHERE v.id=idea_index.vault_note_id AND v.deleted_at IS NULL)",
  },
  workingPaperIndex: {
    table: "working_paper_index",
    json: ["idea_ids", "paper_ids"],
    visible:
      "EXISTS(SELECT 1 FROM vault_notes v WHERE v.id=working_paper_index.vault_note_id AND v.deleted_at IS NULL)",
  },
  captures: { table: "captures", visible: owned },
  vaultRequests: { table: "vault_requests", json: ["payload"] },
  suggestions: {
    table: "suggestions",
    visible: ownerLive,
    json: ["idea_ids", "paper_ids", "project_ids"],
  },
};

export const backupKeyWidth = (section: BackupSection) =>
  backupSectionKeys[section].length;

export class CorruptBackupRow extends Error {
  constructor(section: string, key: readonly unknown[], column: string) {
    super(
      `Invalid stored JSON in export section ${section}, key ${JSON.stringify(key)}, column ${column}`,
    );
  }
}

function decode(
  row: Row,
  section: string,
  key: readonly string[],
  shape: Record<string, z.ZodType>,
  columns: readonly string[] = [],
) {
  for (const name of columns) {
    try {
      const value = row[name];
      row[name] = shape[name]!.parse(
        typeof value === "string" ? JSON.parse(value) : value,
      );
    } catch {
      throw new CorruptBackupRow(
        section,
        key.map((name) => row[name]),
        name,
      );
    }
  }
  return row;
}

function scope({ ownerKey, visible = "1" }: PageSource) {
  return ownerKey ? `${owned} AND (${visible})` : visible;
}

const referenceQueries = backupSections.flatMap((section) => {
  const source = sources[section];
  return (backupPaperReferences[section] ?? []).map(
    ({ column, array, key }) => {
      const field = `${source.table}.${column}`;
      // Let the paged decoder report malformed JSON with its section and key.
      const validJson = `CASE WHEN json_valid(${field}) THEN ${field} END`;
      const from = array
        ? `${source.table}, json_each(${validJson}) AS ref`
        : source.table;
      const id = key
        ? array
          ? `CASE WHEN ref.type='object' THEN json_extract(ref.value,'$.${key}') END`
          : `json_extract(${validJson},'$.${key}')`
        : array
          ? "ref.value"
          : field;
      return `SELECT ${id} FROM ${from} WHERE ${scope(source)}`;
    },
  );
});

// D1 limits the number of SELECT terms in a compound statement. Combine
// small groups, then deduplicate their IDs across all the reference sources.
const referenceGroups: string[] = [];
for (let i = 0; i < referenceQueries.length; i += 4)
  referenceGroups.push(
    `SELECT * FROM (${referenceQueries.slice(i, i + 4).join(" UNION ALL ")})`,
  );

const paperCountsSql = `
  WITH reference_ids(id) AS (${referenceGroups.join(" UNION ")}),
    export_papers AS MATERIALIZED (
      SELECT p.id FROM reference_ids r JOIN papers p ON p.id=r.id
      WHERE typeof(r.id)='text' AND r.id<>'' AND ${ownerLive}
      UNION ALL SELECT i.paper_id FROM reference_ids r JOIN paper_index i ON i.paper_id=r.id
        WHERE i.has_canonical=0 AND NOT EXISTS(SELECT 1 FROM papers WHERE id=i.paper_id)
    )
  SELECT
    (SELECT COUNT(*) FROM export_papers) AS papers,
    (SELECT COUNT(*) FROM export_papers p JOIN paper_ids i ON i.paper_id=p.id) AS paperIdentifiers,
    (SELECT COUNT(*) FROM export_papers p JOIN paper_links l ON l.paper_id=p.id
      WHERE ${owned}) AS paperLinks
`;

/** Count each export section in the same D1 batch, before fetching any pages. */
export async function readBackupCounts(db: IngestDatabase) {
  const statements = backupSections.map((section) => {
    const source = sources[section];
    return db.prepare(
      `SELECT COUNT(*) AS ${section} FROM ${source.table} WHERE ${scope(source)}`,
    );
  });
  statements.push(db.prepare(paperCountsSql));
  const results = await db.batch<Partial<BackupCounts>>(statements);
  return Object.assign({}, ...results.map(({ results }) => results[0])) as Omit<
    BackupCounts,
    "configuredTopics"
  >;
}

/** Cursor advances over the indexed candidate window, including hidden rows. */
export async function readBackupSection(
  db: IngestDatabase,
  section: BackupSection,
  after?: string[],
) {
  const { table, ownerKey, visible = "1", json } = sources[section];
  const key = backupSectionKeys[section];
  const schema = backupSectionSchemas[section];
  const fields = schema.keyof().options.join(",");
  const order = key.join(",");
  const cmp = key.length === 1 ? key[0] : `(${order})`;
  const placeholders =
    key.length === 1 ? "?" : `(${key.map(() => "?").join(",")})`;
  const filters = [
    ownerKey ? owned : "",
    after ? `${cmp}>${placeholders}` : "",
  ].filter(Boolean);
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await db
    .prepare(
      `
    SELECT ${fields},(${visible}) AS visible FROM ${table} ${where}
    ORDER BY ${order} LIMIT ${backupPageSize + 1}
  `,
    )
    .bind(...(after ?? []))
    .all<Row>();
  const candidates = result.results.slice(0, backupPageSize);
  const tail = candidates.at(-1);
  return {
    items: candidates.flatMap(({ visible, ...row }) =>
      visible ? [decode(row, section, key, schema.shape, json)] : [],
    ),
    nextCursor:
      result.results.length > backupPageSize && tail
        ? JSON.stringify(key.map((column) => tail[column]))
        : null,
  };
}

const paperFields = backupPaperSchema.keyof().options.join(",");
const identifierFields = backupIdentifierSchema.keyof().options.join(",");
const linkFields = backupLinkSchema.keyof().options.join(",");

function identifiers(db: IngestDatabase, id: string, after?: [string, string]) {
  return db
    .prepare(
      `
    SELECT ${identifierFields} FROM paper_ids WHERE paper_id=?
    ${after ? "AND (scheme,value)>(?,?)" : ""}
    ORDER BY scheme,value LIMIT ${backupPaperChildPageSize + 1}
  `,
    )
    .bind(id, ...(after ?? []));
}

function links(db: IngestDatabase, id: string, after?: [string, string]) {
  return db
    .prepare(
      `
    SELECT ${linkFields},(${owned}) AS visible FROM paper_links WHERE paper_id=?
    ${after ? "AND (kind,url)>(?,?)" : ""}
    ORDER BY kind,url LIMIT ${backupPaperChildPageSize + 1}
  `,
    )
    .bind(id, ...(after ?? []));
}

function childPage<T extends Row, Cursor>(rows: T[], key: (row: T) => Cursor) {
  const items = rows.slice(0, backupPaperChildPageSize);
  return {
    next: rows.length > backupPaperChildPageSize ? key(items.at(-1)!) : null,
    items,
  };
}

/** One batch: a metadata lookup, then at most two bounded child statements per paper. */
export async function readBackupPapers(
  db: IngestDatabase,
  cursors: BackupPaperCursor[],
) {
  const includesFirstPage = cursors.some(
    ({ identifiersAfter, linksAfter }) =>
      identifiersAfter === undefined && linksAfter === undefined,
  );
  const statements = [
    db
      .prepare(
        `
    SELECT ${includesFirstPage ? paperFields : "id"} FROM papers
    WHERE id IN (${cursors.map(() => "?").join(",")}) AND ${ownerLive}
  `,
      )
      .bind(...cursors.map(({ id }) => id)),
  ];
  const compactIndex = includesFirstPage
    ? statements.push(
        db
          .prepare(
            `
    SELECT paper_id AS id,arxiv_id,doi,day,title,title_norm,topics,venue FROM paper_index i
    WHERE paper_id IN (${cursors.map(() => "?").join(",")}) AND has_canonical=0
      AND NOT EXISTS(SELECT 1 FROM papers WHERE id=i.paper_id)
  `,
          )
          .bind(...cursors.map(({ id }) => id)),
      ) - 1
    : -1;
  const lookup = (statement: D1PreparedStatement) =>
    statements.push(statement) - 1;
  const indices = cursors.map(({ id, identifiersAfter, linksAfter }) => ({
    id,
    first: identifiersAfter === undefined && linksAfter === undefined,
    identifiersIndex:
      identifiersAfter === null
        ? -1
        : lookup(identifiers(db, id, identifiersAfter)),
    linksIndex: linksAfter === null ? -1 : lookup(links(db, id, linksAfter)),
  }));
  const result = await db.batch<Row>(statements);
  const metadata = new Map(result[0]!.results.map((row) => [row.id, row]));
  const compact = new Map(
    (result[compactIndex]?.results ?? []).map((row) => [row.id, row]),
  );
  return indices.map(({ id, first, identifiersIndex, linksIndex }) => {
    const paper = metadata.get(id);
    const archived = compact.get(id);
    const recipeFields =
      paper?.derived_arxiv_links === undefined ||
      paper.derived_arxiv_links === "[]"
        ? []
        : ["derived_arxiv_links"];
    if (paper?.derived_arxiv_links === "[]") delete paper.derived_arxiv_links;
    const idPage = childPage(
      paper ? (result[identifiersIndex]?.results ?? []) : [],
      ({ scheme, value }) => [scheme, value],
    );
    const linkPage = childPage(
      paper ? (result[linksIndex]?.results ?? []) : [],
      ({ kind, url }) => [kind, url],
    );
    return {
      id,
      paper:
        first && paper
          ? decode(paper, "papers", ["id"], backupPaperSchema.shape, [
              "authors",
              "categories",
              ...recipeFields,
            ])
          : first && archived
            ? decode(
                { ...archived, compact: true },
                "papers",
                ["id"],
                backupCompactPaperSchema.shape,
                ["topics"],
              )
            : null,
      identifiers: idPage.items,
      links: linkPage.items.flatMap(({ visible, ...row }) =>
        visible ? [row] : [],
      ),
      identifiersAfter: idPage.next,
      linksAfter: linkPage.next,
    };
  });
}

/** Insert one compact record unless a full record or the same key exists. */
export function compactPaperInsert(
  db: IngestDatabase,
  record: z.output<typeof backupCompactPaperSchema>,
) {
  return db
    .prepare(
      `INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title,title_norm,topics,venue,has_canonical)
      SELECT ?1,?,?,?,?,?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM papers WHERE id=?1)
      ON CONFLICT(paper_id) DO NOTHING`,
    )
    .bind(
      record.id,
      record.arxiv_id,
      record.doi,
      record.day,
      record.title,
      record.title_norm ?? vaultTitleKey(record.title),
      JSON.stringify(record.topics),
      record.venue,
    );
}

/** Restore a verified compact export into a migrated database without changing a full record. */
export function restoreCompactPapers(db: IngestDatabase, input: unknown[]) {
  if (input.length > backupPageSize)
    throw new RangeError("Use bounded compact restore pages");
  return writeBatch(
    db,
    input.map((raw) =>
      compactPaperInsert(db, backupCompactPaperSchema.parse(raw)),
    ),
  );
}
