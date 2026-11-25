import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { readDayPage } from "@litscout/db/bounded-read";
import { app } from "../src/app";
import { registerLibraryTools } from "../src/mcp-library";
import { workerEnv } from "./helpers/worker-env";

const day = "2026-11-23";
const papers = [
  ["pap_arxiv", null, "preprint"],
  ["pap_iclr", "ICLR", "conference"],
  ["pap_tpami", "IEEE TPAMI", "journal"],
  ["pap_other", "Some Journal", "journal"],
] as const;
let db: D1Database, close: () => Promise<void>;
let env: ReturnType<typeof workerEnv>["env"];
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  db = h.db.$client as unknown as D1Database;
  env = {
    ...workerEnv().env,
    DB: db,
    LOCAL_DEV: "true",
    INSTANCE_CONFIG: JSON.stringify({ topVenues: ["ICLR", "IEEE TPAMI"] }),
  };
  await db
    .prepare("INSERT INTO feed_days(day,status) VALUES (?,'digested')")
    .bind(day)
    .run();
  await db.batch(
    papers.flatMap(([id, venue, kind], rank) => [
      db
        .prepare(
          "INSERT INTO papers(id,title,title_norm,authors,source,venue,venue_kind) VALUES (?,?,?,'[]',?,?,?)",
        )
        .bind(
          id,
          `Stereo ${id}`,
          `stereo ${id}`,
          venue ? "openalex" : "arxiv",
          venue,
          kind,
        ),
      db
        .prepare(
          "INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted) VALUES (?,?,?,?,'[\"Vision\"]',1)",
        )
        .bind(day, id, venue ? "openalex" : "arxiv", rank),
      db
        .prepare(
          "INSERT INTO library_items(paper_id,added_via,added_at) VALUES (?,'web',?)",
        )
        .bind(id, `2026-11-1${rank}T00:00:00.000Z`),
    ]),
  );
  await db
    .prepare(
      "INSERT INTO alphaxiv_items(alphaxiv_id,paper_type,title,synced_at) VALUES ('draft_1','private','Stereo private draft','2026-11-19T00:00:00.000Z')",
    )
    .run();
});
afterAll(async () => close?.());

const ids = (page: { items: unknown[] }) =>
  page.items.map((item) => (item as { paperId: string }).paperId).sort();

it("filters a day by venue type", async () => {
  expect(ids(await readDayPage(db, day, { kind: "conference" }))).toEqual([
    "pap_iclr",
  ]);
  expect(ids(await readDayPage(db, day, { kind: "journal" }))).toEqual([
    "pap_other",
    "pap_tpami",
  ]);
  expect(ids(await readDayPage(db, day, { kind: "preprint" }))).toEqual([
    "pap_arxiv",
  ]);
});

it("keeps only the instance's top venues, and none without a list", async () => {
  const top = ["ICLR", "IEEE TPAMI"];
  expect(
    ids(await readDayPage(db, day, { top: "true" }, false, false, false, top)),
  ).toEqual(["pap_iclr", "pap_tpami"]);
  expect(
    ids(
      await readDayPage(
        db,
        day,
        { top: "true", kind: "journal" },
        false,
        false,
        false,
        top,
      ),
    ),
  ).toEqual(["pap_tpami"]);
  expect(ids(await readDayPage(db, day, { top: "true" }))).toEqual([]);
});

it("rejects an unknown venue type", async () => {
  await expect(readDayPage(db, day, { kind: "workshop" })).rejects.toThrow();
});

const get = async (path: string, status = 200) => {
  const response = await app.request("/api/v1" + path, {}, env);
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as {
    data: { items: { paperId?: string; title: string; venue?: unknown }[] };
  };
};
const keys = (items: { paperId?: string; title: string }[]) =>
  items.map((item) => item.paperId ?? item.title).sort();

it("filters the Library by type and the instance's top venues", async () => {
  expect(
    keys((await get("/library?kind=journal&top=true")).data.items),
  ).toEqual(["pap_tpami"]);
  expect(keys((await get("/library?top=true")).data.items)).toEqual([
    "pap_iclr",
    "pap_tpami",
  ]);
  // A private upload has no type: like a day's paper, it counts as a preprint.
  expect(keys((await get("/library?kind=preprint")).data.items)).toEqual([
    "Stereo private draft",
    "pap_arxiv",
  ]);
  await get("/library?kind=workshop", 400);
});

it("gives MCP search_library the same type and top venue filters", async () => {
  const registerTool = vi.fn();
  registerLibraryTools({ registerTool } as never, env, {
    read: true,
    write: false,
    identity: "test",
  });
  const search = registerTool.mock.calls.find(
    ([name]) => name === "search_library",
  )![2];
  const result = async (args: unknown) =>
    JSON.parse((await search(args)).content[0].text).result.items;
  expect(keys(await result({ kind: "journal", top: true }))).toEqual([
    "pap_tpami",
  ]);
  expect(keys(await result({ kind: "conference" }))).toEqual(["pap_iclr"]);
});

it("filters the every-day search the same way, and each hit names its venue", async () => {
  const found = await get("/search?q=stereo&kind=journal&top=true");
  expect(found.data.items).toMatchObject([
    { paperId: "pap_tpami", venue: "IEEE TPAMI", day },
  ]);
  expect(keys((await get("/search?q=stereo&top=true")).data.items)).toEqual([
    "pap_iclr",
    "pap_tpami",
  ]);
  const all = (await get("/search?q=stereo")).data.items;
  expect(all).toHaveLength(4);
  expect(all.find((hit) => hit.paperId === "pap_arxiv")?.venue).toBeNull();
  await get("/search?q=stereo&kind=workshop", 400);
});
