import { z } from "zod";
import { databaseHarness, migrationFiles } from "../test/harness";
import { ingestPapers } from "../src/ingest-papers";
import { ingestSummaryRecords } from "../src/ingest-records";
import { ingestDigest, ingestFeedDay } from "../src/ingest";
import {
  hashVaultText,
  publishVaultIndex,
  stageVaultIndex,
} from "../src/vault-index";
import type { IngestDatabase } from "../src/ingest-store";
import { fixture, textGenerator } from "./size-model";
import { chunks } from "@litscout/pipeline/api";
function workload(count: number, offset = 0) {
  const text = textGenerator();
  return Array.from({ length: count }, (_, i) => fixture(offset + i, text));
}
/** Columns today's code writes on every schema it measures. A nullable
 * column adds no rows, so older measurements stay comparable. */
const requiredColumns = ["0025_note_bodies.sql"];
function migrationsThrough(version?: string) {
  if (!version) return migrationFiles;
  const files = migrationFiles.filter((file) => file.slice(0, 4) <= version);
  return [...files, ...requiredColumns.filter((file) => !files.includes(file))];
}
function readMeter(db: IngestDatabase) {
  let rows = 0;
  const tables = new WeakMap<D1PreparedStatement, string>();
  const writes: Record<string, number> = {};
  return {
    db: {
      prepare(sql: string) {
        const table = /INSERT(?: OR IGNORE)? INTO "?([a-z_]+)/i.exec(sql)?.[1];
        const statement = db.prepare(sql);
        if (!table) return statement;
        return new Proxy(statement, {
          get(target, key, receiver) {
            if (key !== "bind") return Reflect.get(target, key, receiver);
            return (...values: unknown[]) => {
              const bound = target.bind(...values);
              tables.set(bound, table);
              return bound;
            };
          },
        });
      },
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const results = await db.batch<T>(statements);
        rows += results.reduce((n, r) => n + r.meta.rows_read, 0);
        results.forEach((result, i) => {
          const table = tables.get(statements[i]!);
          if (table)
            writes[table] = (writes[table] ?? 0) + result.meta.rows_written;
        });
        return results;
      },
    },
    writes,
    take() {
      const n = rows;
      rows = 0;
      return n;
    },
  };
}
function paperInputs(rows: ReturnType<typeof workload>) {
  return rows.map((r) => ({
    key: r.arxiv,
    title: r.title,
    abstract: r.abstract,
    authors: ["Synthetic Author"],
    source: "arxiv",
    identifiers: [
      { scheme: "arxiv", value: r.arxiv },
      { scheme: "doi", value: r.doi },
    ],
    links: [
      { kind: "landing", url: `https://doi.org/${r.doi}` },
      { kind: "pdf_arxiv", url: `https://arxiv.org/pdf/${r.arxiv}` },
    ],
  }));
}

async function sample(db: IngestDatabase, rows: ReturnType<typeof workload>) {
  const papers = paperInputs(rows);
  const meter = readMeter(db);
  const first = await ingestPapers(meter.db, "2026-11-17", papers);
  const paperWrites = { ...meter.writes };
  const paperRowsRead = meter.take();
  const summaries = rows.map((r, i) => {
    const content = JSON.parse(r.summary);
    return {
      paperId: first.papers[i]!.paperId,
      lang: "en",
      content: {
        ...content,
        tldr: content.tldr.slice(0, -4),
        motivation: "m",
        method: "m",
        result: "r",
        conclusion: "c",
      },
    };
  });
  const second = await ingestSummaryRecords(meter.db, { summaries });
  const summaryRowsRead = meter.take();
  const replay = await ingestPapers(db, "2026-11-17", papers);
  const summaryReplay = await ingestSummaryRecords(meter.db, { summaries });
  const metadata = await ingestPapers(
    db,
    "2026-11-17",
    papers.map((paper) => ({
      ...paper,
      authors: ["Updated Synthetic Author"],
    })),
  );
  return {
    paperWrites,
    metadataRows: metadata.rowsWritten,
    paperRowsRead,
    summaryRowsRead,
    paperRows: first.rowsWritten,
    summaryRows: second.rowsWritten,
    unchanged: replay.rowsWritten + summaryReplay.rowsWritten,
  };
}

type WriteBreakdown = {
  rowsWritten: number;
  tables: Record<string, number>;
  indexes: Record<string, number>;
  newFtsShadowRows?: Record<string, number>;
};

function checkedBreakdown(
  rowsWritten: number,
  { tables, indexes }: Omit<WriteBreakdown, "rowsWritten">,
): WriteBreakdown {
  const attributed = [
    ...Object.values(tables),
    ...Object.values(indexes),
  ].reduce((total, rows) => total + rows, 0);
  if (attributed !== rowsWritten)
    throw new Error(`Attributed ${attributed} of ${rowsWritten} D1 writes`);
  return { rowsWritten, tables, indexes };
}

/** One paper on a new day, through the real ingest and vault repositories. */
export async function measureWriteBreakdown(through?: string) {
  const h = await databaseHarness("d1", migrationsThrough(through));
  const db = h.db.$client as unknown as IngestDatabase;
  try {
    const shadowRows = () =>
      db
        .prepare(
          `SELECT (SELECT count(*) FROM paper_fts_idx) AS paper_fts_idx,
        (SELECT count(*) FROM paper_fts_data) AS paper_fts_data`,
        )
        .first<Record<string, number>>();
    const shadowGrowth = (
      before: Record<string, number>,
      after: Record<string, number>,
    ) =>
      Object.fromEntries(
        Object.entries(after).map(([table, rows]) => [
          table,
          rows - before[table]!,
        ]),
      );
    async function activity(day: string, offset: number, control = false) {
      const papers = paperInputs(workload(1, offset));
      const beforePaper = control ? {} : (await shadowRows())!;
      const paper = await ingestPapers(db, day, papers);
      const afterPaper = control ? {} : (await shadowRows())!;
      const paperId = paper.papers[0]!.paperId;
      const summaries = {
        summaries: [
          {
            paperId,
            content: {
              tldr: "Depth from stereo",
              motivation: "M",
              method: "M",
              result: "R",
              conclusion: "C",
            },
          },
        ],
      };
      const summary = await ingestSummaryRecords(db, summaries);
      const afterSummary = control ? {} : (await shadowRows())!;
      return {
        paper: paper.rowsWritten,
        summary: summary.rowsWritten,
        paperShadowRows: shadowGrowth(beforePaper, afterPaper),
        summaryShadowRows: shadowGrowth(afterPaper, afterSummary),
        paperId,
        papers,
        summaries,
      };
    }

    const day = "2026-11-17";
    const full = await activity(day, 0);
    const { papers, paperId, summaries } = full;
    const feedDay = { day, status: "summarised", counts: { arxiv: 1 } };
    const feedWrites = await ingestFeedDay(db, feedDay);
    const digest = { day, bodyMd: "# Daily digest", picks: [paperId] };
    const digestWrites = await ingestDigest(db, digest);
    const replay =
      (await ingestPapers(db, day, papers)).rowsWritten +
      (await ingestSummaryRecords(db, summaries)).rowsWritten +
      (await ingestDigest(db, digest)) +
      (await ingestFeedDay(db, { ...feedDay, status: "digested" }));
    const path = "Notes/M3i.md";
    const id = await hashVaultText(path);
    const snapshot = await hashVaultText("M3i write-cost fixture");
    const note = {
      id,
      path,
      kind: "paper_note" as const,
      title: papers[0]!.title,
      frontmatter: {},
      hash: id,
      bodyHash: id,
    };
    const staged = await stageVaultIndex(h.db, {
      snapshot,
      previous: null,
      part: 0,
      notes: [note],
    });
    const published = await publishVaultIndex(
      h.db,
      { snapshot, previous: null, parts: 1, count: 1, changes: 1 },
      day,
    );
    const vaultRefresh = await publishVaultIndex(
      h.db,
      { snapshot, previous: snapshot, parts: 1, count: 1, changes: 0 },
      day,
    );
    if (!staged.accepted || !published.published || !vaultRefresh.published)
      throw new Error("Vault index fixture was rejected");

    // Paired controls distinguish trigger writes from the statement's own
    // writes. D1 charges the FTS virtual-table operations in its metadata.
    await db.batch(
      ["paper_fts_insert", "paper_fts_update"].map((name) =>
        db.prepare(`DROP TRIGGER ${name}`),
      ),
    );
    const noFts = await activity("2026-11-18", 1, true);
    await db.prepare("DROP TRIGGER summary_tldr_insert").run();
    const noTldr = await activity("2026-11-19", 2, true);

    async function directWrites(
      inserts: Record<string, number>,
      updates: Record<string, readonly string[]> = {},
    ) {
      const tables = { ...inserts };
      const indexes: Record<string, number> = {};
      for (const table of new Set([
        ...Object.keys(inserts),
        ...Object.keys(updates),
      ])) {
        const { results } = await db
          .prepare(
            `SELECT i.name,i.origin,i.partial,t.wr,
                  (SELECT json_group_array(name) FROM pragma_index_info(i.name)) AS columns
           FROM pragma_index_list(?) i JOIN pragma_table_list t ON t.name=?`,
          )
          .bind(table, table)
          .all<{
            name: string;
            origin: string;
            partial: number;
            wr: number;
            columns: string;
          }>();
        if (table in updates) tables[table] = (tables[table] ?? 0) + 1;
        for (const { name, origin, partial, wr, columns } of results) {
          if (wr && origin === "pk") continue; // This is the table's B-tree.
          if (partial)
            throw new Error(`Fixture needs an index predicate for ${name}`);
          const writes =
            (inserts[table] ?? 0) +
            Number(
              updates[table]?.some((column) =>
                (JSON.parse(columns) as string[]).includes(column),
              ) ?? false,
            );
          if (writes) indexes[name] = writes;
        }
      }
      return {
        tables,
        indexes,
        direct: [...Object.values(tables), ...Object.values(indexes)].reduce(
          (total, rows) => total + rows,
          0,
        ),
      };
    }
    const paper = await directWrites({
      feed_days: 1,
      papers: 1,
      paper_ids: 2,
      paper_links: 2,
      feed_items: 1,
      paper_index: 1,
    });
    const summary = await directWrites({ summaries: 1 });
    paper.tables.feed_read_counts = noFts.paper - paper.direct;
    paper.tables.paper_fts = full.paper - noFts.paper;
    summary.tables.feed_read_counts = noTldr.summary - summary.direct;
    summary.tables.papers = noFts.summary - noTldr.summary;
    summary.tables.paper_fts = full.summary - noFts.summary;
    const noWrites = { tables: {}, indexes: {} };
    return {
      paper: {
        ...checkedBreakdown(full.paper, paper),
        newFtsShadowRows: full.paperShadowRows,
      },
      summary: {
        ...checkedBreakdown(full.summary, summary),
        newFtsShadowRows: full.summaryShadowRows,
      },
      feedDay: checkedBreakdown(
        feedWrites,
        await directWrites(
          {},
          { feed_days: ["status", "counts", "crawled_at", "rev"] },
        ),
      ),
      digest: checkedBreakdown(
        digestWrites,
        await directWrites({ digests: 1 }, { feed_days: ["status", "rev"] }),
      ),
      replay: checkedBreakdown(replay, noWrites),
      vaultRefresh: checkedBreakdown(vaultRefresh.rowsWritten, noWrites),
    };
  } finally {
    await h.close();
  }
}
export async function measureWriteCosts(
  count: number,
  paperTriggers = true,
  migrations?: string[],
) {
  z.number().int().min(1).max(100000).parse(count);
  const harness = await databaseHarness("d1", migrations);
  try {
    const db = harness.db.$client as unknown as IngestDatabase;
    if (!paperTriggers)
      await db.batch(
        ["paper_fts_insert", "paper_fts_update", "feed_counts_insert"].map(
          (trigger) => db.prepare(`DROP TRIGGER ${trigger}`),
        ),
      );
    let paperRows = 0,
      summaryRows = 0,
      unchangedRowsWritten = 0,
      paperRowsRead = 0,
      summaryRowsRead = 0,
      metadataRows = 0;
    const paperWrites: Record<string, number> = {};
    for (const rows of chunks(workload(count))) {
      const cost = await sample(db, rows);
      paperRowsRead += cost.paperRowsRead;
      summaryRowsRead += cost.summaryRowsRead;
      paperRows += cost.paperRows;
      metadataRows += cost.metadataRows;
      for (const [table, writes] of Object.entries(cost.paperWrites))
        paperWrites[table] = (paperWrites[table] ?? 0) + writes;
      summaryRows += cost.summaryRows;
      unchangedRowsWritten += cost.unchanged;
    }
    return {
      backend: "local Miniflare D1",
      papers: count,
      paperRowsRead,
      summaryRowsRead,
      paperRows,
      paperWrites,
      metadataRows,
      summaryRows,
      paperRowsPerPaper: paperRows / count,
      summaryRowsPerSummary: summaryRows / count,
      unchangedRowsWritten,
      note: "Local D1 rows_read and rows_written metadata from real ingest paths, including FTS; excludes auth and quota accounting; not staging billing.",
    };
  } finally {
    await harness.close();
  }
}

/** Measures appending one real ingest batch to a populated local D1 day. */
export async function measureAppendCosts(
  existing = 1000,
  count = 40,
  through?: string,
) {
  z.number().int().min(1).max(100000).parse(existing);
  z.number().int().min(1).max(40).parse(count);
  const h = await databaseHarness("d1", migrationsThrough(through));
  try {
    const db = h.db.$client as unknown as IngestDatabase;
    const day = "2026-11-17";
    // Fixture setup is one transaction, not 25 complete ingest/summary/replay
    // cycles. Migration triggers remain enabled, so counters and FTS are real.
    await db.batch([
      db.prepare("INSERT INTO feed_days(day) VALUES (?)").bind(day),
      db
        .prepare(
          `WITH RECURSIVE sequence(i) AS (
        SELECT 0 UNION ALL SELECT i+1 FROM sequence WHERE i+1<?
      ) INSERT INTO papers(id,title,title_norm,abstract,authors,source,first_seen_on)
        SELECT printf('pap_seed_%06d',i),'Seed '||i,'seed '||i,'Seed abstract',
        '[{"name":"Synthetic Author"}]','arxiv',? FROM sequence`,
        )
        .bind(existing, day),
      db.prepare(`INSERT INTO paper_ids(paper_id,scheme,value)
        SELECT p.id,i.scheme,CASE i.scheme WHEN 'arxiv' THEN 'seed.'||p.id ELSE '10.1234/seed.'||p.id END
        FROM papers p CROSS JOIN (SELECT 'arxiv' AS scheme UNION ALL SELECT 'doi') i`),
      db.prepare(`INSERT INTO paper_links(id,paper_id,kind,url,source)
        SELECT 'lnk_'||p.id||'_'||l.kind,p.id,l.kind,'https://example.invalid/'||p.id||'/'||l.kind,'arxiv'
        FROM papers p CROSS JOIN (SELECT 'landing' AS kind UNION ALL SELECT 'pdf_arxiv') l`),
      db
        .prepare(
          `INSERT INTO paper_index(paper_id,arxiv_id,doi,day,title)
          SELECT id,'seed.'||id,'10.1234/seed.'||id,?,title FROM papers`,
        )
        .bind(day),
      db
        .prepare(
          "INSERT INTO feed_items(day,paper_id,source) SELECT ?,id,'arxiv' FROM papers",
        )
        .bind(day),
      db
        .prepare(
          `INSERT INTO summaries(paper_id,lang,kind,content,client)
        SELECT id,'en','five_part',?,'synthetic' FROM papers`,
        )
        .bind(
          JSON.stringify({
            tldr: "Seed summary",
            motivation: "M",
            method: "M",
            result: "R",
            conclusion: "C",
          }),
        ),
    ]);
    const seeded = await db
      .prepare(
        `SELECT
      (SELECT count(*) FROM papers) AS papers,
      (SELECT count(*) FROM feed_items WHERE day=?) AS feedItems,
      (SELECT count(*) FROM summaries) AS summaries`,
      )
      .bind(day)
      .first<{ papers: number; feedItems: number; summaries: number }>();
    if (!seeded || Object.values(seeded).some((n) => n !== existing))
      throw new Error("Incomplete append-cost baseline");
    const cost = await sample(db, workload(count, existing));
    return {
      existing,
      appended: count,
      seeded,
      ...cost,
      paperReadsPerPaper: cost.paperRowsRead / count,
      summaryReadsPerSummary: cost.summaryRowsRead / count,
    };
  } finally {
    await h.close();
  }
}

export { measureLegacyDay } from "./legacy-write-cost";

/** Measure pruning with the same synthetic payload sizes as the spec's storage model. */
export async function measurePruneCosts(count = 1000) {
  const full = await databaseHarness("sqlite");
  const remote = await databaseHarness("d1");
  const sqlite = full.db.$client as import("better-sqlite3").Database;
  const d1 = remote.db.$client as D1Database;
  const queries = new WeakMap<
    D1PreparedStatement,
    { sql: string; args: unknown[] }
  >();
  const statementCosts: number[][] = [];
  let tracking = false;
  const measured: IngestDatabase = {
    prepare(sql) {
      const initial = d1.prepare(sql);
      const proxy = new Proxy(initial, {
        get(target, key, receiver) {
          if (key !== "bind") return Reflect.get(target, key, receiver);
          return (...args: unknown[]) => {
            const statement = target.bind(...args);
            queries.set(statement, { sql, args });
            return statement;
          };
        },
      });
      queries.set(proxy, { sql, args: [] });
      return proxy;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      const result = await d1.batch<T>(statements);
      sqlite.transaction(() => {
        for (const statement of statements) {
          const { sql, args } = queries.get(statement)!;
          let bindIndex = 0;
          const values: unknown[] = [];
          const explicit = sql.replace(
            /\?(\d+)?/g,
            (_, position: string | undefined) => {
              const index = position ? Number(position) : bindIndex + 1;
              bindIndex = Math.max(bindIndex, index);
              values.push(args[index - 1]);
              return "?";
            },
          );
          const query = sqlite.prepare(explicit);
          if (query.reader) query.all(...values);
          else query.run(...values);
        }
      })();
      if (tracking) statementCosts.push(result.map((r) => r.meta.rows_written));
      return result;
    },
  };
  const bytes = () => {
    sqlite.exec("VACUUM");
    return (
      Number(sqlite.pragma("page_count", { simple: true })) *
      Number(sqlite.pragma("page_size", { simple: true }))
    );
  };
  const byTable = () =>
    Object.fromEntries(
      sqlite
        .prepare("SELECT name,sum(pgsize) AS bytes FROM dbstat GROUP BY name")
        .all()
        .map((row) => [
          (row as { name: string }).name,
          (row as { bytes: number }).bytes,
        ]),
    );
  try {
    const empty = bytes();
    const day = "2026-09-01",
      cutoff = "2026-10-01";
    for (const slice of chunks(workload(count))) {
      const generated = paperInputs(slice).map((p) => ({
        ...p,
        topics: ["stereo", "vision"],
      }));
      const result = await ingestPapers(measured, day, generated);
      const summaries = await ingestSummaryRecords(measured, {
        summaries: slice.map((item, i) => {
          const content = JSON.parse(item.summary);
          return {
            paperId: result.papers[i]!.paperId,
            lang: "en",
            content: {
              ...content,
              tldr: content.tldr.slice(0, -4),
              motivation: "m",
              method: "m",
              result: "r",
              conclusion: "c",
            },
          };
        }),
      });
      if (summaries.accepted !== slice.length)
        throw new Error("Incomplete summary fixture");
    }
    // Simulate M4g skipping paper_index on initial ingest, with two retained
    // identifiers and two physical links on the full record.
    await measured.batch([measured.prepare("DELETE FROM paper_index")]);
    const before = bytes(),
      fullTables = byTable();
    tracking = true;
    const { prunePage, retentionPage } = await import("../src/retention");
    let writeRows = 0;
    for (let offset = 0; offset < count; offset += 10) {
      const { rows: page } = await retentionPage(measured, cutoff, null, 10);
      const result = await prunePage(measured, cutoff, page);
      if (result.pruned !== page.length)
        throw new Error("Incomplete prune measurement");
      writeRows += result.rowsWritten;
    }
    const compactBeforeFtsMerge = bytes();
    sqlite.exec(
      "INSERT INTO paper_fts(paper_fts) VALUES ('optimize'); INSERT INTO compact_paper_fts(compact_paper_fts) VALUES ('optimize')",
    );
    const compact = bytes(),
      allArchived = byTable();
    const feedStorage = Object.entries(allArchived)
      .filter(
        ([name]) =>
          name.startsWith("feed_items") ||
          name === "sqlite_autoindex_feed_items_1",
      )
      .reduce((sum, [, size]) => sum + size, 0);
    // Storage-only deletion control. Production retains all feed rows.
    sqlite.exec("DELETE FROM feed_items");
    const withoutFeedOccurrences = bytes();
    return {
      count,
      empty,
      before,
      compactBeforeFtsMerge,
      compact,
      withoutFeedOccurrences,
      feedStorage,
      writeRows,
      first: statementCosts[0],
      rowsByStatement: statementCosts.reduce<number[]>(
        (totals, result) => result.map((n, i) => n + (totals[i] ?? 0)),
        [],
      ),
      fullTables,
      allArchived,
    };
  } finally {
    await Promise.all([full.close(), remote.close()]);
  }
}
