import { expect, it } from "vitest";
import { paperSchema } from "@litscout/pipeline/contracts/index";
import {
  ingestPapers,
  preparePaperIngest,
  legacyPaperQuote,
} from "../src/ingest-papers";
import { ingestSummaryRecords } from "../src/ingest-records";
import { readPaper, readHistory } from "../src/bounded-read";
import { databaseHarness } from "./harness";
import { searchPapers } from "../src/papers";
import { trendReferences } from "../src/trends-source";
import { readVaultPapers } from "../src/vault-reads";
import { preferredReadingLink } from "../src/link-checks";
import { readBackupPapers } from "../src/backup";
import type { IngestDatabase } from "../src/ingest-store";

const paper = paperSchema.parse({
  key: "2610.00001",
  title: "A searchable canonical title",
  source: "arxiv",
  topics: ["Robotics"],
  abstract: "An abstract",
  identifiers: [{ scheme: "arxiv", value: "2610.00001" }],
  links: [
    { kind: "landing", url: "https://arxiv.org/abs/2610.00001" },
    { kind: "pdf_arxiv", url: "https://arxiv.org/pdf/2610.00001" },
    { kind: "code", url: "https://example.invalid/repo" },
  ],
});
const day = "2026-10-30",
  nextDay = "2026-11-02";
it("omits only reproducible links and writes only missing history for an existing paper", async () => {
  const h = await databaseHarness("d1");
  const db = h.db.$client as unknown as IngestDatabase;
  try {
    const first = await ingestPapers(
      db,
      day,
      [paper],
      await preparePaperIngest(db, day, [paper], true),
    );
    const id = first.papers[0]!.paperId;
    expect((await readBackupPapers(db, [{ id }]))[0]?.paper).toMatchObject({
      derived_arxiv_links: [
        { kind: "landing", id: paper.key },
        { kind: "pdf_arxiv", id: paper.key },
      ],
    });
    expect(
      (await db.prepare("SELECT kind FROM paper_links").all()).results,
    ).toEqual([{ kind: "code" }]);
    expect((await readPaper(db, id))?.links).toEqual(
      expect.arrayContaining(
        paper.links.map((link) =>
          expect.objectContaining({ kind: link.kind, url: link.url }),
        ),
      ),
    );
    const summary = {
      day,
      legacy: true,
      summaries: [
        {
          paperId: id,
          lang: "en",
          content: {
            tldr: "Canonical TLDR",
            motivation: "M",
            method: "M",
            result: "R",
            conclusion: "C",
          },
        },
      ],
    };
    await ingestSummaryRecords(db, summary);
    const stale = {
      ...paper,
      title: "Stale title",
      topics: ["Legacy topic"],
      shortlisted: true,
    };
    const prepared = await preparePaperIngest(db, nextDay, [stale], true);
    const quote = legacyPaperQuote(prepared);
    expect(quote.papers).toEqual([
      { key: paper.key, paperId: id, summaryDays: 0, languages: ["en"] },
    ]);
    const next = await ingestPapers(db, nextDay, [stale], prepared);
    expect(next.papers[0]?.paperId).toBe(id);
    expect(next.rowsWritten).toBeLessThanOrEqual(quote.rows);
    expect(next.rowsWritten).toBeLessThan(15);
    expect((await readPaper(db, id, nextDay, false, "arxiv"))?.title).toBe(
      paper.title,
    );
    expect(
      await db.prepare("SELECT day,title FROM paper_index").first(),
    ).toBeNull();
    expect(await trendReferences(db, [id])).toMatchObject([
      { paperId: id, topics: ["Robotics"] },
    ]);
    expect(await searchPapers(h.db, "searchable")).toMatchObject([{ id }]);
    expect((await readVaultPapers(h.db, [id], "en"))[0]?.url).toBe(
      paper.links[0]?.url,
    );
    expect(await preferredReadingLink(h.db, id)).toEqual({
      kind: "pdf_arxiv",
      url: paper.links[1]?.url,
    });
    expect(
      (await readHistory(db, { from: day, to: nextDay })).items,
    ).toHaveLength(2);
    const replay = await ingestPapers(
      db,
      nextDay,
      [stale],
      await preparePaperIngest(db, nextDay, [stale], true),
    );
    expect(replay.rowsWritten).toBe(0);
    expect(
      (
        await ingestSummaryRecords(db, {
          ...summary,
          summaries: summary.summaries.map((s) => ({
            ...s,
            content: { ...s.content, tldr: "Stale TLDR" },
          })),
        })
      ).rowsWritten,
    ).toBe(0);
    expect((await readPaper(db, id))?.summaries[0]?.content.tldr).toBe(
      "Canonical TLDR",
    );
  } finally {
    await h.close();
  }
}, 60_000);

it("reuses a retained ID and only adds missing links or aliases to an existing full paper", async () => {
  const h = await databaseHarness("d1");
  const db = h.db.$client as unknown as IngestDatabase;
  try {
    await db
      .prepare(
        "INSERT INTO paper_index(paper_id,arxiv_id,day,title,title_norm) VALUES ('pap_retained',?,?,?,?)",
      )
      .bind(paper.key, day, paper.title, "searchable")
      .run();
    const rehydrate = await preparePaperIngest(db, day, [paper], true);
    const restored = await ingestPapers(db, day, [paper], rehydrate);
    expect(restored.papers).toEqual([
      { key: paper.key, paperId: "pap_retained" },
    ]);
    expect(restored.rowsWritten).toBeLessThanOrEqual(
      legacyPaperQuote(rehydrate).rows,
    );
    const updated = paperSchema.parse({
      ...paper,
      title: "Stale copy",
      identifiers: [
        ...paper.identifiers,
        { scheme: "doi", value: "10.1234/fixture" },
      ],
      links: [
        ...paper.links,
        { kind: "pdf_oa", url: "https://example.invalid/custom.pdf" },
      ],
    });
    const plan = await preparePaperIngest(db, day, [updated], true);
    const result = await ingestPapers(db, day, [updated], plan);
    expect(result.rowsWritten).toBe(5);
    const current = await readPaper(db, "doi:10.1234/fixture");
    expect(current).toMatchObject({
      paperId: "pap_retained",
      title: paper.title,
      links: expect.arrayContaining([
        expect.objectContaining({ kind: "pdf_oa" }),
      ]),
    });
    expect(
      legacyPaperQuote(await preparePaperIngest(db, day, [updated], true)).rows,
    ).toBe(0);
    const doi = { scheme: "doi", value: "10.1234/native" };
    const native = await ingestPapers(db, day, [
      { ...paper, identifiers: [doi], links: [] },
    ]);
    const keep = native.papers[0]!.paperId;
    await db
      .prepare("UPDATE papers SET created_at='2025-01-01' WHERE id=?")
      .bind(keep)
      .run();
    const bridge = await ingestPapers(db, day, [
      { ...paper, identifiers: [...paper.identifiers, doi], links: [] },
    ]);
    expect(bridge.papers[0]?.paperId).toBe(keep);
    expect((await readPaper(db, keep))?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pdf_arxiv",
          url: paper.links[1]!.url,
        }),
      ]),
    );
  } finally {
    await h.close();
  }
}, 60_000);

it("rejects a stale legacy restore quote when another writer adds history", async () => {
  const h = await databaseHarness("d1");
  const db = h.db.$client as unknown as IngestDatabase;
  try {
    const archived = "pap_stale_quote";
    await db
      .prepare(
        "INSERT INTO paper_index(paper_id,arxiv_id,day,title,venue) VALUES (?,?,?,'Archived title','Archived venue')",
      )
      .bind(archived, paper.identifiers[0]!.value, day)
      .run();
    const plan = await preparePaperIngest(db, nextDay, [paper], true);
    expect(legacyPaperQuote(plan).papers[0]?.paperId).toBe(archived);
    await db.batch([
      db.prepare("INSERT INTO feed_days(day) VALUES (?)").bind(day),
      db
        .prepare(
          "INSERT INTO feed_items(day,paper_id,source) VALUES (?,?,'arxiv')",
        )
        .bind(day, archived),
    ]);
    await expect(ingestPapers(db, nextDay, [paper], plan)).rejects.toThrow(
      /changed/,
    );
    expect(
      await db
        .prepare("SELECT has_canonical FROM paper_index WHERE paper_id=?")
        .bind(archived)
        .first("has_canonical"),
    ).toBe(0);
  } finally {
    await h.close();
  }
});

it("replans when a canonical paper was compacted between the legacy quote and write", async () => {
  const { prunePage, retentionPage } = await import("../src/retention");
  const h = await databaseHarness("d1");
  const db = h.db.$client as unknown as IngestDatabase;
  try {
    const result = await ingestPapers(db, day, [paper]);
    const id = result.papers[0]!.paperId;
    const plan = await preparePaperIngest(db, nextDay, [paper], true);
    const cutoff = "2026-11-02";
    const { rows } = await retentionPage(db, cutoff, null);
    expect((await prunePage(db, cutoff, rows)).pruned).toBe(1);
    await expect(ingestPapers(db, nextDay, [paper], plan)).rejects.toThrow(
      /changed/,
    );
    const retry = await preparePaperIngest(db, nextDay, [paper], true);
    await ingestPapers(db, nextDay, [paper], retry);
    expect(await readPaper(db, id)).toMatchObject({
      paperId: id,
      abstract: paper.abstract,
    });
  } finally {
    await h.close();
  }
});
