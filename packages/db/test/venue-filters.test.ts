import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "./harness";
import type { Database } from "../src/database";
import { listLibrary } from "../src/library";
import { searchListedPapers } from "../src/bounded-read";

// The day pages' Type and Top venues filters, in the Library and the search:
// a paper with no venue type counts as a preprint, and Top venues keeps the
// instance's top venues only (none when it lists none).
const top = ["ICLR", "IEEE TPAMI"];
const papers = [
  ["pap_arxiv", null, null],
  ["pap_iclr", "ICLR", "conference"],
  ["pap_tpami", "IEEE TPAMI", "journal"],
  ["pap_other", "Some Journal", "journal"],
] as const;
let db: Database, client: D1Database, close: () => Promise<void>;
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  db = h.db;
  client = h.db.$client as unknown as D1Database;
  await client.batch([
    ...papers.flatMap(([id, venue, kind], i) => [
      client
        .prepare(
          "INSERT INTO papers(id,title,title_norm,authors,venue,venue_kind) VALUES (?,?,?,'[]',?,?)",
        )
        .bind(id, `Stereo ${id}`, `stereo ${id}`, venue, kind),
      client
        .prepare(
          "INSERT INTO library_items(paper_id,added_via,added_at) VALUES (?,'web',?)",
        )
        .bind(id, `2026-11-1${i}T00:00:00.000Z`),
    ]),
    // A private alphaXiv upload: a title and a link, no venue or type.
    client.prepare(
      "INSERT INTO alphaxiv_items(alphaxiv_id,paper_type,title,synced_at) VALUES ('draft_1','private','Stereo private draft','2026-11-19T00:00:00.000Z')",
    ),
  ]);
});
afterAll(async () => close?.());

const library = async (query: Record<string, unknown>, venues = top) =>
  (await listLibrary(db, query, venues)).items
    .map((item) => ("paperId" in item ? item.paperId : item.title))
    .sort();
const search = async (
  filters: { kind?: "preprint" | "conference" | "journal"; top?: boolean },
  venues = top,
) =>
  (await searchListedPapers(client, "stereo", 12, filters, venues)).items
    .map((hit) => hit.paperId)
    .sort();

it("filters the Library by venue type; rows without one count as preprints", async () => {
  expect(await library({ kind: "journal" })).toEqual([
    "pap_other",
    "pap_tpami",
  ]);
  expect(await library({ kind: "conference" })).toEqual(["pap_iclr"]);
  expect(await library({ kind: "preprint" })).toEqual([
    "Stereo private draft",
    "pap_arxiv",
  ]);
  await expect(listLibrary(db, { kind: "workshop" })).rejects.toThrow();
});

it("keeps the Library's top venues only, never a private upload, and none without a list", async () => {
  expect(await library({ top: "true" })).toEqual(["pap_iclr", "pap_tpami"]);
  expect(await library({ top: true, kind: "journal" })).toEqual(["pap_tpami"]);
  expect(await library({ top: "true" }, [])).toEqual([]);
  expect(await library({ top: "false" })).toHaveLength(5);
  // The type stays out of the row: the Library rows are unchanged.
  const row = (await listLibrary(db, { kind: "journal" }, top)).items[0];
  expect(row).not.toHaveProperty("venueKind");
});

it("filters the search by venue type and top venues, and gives each hit its venue", async () => {
  expect(await search({ kind: "journal" })).toEqual(["pap_other", "pap_tpami"]);
  expect(await search({ kind: "preprint" })).toEqual(["pap_arxiv"]);
  expect(await search({ top: true })).toEqual(["pap_iclr", "pap_tpami"]);
  expect(await search({ top: true, kind: "conference" })).toEqual(["pap_iclr"]);
  expect(await search({ top: true }, [])).toEqual([]);
  const hits = (await searchListedPapers(client, "stereo")).items;
  expect(hits).toHaveLength(4);
  expect(
    Object.fromEntries(hits.map((hit) => [hit.paperId, hit.venue])),
  ).toEqual({
    pap_arxiv: null,
    pap_iclr: "ICLR",
    pap_tpami: "IEEE TPAMI",
    pap_other: "Some Journal",
  });
});
