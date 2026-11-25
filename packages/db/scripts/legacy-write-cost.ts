import { chunks } from "@litscout/pipeline/api";
import { storedLegacyLinks } from "@litscout/pipeline/legacy-links";
import { plannedWriteRows } from "@litscout/pipeline/ingest-batching";
import {
  paperSchema,
  type PaperInput,
} from "@litscout/pipeline/contracts/index";
import { databaseHarness, migrationFiles } from "../test/harness";
import { ingestDigest, ingestFeedDay, ingestLegacy } from "../src/ingest";
import {
  ingestPapers,
  legacyPaperQuote,
  preparePaperIngest,
} from "../src/ingest-papers";
import { ingestSummaryRecords } from "../src/ingest-records";
import type { IngestDatabase } from "../src/ingest-store";
import { fixture, textGenerator } from "./size-model";

const day = "2026-10-30";
function workload(count: number) {
  const text = textGenerator();
  return Array.from({ length: count }, (_, index) => {
    const data = fixture(index, text);
    const venue = index % 50 === 49;
    const key = venue ? `doi:${data.doi}` : data.arxiv;
    const paper = paperSchema.parse({
      key,
      title: data.title,
      abstract: data.abstract,
      authors: ["Synthetic Author"],
      source: venue ? "crossref" : "arxiv",
      venue: venue ? "Synthetic Journal" : null,
      venueKind: venue ? "journal" : "preprint",
      identifiers: [
        { scheme: venue ? "doi" : "arxiv", value: venue ? data.doi : key },
      ],
      links: [
        {
          kind: "landing",
          url: venue
            ? `https://doi.org/${data.doi}`
            : `https://arxiv.org/abs/${key}`,
        },
        ...(!venue
          ? [{ kind: "pdf_arxiv", url: `https://arxiv.org/pdf/${key}` }]
          : []),
        ...(index % 50 === 0
          ? [{ kind: "code", url: `https://example.invalid/code/${key}` }]
          : []),
      ],
    });
    return {
      paper,
      content: {
        tldr: String(JSON.parse(data.summary).tldr),
        motivation: "M",
        method: "M",
        result: "R",
        conclusion: "C",
      },
    };
  });
}

async function breakdown(
  db: IngestDatabase,
  tables: Record<string, number>,
  feedDayUpdates: number,
) {
  const indexes: Record<string, number> = {};
  for (const [table, inserts] of Object.entries(tables)) {
    const { results } = await db
      .prepare(
        `SELECT i.name,i.origin,t.wr
      FROM pragma_index_list(?) i JOIN pragma_table_list t ON t.name=?`,
      )
      .bind(table, table)
      .all<{
        name: string;
        origin: string;
        wr: number;
      }>();
    for (const { name, origin, wr } of results) {
      if (wr && origin === "pk") continue;
      indexes[name] = inserts;
    }
  }
  // D1 charges only the status index for feed-day updates and no indexes for
  // an existing cursor's value change or the summary trigger's TL;DR update.
  indexes.feed_days_lookup_0 =
    (indexes.feed_days_lookup_0 ?? 0) + feedDayUpdates;
  tables.feed_days = (tables.feed_days ?? 0) + feedDayUpdates;
  return { tables, indexes };
}

export async function measureLegacyDay(
  count = 1000,
  mode: "before" | "after" = "before",
) {
  const legacy = mode === "after";
  const h = await databaseHarness(
    "d1",
    legacy ? migrationFiles : migrationFiles.filter((f) => f < "0022"),
  );
  const db = h.db.$client as unknown as IngestDatabase;
  try {
    const input = workload(count);
    const papers = input.map((row) => row.paper);
    const ids = new Map<string, string>();
    const phases = {
      papers: 0,
      summaries: 0,
      feedDay: 0,
      digest: 0,
      checkpoint: 0,
      run: 0,
    };
    const checkpoint = async (offset: number) => {
      phases.checkpoint += await ingestLegacy(db, {
        cursors: [
          {
            name: "legacy:" + "1".repeat(32),
            value: JSON.stringify({ offset }),
          },
        ],
      });
    };
    let offset = 0,
      admissionRows = 0;
    for (const group of chunks(papers)) {
      for (const batch of chunks(group, 20)) {
        const plan = await preparePaperIngest(db, day, batch, legacy);
        const result = await ingestPapers(db, day, batch, plan);
        if (legacy)
          admissionRows += plannedWriteRows(
            "/ingest/papers",
            {
              day,
              papers: batch,
              legacy: "import",
              maxRows: legacyPaperQuote(plan).rows,
            },
            undefined,
            "batched",
          );
        phases.papers += result.rowsWritten;
        result.papers.forEach(({ key, paperId }) => ids.set(key, paperId));
      }
      if (!legacy) await checkpoint(++offset);
    }
    for (const group of chunks(input)) {
      for (const batch of chunks(group, 25)) {
        const summaries = batch.map(({ paper, content }) => ({
          paperId: ids.get(paper.key),
          content,
          lang: "en",
          client: "legacy",
        }));
        const payload = {
          day,
          summaries,
          ...(legacy
            ? { legacy: true as const, maxRows: 6 * summaries.length }
            : {}),
        };
        phases.summaries += (
          await ingestSummaryRecords(db, payload)
        ).rowsWritten;
        if (legacy)
          admissionRows += plannedWriteRows(
            "/ingest/summaries",
            payload,
            undefined,
            "batched",
          );
      }
      if (!legacy) await checkpoint(++offset);
    }
    phases.feedDay = await ingestFeedDay(db, {
      day,
      status: "summarised",
      counts: { arxiv: count },
    });
    if (!legacy) {
      await checkpoint(++offset);
      await checkpoint(++offset); // Resolve identities before importing optional reports.
    }
    phases.digest = await ingestDigest(db, {
      day,
      bodyMd: "# Legacy daily digest",
      picks: [...ids.values()].slice(0, 3),
      final: true,
    });
    if (!legacy) await checkpoint(++offset);
    const runs = [
      {
        id: "run_legacy_cost",
        day,
        kind: "legacy_import",
        status: "done",
        startedAt: `${day}T01:00:00Z`,
      },
    ];
    if (legacy) {
      const records = {
        runs,
        cursors: [
          {
            name: "legacy:" + "1".repeat(32),
            value: '{"version":2,"offset":1}',
          },
        ],
      };
      // The completion run and cursor share one transaction. The cursor uses
      // its table row and its primary-key index entry on the fresh database.
      phases.run = 4;
      phases.checkpoint = (await ingestLegacy(db, records)) - phases.run;
      admissionRows +=
        plannedWriteRows("/ingest/feed-day", {}, undefined, "batched") +
        plannedWriteRows(
          `/digests/${day}`,
          { final: true },
          undefined,
          "batched",
        ) +
        plannedWriteRows("/ingest/legacy", records, undefined, "batched");
    } else {
      phases.run = await ingestLegacy(db, { runs });
      await checkpoint(++offset);
    }
    const n = papers.length;
    const venueCounters = papers.filter(
      (paper: PaperInput) => paper.venue,
    ).length;
    const { tables, indexes } = await breakdown(
      db,
      {
        feed_days: 1,
        papers: n,
        paper_ids: n,
        paper_links: papers.reduce(
          (sum, paper) =>
            sum + (legacy ? storedLegacyLinks(paper) : paper.links).length,
          0,
        ),
        feed_items: n,
        paper_index: legacy ? 0 : n,
        summaries: n,
        digests: 1,
        sync_cursors: 1,
        runs: 1,
      },
      2,
    );
    tables.sync_cursors =
      phases.checkpoint - (indexes.sqlite_autoindex_sync_cursors_1 ?? 0);
    tables.feed_read_counts = 3 * n + venueCounters;
    tables.papers! += n; // First TL;DR materialisation.
    tables.paper_fts = 3 * n;
    const rowsWritten = Object.values(phases).reduce(
      (sum, value) => sum + value,
      0,
    );
    const attributed = [
      ...Object.values(tables),
      ...Object.values(indexes),
    ].reduce((sum, value) => sum + value, 0);
    if (rowsWritten !== attributed)
      throw new Error(
        `Attributed ${attributed} of ${rowsWritten} writes: ${JSON.stringify({ phases, tables, indexes })}`,
      );
    return {
      rowsWritten,
      ...(legacy ? { admissionRows } : {}),
      phases,
      tables,
      indexes,
    };
  } finally {
    await h.close();
  }
}
