import { readFileSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import { databaseHarness } from "./harness";
import { ingestPapers } from "../src/ingest-papers";
import {
  ingestSummaryRecords,
  ingestRadarRecords,
  ingestLegacyRecords,
} from "../src/ingest-records";
import type { IngestDatabase } from "../src/ingest-store";
let db: IngestDatabase, close: () => Promise<void>, paperId: string;
beforeAll(async () => {
  const h = await databaseHarness("d1");
  db = h.db.$client as unknown as IngestDatabase;
  close = h.close;
});
afterAll(async () => {
  await close();
});
const raw = readFileSync(
  "packages/sync/test/fixtures/round3/data/2026-11-11.jsonl",
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((row) => row.id === "doi:10.46298/lmcs-22(4:18)2026");
it("T3 repository paper batches retain valid real records and report invalid ones", async () => {
  const good = {
    key: raw.id,
    title: raw.title,
    source: raw.source,
    authors: raw.authors,
    identifiers: [{ scheme: "doi", value: raw.doi }],
    links: [{ kind: "landing", url: raw.url }],
  };
  const result = await ingestPapers(db, "2026-11-17", [
    { ...good, key: "broken", title: "" },
    good,
  ]);
  paperId = result.papers[0]!.paperId;
  expect(result).toMatchObject({
    accepted: 1,
    skipped: 1,
    invalid: [{ day: "2026-11-17", id: "broken", field: "title" }],
  });
  expect(await ingestPapers(db, "2026-11-17", [null])).toMatchObject({
    accepted: 0,
    skipped: 1,
    rowsWritten: 0,
  });
});
it("T3 summary and radar batches check references individually", async () => {
  const summary = {
    paperId,
    content: {
      tldr: "One",
      motivation: "Two",
      method: "Three",
      result: "Four",
      conclusion: "Five",
    },
  };
  expect(
    await ingestSummaryRecords(db, {
      day: "2026-11-17",
      summaries: [
        summary,
        { ...summary, paperId: "pap_missing" },
        { paperId: "pap_bad" },
      ],
    }),
  ).toMatchObject({ accepted: 1, skipped: 2 });
  expect(await ingestSummaryRecords(db, { summaries: [null] })).toMatchObject({
    accepted: 0,
    skipped: 1,
  });
  await db
    .prepare(
      "INSERT INTO projects(id,slug,title,status,summary,updated_at) VALUES ('proj_fixture','fixture','Fixture','active','Fixture project','2026-11-17T00:00:00Z')",
    )
    .run();
  const radar = {
    day: "2026-11-17",
    paperId,
    level: "borrow",
    reason: "Useful",
  };
  expect(
    await ingestRadarRecords(db, {
      radar: [
        radar,
        { ...radar, projectId: "proj_fixture" },
        { ...radar, projectId: "missing" },
      ],
    }),
  ).toMatchObject({
    accepted: 2,
    skipped: 1,
    invalid: [{ field: "projectId" }],
  });
});
it("T3 operational batches reject private/invalid rows and preserve valid records", async () => {
  const result = await ingestLegacyRecords(db, {
    cursors: [
      {
        name: "arxiv-listing",
        value: '{"listingDate":"2026-11-16","runDay":"2026-11-17"}',
      },
      { name: "venue-feed", value: '{"private":"do not store"}' },
    ],
    runs: [
      {
        id: "run_fixture",
        kind: "crawl",
        day: "2026-11-17",
        status: "done",
        startedAt: "2026-11-17T00:00:00Z",
      },
    ],
    missed: [
      { id: "miss_fixture", paperId, foundOn: "2026-11-17", where: "fixture" },
    ],
    ratings: [
      {
        id: "evt_fixture",
        paperId,
        day: "2026-11-17",
        kind: "rate_up",
        source: "fixture",
        at: "2026-11-17T00:00:00Z",
      },
    ],
  });
  expect(result).toMatchObject({
    accepted: 4,
    skipped: 1,
    invalid: [{ id: "venue-feed", field: "value" }],
  });
});
