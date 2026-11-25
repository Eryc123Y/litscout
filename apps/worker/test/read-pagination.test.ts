import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";
const day = "2026-11-16";
let db: D1Database, close: () => Promise<void>;
let env: ReturnType<typeof workerEnv>["env"];
const content = {
  tldr: "Short lead",
  motivation: "FULL_MOTIVATION",
  method: "M",
  result: "R",
  conclusion: "C",
};
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  db = h.db.$client as unknown as D1Database;
  env = { ...workerEnv().env, DB: db, LOCAL_DEV: "true", PUBLIC_FEED: "true" };
  await db
    .prepare(
      "INSERT INTO feed_days(day,status,counts) VALUES (?,'crawled','{\"PRIVATE_COUNT\":999}')",
    )
    .bind(day)
    .run();
  for (let i = 0; i < 123; i++) {
    const id = `pap_${String(i).padStart(3, "0")}`;
    await db.batch([
      db
        .prepare(
          "INSERT INTO papers(id,title,title_norm,abstract,authors,first_seen_on,source) VALUES (?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          `Title ${i}`,
          `title ${i}`,
          i === 122 ? " \n\t " : "FULL_ABSTRACT",
          JSON.stringify(
            Array.from({ length: 9 }, (_, j) => ({ name: `Author ${j}` })),
          ),
          day,
          "arxiv",
        ),
      db
        .prepare(
          "INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          day,
          id,
          i % 2 ? "journal" : "arxiv",
          i < 3 ? null : Math.floor(i / 3),
          JSON.stringify([i % 2 ? "Language" : "Vision"]),
          i % 2,
        ),
      db
        .prepare(
          "INSERT INTO paper_ids(paper_id,scheme,value) VALUES (?,'arxiv',?)",
        )
        .bind(id, `2611.${i}`),
      db
        .prepare(
          "INSERT INTO paper_links(id,paper_id,kind,url) VALUES (?,?,'landing','https://example.org/paper')",
        )
        .bind(`lnk_${i}`, id),
      ...(i < 120
        ? [
            db
              .prepare(
                "INSERT INTO summaries(paper_id,lang,kind,content,client) VALUES (?,?,'five_part',?,?)",
              )
              .bind(
                id,
                i === 119 ? "zh" : "en",
                JSON.stringify(content),
                i === 118 ? "legacy" : "PRIVATE_CLIENT",
              ),
          ]
        : []),
    ]);
  }
  await db
    .prepare(
      "INSERT INTO paper_state(user_id,paper_id,read_at,rating) VALUES ('u_owner','pap_000','2026-11-16','up'),('u_other','pap_001','2026-11-16','down')",
    )
    .run();
}, 60_000);
afterAll(async () => close?.());
const get = async (path: string) => {
  const r = await app.request(`/api/v1${path}`, {}, env);
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: Record<string, unknown> }).data;
};
it("searches titles across every day, following the typing, and says where each paper was listed", async () => {
  const found = (await get("/search?q=title%2012")) as {
    items: Record<string, unknown>[];
  };
  // "Title 12", and "Title 120" to "Title 122": the last word is a prefix.
  expect(found.items.map((p) => p.title).sort()).toEqual([
    "Title 12",
    "Title 120",
    "Title 121",
    "Title 122",
  ]);
  expect(found.items.find((p) => p.title === "Title 12")).toEqual({
    paperId: "pap_012",
    title: "Title 12",
    authors: Array.from({ length: 4 }, (_, j) => ({ name: `Author ${j}` })),
    authorCount: 9,
    day,
    source: "arxiv",
    venue: null,
  });
  expect(JSON.stringify(found)).not.toMatch(/FULL_ABSTRACT|PRIVATE/);
  // Short queries are refused; the public API has no search.
  expect((await app.request("/api/v1/search?q=ti", {}, env)).status).toBe(400);
  expect(
    (await app.request("/api/v1/public/search?q=title", {}, env)).status,
  ).toBe(404);
});
it("lists each day with its papers on the reader's topics and how many were read, privately", async () => {
  await env
    .DB!.prepare(
      "INSERT INTO paper_state(user_id,paper_id,read_at) VALUES ('u_owner','pap_003','2026-11-16'),('u_other','pap_005','2026-11-16')",
    )
    .run();
  try {
    const mine = (await get("/feed/days?view=page")) as {
      items: { day: string; counts: Record<string, unknown> }[];
    };
    // 61 of the 123 papers are on topic; the owner opened one of them (the
    // other reader's open, and the owner's off-topic one, do not count).
    expect(mine.items.find((d) => d.day === day)!.counts).toMatchObject({
      total: 123,
      shortlisted: 61,
      read: 1,
    });
    const open = (await get("/public/days?view=page")) as typeof mine;
    const counts = open.items.find((d) => d.day === day)!.counts;
    expect(counts).toMatchObject({ total: 123, shortlisted: 61 });
    expect(counts).not.toHaveProperty("read");
  } finally {
    await env
      .DB!.prepare(
        "DELETE FROM paper_state WHERE paper_id IN ('pap_003','pap_005')",
      )
      .run();
  }
});
it("bounds pages, projects slim rows, preserves tied/null ranks and provides whole-day counts", async () => {
  let page = await get(`/feed/days/${day}`);
  const first = page.items as Record<string, unknown>[];
  expect(first).toHaveLength(50);
  expect(first[0]).toMatchObject({
    paperId: "pap_000",
    authorCount: 9,
    readingState: { readAt: "2026-11-16" },
  });
  // Up to twelve authors and the saved links (kind and address only), so
  // the reader can draw a paper's header in full before its record arrives.
  expect(first[0]!.authors).toHaveLength(9);
  expect(first[0]!.links).toEqual([
    { kind: "landing", url: "https://example.org/paper" },
  ]);
  expect(first[0]!.tldr).toEqual([{ lang: "en", text: "Short lead" }]);
  expect(JSON.stringify(page)).not.toMatch(
    /FULL_ABSTRACT|FULL_MOTIVATION|PRIVATE/,
  );
  expect(page.counts).toMatchObject({
    total: 123,
    topics: { Vision: 62, Language: 61 },
    sources: { arxiv: 62, journal: 61 },
  });
  const ids = first.map((p) => p.paperId);
  while (page.nextCursor) {
    page = await get(
      `/feed/days/${day}?cursor=${encodeURIComponent(String(page.nextCursor))}`,
    );
    ids.push(
      ...(page.items as Record<string, unknown>[]).map((p) => p.paperId),
    );
  }
  expect(ids).toHaveLength(123);
  expect(new Set(ids).size).toBe(123);
  expect((await get(`/feed/days/${day}?limit=100`)).items).toHaveLength(100);
});
it("applies filters before paging and rejects invalid or unrelated cursors", async () => {
  const page = await get(
    `/feed/days/${day}?topic=Language&shortlisted=true&source=journal&unread=true`,
  );
  expect(page.items).toHaveLength(50);
  const next = await get(
    `/feed/days/${day}?topic=Language&shortlisted=true&source=journal&unread=true&cursor=${page.nextCursor}`,
  );
  expect(next.items).toHaveLength(11);
  expect((await get(`/feed/days/${day}?unread=false`)).items).toHaveLength(1);
  for (const path of [
    `/feed/days/${day}?limit=101`,
    `/feed/days/${day}?cursor=bad`,
    `/feed/days/2026-11-15?cursor=${page.nextCursor}`,
    `/feed/days/${day}?cursor=${page.nextCursor}`,
  ])
    expect((await app.request(`/api/v1${path}`, {}, env)).status).toBe(400);
  expect((await get("/feed/days/2026-11-01")).counts).toMatchObject({
    total: 0,
    topics: {},
    sources: {},
  });
});
it("loads one full record by canonical or legacy id and excludes deleted papers", async () => {
  for (const id of ["pap_000", "2611.0", "arxiv:2611.0"]) {
    const p = await get(`/papers/${id}?day=${day}&source=arxiv`);
    expect(p.abstract).toBe("FULL_ABSTRACT");
    expect(p.authors).toHaveLength(9);
    expect(p.links).toHaveLength(1);
    expect(p.summaries).toMatchObject([{ content }]);
  }
  expect((await app.request("/api/v1/papers/missing", {}, env)).status).toBe(
    404,
  );
  await db
    .prepare(
      "INSERT INTO papers(id,title,title_norm,first_seen_on,source) VALUES ('pap_orphan','Orphan','orphan',?,'manual')",
    )
    .bind(day)
    .run();
  expect(await get("/papers/pap_orphan")).toMatchObject({
    paperId: "pap_orphan",
    source: "manual",
    authors: [],
    topics: [],
  });
  await db
    .prepare("UPDATE papers SET deleted_at='2026-11-17' WHERE id='pap_121'")
    .run();
  expect((await app.request("/api/v1/papers/pap_121", {}, env)).status).toBe(
    404,
  );
  await db
    .prepare("UPDATE papers SET deleted_at=NULL WHERE id='pap_121'")
    .run();
});
it("summary todo pages return only missing prompt inputs, treating legacy as already summarised", async () => {
  const page = await get(`/feed/days/${day}/summary-todo?lang=en&limit=2`);
  expect(page.items).toEqual([
    { paperId: "pap_119", title: "Title 119", abstract: "FULL_ABSTRACT" },
    { paperId: "pap_120", title: "Title 120", abstract: "FULL_ABSTRACT" },
  ]);
  expect(page.noAbstract).toBe(1);
  const next = await get(
    `/feed/days/${day}/summary-todo?lang=en&limit=2&cursor=${page.nextCursor}`,
  );
  expect(next.items).toEqual([
    { paperId: "pap_121", title: "Title 121", abstract: "FULL_ABSTRACT" },
  ]);
  expect(next.nextCursor).toBeNull();
});
it("public reads are paginated and cannot expose owner state or summary provenance", async () => {
  const page = await get(`/public/days/${day}?topic=Vision&limit=2`);
  expect(page.items).toHaveLength(2);
  expect(page.nextCursor).toBeTypeOf("string");
  expect(JSON.stringify(page)).not.toMatch(
    /readingState|readAt|rating|PRIVATE|FULL_/,
  );
  const paper = await get(`/public/papers/pap_000?day=${day}&source=arxiv`);
  expect(paper.abstract).toBe("FULL_ABSTRACT");
  expect(JSON.stringify(paper)).not.toMatch(
    /readingState|readAt|rating|PRIVATE/,
  );
  expect(
    (await app.request(`/api/v1/public/days/${day}?unread=true`, {}, env))
      .status,
  ).toBe(400);
  expect(
    (
      await app.request(
        "/api/v1/public/papers/pap_000",
        {},
        { ...env, PUBLIC_FEED: "false" },
      )
    ).status,
  ).toBe(404);
});
