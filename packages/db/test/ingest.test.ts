import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { databaseHarness } from "./harness";
import type { Database } from "../src/database";
import {
  ingestPapers,
  PaperMergeConflict,
  preparePaperIngest,
} from "../src/ingest-papers";
import {
  ingestSummaries,
  ingestFeedDay,
  ingestRadar,
  ingestDigest,
  ingestLegacy,
} from "../src/ingest";
import {
  readFeedDay,
  readPaper,
  readDigest,
  readOperations,
} from "../src/feed-read";
import {
  upsertStatement,
  writeBatch,
  type IngestDatabase,
} from "../src/ingest-store";
import { paperSchema } from "@litscout/pipeline/contracts/index";
import { readHistory } from "../src/bounded-read";
import { fromFeedItem } from "@litscout/pipeline/daily";
import { paperReservation } from "@litscout/pipeline/write-reservation";
let db: Database, close: () => Promise<void>, client: IngestDatabase;
beforeAll(async () => {
  ({ db, close } = await databaseHarness("d1"));
  client = db.$client as unknown as IngestDatabase;
});
afterAll(async () => {
  await close?.();
});
const day = "2026-11-17",
  input = paperSchema.parse({
    key: "2611.00001",
    title: "Depth stereo",
    authors: ["Ada"],
    source: "arxiv",
    abstract: "A long abstract",
    identifiers: [
      { scheme: "arxiv", value: "2611.00001v2" },
      { scheme: "doi", value: "https://doi.org/10.1234/A" },
    ],
    links: [
      { kind: "landing", url: "https://example.org/paper" },
      { kind: "code", url: "https://github.com/example/code" },
    ],
    categories: ["cs.CV"],
    topics: ["Vision"],
    shortlisted: true,
  });
let id: string;
it("uses two D1 batches for identity+atomic paper writes and zero duplicate row writes", async () => {
  const first = await ingestPapers(client, day, [input]);
  id = first.papers[0]!.paperId;
  expect(first.rowsWritten).toBeGreaterThan(0);
  expect((await ingestPapers(client, day, [input])).rowsWritten).toBe(0);
  expect(
    (
      await ingestPapers(client, day, [
        {
          ...input,
          key: "second",
          title: "New title",
          abstract: null,
          authors: [],
        },
      ])
    ).papers[0]!.paperId,
  ).toBe(id);
  expect(
    (
      await ingestPapers(client, day, [input, { ...input, key: "duplicate" }])
    ).papers.map((p) => p.paperId),
  ).toEqual([id, id]);
  expect((await ingestPapers(client, day, [])).papers).toEqual([]);
});
it("reads joined paper metadata and all filters; handles unknown days", async () => {
  const feed = await readFeedDay(client, day, {
    topic: "Vision",
    source: "arxiv",
    shortlisted: true,
  });
  expect(feed.items[0]?.identifiers).toContainEqual({
    scheme: "doi",
    value: "10.1234/a",
  });
  expect((await readPaper(client, id))?.links).toHaveLength(2);
  expect((await readFeedDay(client, day, { topic: "nothing" })).items).toEqual(
    [],
  );
  expect(
    (await readFeedDay(client, day, { shortlisted: false })).items,
  ).toEqual([]);
  expect((await readFeedDay(client, "2026-11-01")).status).toBe("pending");
});
it("summaries, statuses, radar and digests are conditional and keep terminal status", async () => {
  const content = {
    tldr: "One",
    motivation: "Two",
    method: "Three",
    result: "Four",
    conclusion: "Five",
  };
  const summaries = { summaries: [{ paperId: id, content }] };
  expect(await ingestSummaries(client, summaries)).toBeGreaterThan(0);
  expect(await ingestSummaries(client, summaries)).toBe(0);
  const feed = {
    day,
    status: "summarised",
    counts: { arxiv: 1 },
    crawledAt: "2026-11-17T01:00:00Z",
  };
  expect(await ingestFeedDay(client, feed)).toBeGreaterThan(0);
  expect(await ingestFeedDay(client, feed)).toBe(0);
  const digest = { day, bodyMd: "# Daily", picks: [id], final: true };
  expect(await ingestDigest(client, digest)).toBeGreaterThan(0);
  expect(await ingestDigest(client, digest)).toBe(0);
  expect(await readDigest(client, day, "en", "daily")).toMatchObject({
    bodyMd: "# Daily",
  });
  expect(await readDigest(client, "2026-11-01", "en", "daily")).toBeNull();
  const radar = {
    radar: [{ day, paperId: id, level: "borrow", reason: "Reusable" }],
  };
  expect(await ingestRadar(client, radar)).toBeGreaterThan(0);
  expect(await ingestRadar(client, radar)).toBe(0);
  expect((await readFeedDay(client, day)).status).toBe("final");
  await ingestFeedDay(client, { day, status: "pending" });
  expect((await readFeedDay(client, day)).status).toBe("final");
});
it("ingests and reads every legacy metadata type idempotently", async () => {
  const v = {
    cursors: [{ name: "venue-feed", value: '{"since":"2026-11-17"}' }],
    runs: [
      {
        id: "run_test",
        kind: "crawl",
        day,
        status: "done",
        startedAt: "2026-11-17T01:00:00Z",
      },
    ],
    missed: [
      {
        id: "miss_test",
        paperId: id,
        foundOn: day,
        where: "Sunday",
        note: "medium",
      },
    ],
    ratings: [
      {
        id: "evt_test",
        paperId: id,
        day,
        kind: "rate_up",
        source: "legacy",
        at: "2026-11-17T01:00:00Z",
      },
    ],
  };
  expect(await ingestLegacy(client, v)).toBeGreaterThan(0);
  expect(await ingestLegacy(client, v)).toBe(0);
  const ops = await readOperations(client, day, day);
  for (const key of ["runs", "ratings", "radar", "missed"])
    expect(ops[key]).toHaveLength(1);
  expect(await writeBatch(client, [])).toBe(0);
  expect(() => upsertStatement(client, "bad;drop", [], {})).toThrow();
});
it("merges linked identities and transfers references in the same batch", async () => {
  await ingestPapers(client, day, [
    { ...input, identifiers: [{ scheme: "doi", value: "10.1234/other" }] },
  ]);
  await ingestPapers(client, day, [
    {
      ...input,
      identifiers: [
        { scheme: "arxiv", value: "2611.00001" },
        { scheme: "doi", value: "10.1234/other" },
      ],
    },
  ]);
  expect((await db.all(sql`SELECT id FROM papers`)).length).toBe(1);
});

it("rolls back an identity merge if new child writes would exceed its reservation", async () => {
  const mergeDay = "2026-11-03";
  const a = { scheme: "doi", value: "10.1234/merge-race-a" };
  const b = { scheme: "doi", value: "10.1234/merge-race-b" };
  await client.batch([
    client.prepare(`INSERT INTO papers(id,title,title_norm,created_at) VALUES
      ('pap_merge_race_a','Merge A','merge a','2020-01-01'),
      ('pap_merge_race_b','Merge B','merge b','2020-01-02')`),
    client
      .prepare(
        "INSERT INTO paper_ids VALUES ('pap_merge_race_a','doi',?),('pap_merge_race_b','doi',?)",
      )
      .bind(a.value, b.value),
  ]);
  const records = [{ ...input, key: "merge-race", identifiers: [a, b] }];
  const plan = await preparePaperIngest(client, mergeDay, records);
  await client
    .prepare(
      `INSERT INTO paper_links(id,paper_id,kind,url)
    VALUES ('lnk_merge_race','pap_merge_race_b','landing','https://example.org')`,
    )
    .run();
  await expect(
    ingestPapers(client, mergeDay, records, plan),
  ).rejects.toBeInstanceOf(PaperMergeConflict);
  expect(
    await client
      .prepare("SELECT paper_id FROM paper_links WHERE id='lnk_merge_race'")
      .first("paper_id"),
  ).toBe("pap_merge_race_b");
  expect((await ingestPapers(client, mergeDay, records)).papers).toEqual([
    { key: "merge-race", paperId: "pap_merge_race_a" },
  ]);
});

it("the next ingest replaces persisted topics and shortlist flags and counts reflect them", async () => {
  await ingestPapers(client, day, [
    { ...input, topics: ["New config"], shortlisted: false },
  ]);
  const feed = await readFeedDay(client, day, {
    topic: "New config",
    shortlisted: false,
  });
  expect(feed.items.map((p) => p.paperId)).toContain(id);
  expect(feed.counts.topics["New config"]).toBe(1);
  expect((await readFeedDay(client, day, { topic: "Vision" })).items).toEqual(
    [],
  );
});
it("R12 keeps history authors slim and preserves full authors and links on metadata updates", async () => {
  const authors = Array.from({ length: 9 }, (_, i) => `Author ${i}`);
  const result = await ingestPapers(client, day, [
    {
      ...input,
      key: "history-authors",
      identifiers: [{ scheme: "doi", value: "10.1234/history-authors" }],
      authors,
    },
  ]);
  const paperId = result.papers[0]!.paperId;
  const history = (
    await readHistory(client, { from: day, to: day })
  ).items.find((p) => p.paperId === paperId)!;
  expect(history.authors).toHaveLength(4);
  await ingestPapers(client, day, [
    { ...fromFeedItem(history), hfUpvotes: 42 },
  ]);
  const full = await readPaper(client, paperId);
  expect(full?.authors.map((a) => a.name)).toEqual(authors);
  expect(full?.links).toHaveLength(2);
  expect(full?.abstract).toBe(input.abstract);
});
it("R11 reserves the writes for all topic counters, including fifty topics", async () => {
  const paper = {
    ...input,
    key: "topic-counters",
    identifiers: [{ scheme: "doi", value: "10.1234/topic-counters" }],
    topics: Array.from({ length: 50 }, (_, i) => `Topic ${i}`),
  };
  const result = await ingestPapers(client, day, [paper]);
  expect(result.rowsWritten).toBeLessThanOrEqual(paperReservation(paper) + 2);
});

it("a weekly report leaves its day's status alone", async () => {
  const sunday = "2026-11-22";
  await ingestFeedDay(client, {
    day: sunday,
    status: "empty",
    counts: {},
    crawledAt: "2026-11-22T13:45:00Z",
  });
  const weekly = {
    day: sunday,
    kind: "weekly",
    bodyMd: "# Weekly",
    picks: [],
    final: false,
  };
  expect(await ingestDigest(client, weekly)).toBeGreaterThan(0);
  expect(await readDigest(client, sunday, "en", "weekly")).toMatchObject({
    bodyMd: "# Weekly",
  });
  expect((await readFeedDay(client, sunday)).status).toBe("empty");
});
