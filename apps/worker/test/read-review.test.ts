import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { writeEvidence } from "@litscout/db/test/evidence";
import { databaseHarness } from "@litscout/db/test/harness";
import { readDayPage } from "@litscout/db/bounded-read";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";
const day = "2026-11-16";
let db: D1Database,
  close: () => Promise<void>,
  env: ReturnType<typeof workerEnv>["env"];
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  db = h.db.$client as unknown as D1Database;
  env = { ...workerEnv().env, DB: db, LOCAL_DEV: "true", PUBLIC_FEED: "true" };
  await db
    .prepare("INSERT INTO feed_days(day,status) VALUES (?,'crawled')")
    .bind(day)
    .run();
  for (let i = 0; i < 80; i++)
    await db.batch([
      db
        .prepare(
          "INSERT INTO papers(id,title,title_norm,abstract,authors,source) VALUES (?,?,?,?,?,'arxiv')",
        )
        .bind(
          `pap_${i}`,
          `Title ${i}`,
          `title ${i}`,
          "needle only in abstract",
          '[{"name":"Ada Lovelace"}]',
        ),
      db
        .prepare(
          "INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted,hf_upvotes) VALUES (?,?,'arxiv',?,'[\"Vision\"]',0,NULL)",
        )
        .bind(day, `pap_${i}`, i),
      db
        .prepare(
          "INSERT INTO paper_ids(paper_id,scheme,value) VALUES (?,'arxiv',?)",
        )
        .bind(`pap_${i}`, i === 0 ? "same" : `2611.${i}`),
    ]);
  await db
    .prepare(
      "INSERT INTO feed_items(day,paper_id,source,rank_in_source,topics,shortlisted,hf_upvotes) VALUES (?,'pap_0','huggingface',2,'[\"HF\"]',1,42)",
    )
    .bind(day)
    .run();
  await db
    .prepare(
      "INSERT INTO papers(id,title,title_norm,source) VALUES ('pap_private','Library only','library','manual')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_1','doi','same')",
    )
    .run();
});
afterAll(async () => close?.());
const call = (path: string, ip = "192.0.2.11", method = "GET") =>
  app.request(
    `/api/v1${path}`,
    { method, headers: { "CF-Connecting-IP": ip } },
    env,
  );
const data = async (path: string) => {
  const r = await call(path);
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: Record<string, unknown> }).data;
};
it("flags list rows whose paper has no abstract", async () => {
  const own = await databaseHarness("d1");
  const quiet = own.db.$client as unknown as D1Database;
  const listing = "2026-11-14";
  try {
    await quiet.batch([
      quiet
        .prepare("INSERT INTO feed_days(day,status) VALUES (?,'crawled')")
        .bind(listing),
      quiet.prepare(
        "INSERT INTO papers(id,title,title_norm,abstract,authors,source) VALUES ('pap_bare','Bare','bare',NULL,'[]','crossref'),('pap_blank','Blank','blank','  ','[]','crossref'),('pap_full','Full','full','Text','[]','arxiv')",
      ),
      quiet
        .prepare(
          "INSERT INTO feed_items(day,paper_id,source,rank_in_source) VALUES (?1,'pap_bare','crossref',1),(?1,'pap_blank','crossref',2),(?1,'pap_full','arxiv',3)",
        )
        .bind(listing),
    ]);
    const page = await readDayPage(quiet, listing, { limit: 10 });
    expect(
      Object.fromEntries(
        page.items.map((item) => [item.paperId, item.hasAbstract]),
      ),
    ).toEqual({ pap_bare: false, pap_blank: false, pap_full: true });
  } finally {
    await own.close();
  }
});
it("R10/R12 retains both source records in full pages and source-scoped paper reads", async () => {
  const p = await data(`/papers/pap_0?day=${day}&source=huggingface`);
  expect(p).toMatchObject({
    source: "huggingface",
    topics: ["HF"],
    rankInSource: 2,
    shortlisted: true,
    hfUpvotes: 42,
  });
  expect((await call(`/papers/pap_0?day=${day}`)).status).toBe(400);
  const page = await data(`/feed/days/${day}/full?limit=50`);
  expect(page.items).toHaveLength(50);
  expect(
    (page.items as Record<string, unknown>[])
      .filter((p) => p.paperId === "pap_0")
      .map((p) => p.source),
  ).toEqual(["arxiv", "huggingface"]);
  expect(JSON.stringify(page)).toContain("needle only in abstract");
  expect((await call(`/feed/days/${day}/full?limit=51`)).status).toBe(400);
  expect((await call(`/public/days/${day}/full`)).status).toBe(404);
  const selected = await data(`/feed/days/${day}/full?ids=pap_0`);
  expect(selected.items).toHaveLength(2);
});
it("R12 bounds and pages history metadata without abstracts, summaries or links", async () => {
  const first = await data(`/feed/history?from=${day}&to=${day}&limit=2`);
  expect(first.items).toHaveLength(2);
  expect(first.items).toMatchObject([
    { day, paperId: "pap_0", source: "arxiv", hasAbstract: true },
    { day, paperId: "pap_0", source: "huggingface", hfUpvotes: 42 },
  ]);
  expect(JSON.stringify(first)).not.toMatch(
    /needle|"abstract"|"summaries"|"links"/,
  );
  const next = await data(
    `/feed/history?from=${day}&to=${day}&limit=200&cursor=${first.nextCursor}`,
  );
  expect(next.items).toHaveLength(79);
  expect(next.nextCursor).toBeNull();
  for (const path of [
    `/feed/history?from=${day}&to=${day}&limit=501`,
    `/feed/history?from=2026-01-01&to=${day}`,
  ])
    expect((await call(path)).status).toBe(400);
});
it("R13 uses indexed identifier resolution and a fixed bare-value scheme priority", async () => {
  expect(await data("/papers/arxiv:same")).toMatchObject({ paperId: "pap_0" });
  expect(await data("/papers/doi:same")).toMatchObject({ paperId: "pap_1" });
  expect(await data("/papers/same")).toMatchObject({ paperId: "pap_0" });
  const plan = await db
    .prepare("EXPLAIN QUERY PLAN SELECT paper_id FROM paper_ids WHERE value=?")
    .bind("same")
    .all<{ detail: string }>();
  expect(plan.results.map((r) => r.detail).join("\n")).toContain(
    "SEARCH paper_ids USING PRIMARY KEY (value=?)",
  );
});
it("R14 limits search to title and author values with at least three characters", async () => {
  expect((await call(`/feed/days/${day}?q=ab`)).status).toBe(400);
  expect((await data(`/feed/days/${day}?q=ADA`)).items).toHaveLength(50);
  for (const q of ["needle", "name", "same", "Vision"])
    expect((await data(`/feed/days/${day}?q=${q}`)).items).toEqual([]);
});
it("R14 limits public search to ten per IP per minute independently of ordinary reads", async () => {
  vi.useFakeTimers();
  try {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await call(
            `/public/days/${day}?q=Title`,
            "192.0.2.99",
            i % 2 ? "HEAD" : "GET",
          )
        ).status,
      ).toBe(200);
    expect(
      (await call(`/public/days/${day}?q=Title`, "192.0.2.99")).status,
    ).toBe(429);
    expect((await call(`/public/days/${day}`, "192.0.2.99")).status).toBe(200);
    expect(
      (await call(`/public/days/${day}?q=Title`, "192.0.2.100")).status,
    ).toBe(200);
    vi.advanceTimersByTime(60_000);
    expect(
      (await call(`/public/days/${day}?q=Title`, "192.0.2.99")).status,
    ).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});
it("R15 requires public feed membership, including after a paper leaves its last feed", async () => {
  expect((await call("/public/papers/pap_private")).status).toBe(404);
  expect((await call("/papers/pap_private")).status).toBe(200);
  await db.prepare("DELETE FROM feed_items WHERE paper_id='pap_79'").run();
  expect((await call("/public/papers/pap_79")).status).toBe(404);
});
it("R16 rejects tampered, unbounded and non-finite cursor fields before D1", async () => {
  const page = await data(`/feed/days/${day}?limit=1`);
  const original = JSON.parse(
    Buffer.from(String(page.nextCursor), "base64url").toString(),
  );
  for (const [key, value] of [
    ["rank", "NONFINITE"],
    ["context", "x".repeat(1000)],
    ["id", "x".repeat(5001)],
    ["source", "x".repeat(5001)],
  ]) {
    let json = JSON.stringify({ ...original, [String(key)]: value });
    if (value === "NONFINITE") json = json.replace('"NONFINITE"', "1e309");
    const cursor = Buffer.from(json).toString("base64url");
    expect(
      (await call(`/feed/days/${day}?limit=1&cursor=${cursor}`)).status,
    ).toBe(400);
  }
});
it("R17 uses an index range on the actual cursor-page query", async () => {
  const first = await readDayPage(db, day, { limit: 1 });
  let sql = "",
    params: unknown[] = [];
  const tracked = {
    batch: db.batch.bind(db),
    prepare(query: string) {
      const stmt = db.prepare(query);
      return new Proxy(stmt, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) => {
              if (query.includes("LIMIT ?")) {
                sql = query;
                params = values;
              }
              return target.bind(...values);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  await readDayPage(tracked, day, { limit: 1, cursor: first.nextCursor });
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  await writeEvidence("m1c-r6-query-plan.json", plan.results);
  expect(plan.results.map((r) => r.detail).join("\n")).toMatch(
    /SEARCH f USING INDEX feed_items_read_order.*day=\? AND \(rank_sort,paper_id,source\)>\(\?,\?,\?\)/,
  );
});

it("M1d exposes stored link health dates in private and public full records", async () => {
  await db
    .prepare(
      "INSERT INTO paper_links(id,paper_id,kind,url,checked_at,http_status,oa_status) VALUES ('lnk_m1d','pap_0','landing','https://example.org/paper','2026-11-17T08:00:00Z',404,'green')",
    )
    .run();
  for (const prefix of ["", "/public"]) {
    const paper = await data(`${prefix}/papers/pap_0?day=${day}&source=arxiv`);
    expect(paper.links).toContainEqual(
      expect.objectContaining({
        kind: "landing",
        checkedAt: "2026-11-17T08:00:00Z",
        httpStatus: 404,
        oaStatus: "green",
      }),
    );
  }
});

it("M1d R2 returns source-scoped digest references without changing the CLI digest", async () => {
  const picks = Array.from({ length: 24 }, (_, i) => `pap_${i}`);
  await db
    .prepare(
      "INSERT INTO digests(day,lang,kind,body_md,picks,radar,created_at) VALUES (?,'en','daily','Report',?,?,'2026-11-17T19:15:00Z')",
    )
    .bind(
      day,
      JSON.stringify(picks),
      JSON.stringify([
        {
          paperId: "pap_0",
          level: "borrow",
          reason: "Relevant",
          newerField: "ignored by older readers",
        },
      ]),
    )
    .run();
  const view = await data(`/feed/days/${day}/digest`);
  expect(view.createdAt).toBe("2026-11-17T19:15:00Z");
  expect(view.picks).toHaveLength(24);
  // Each reference carries its title and topics, so the reader needs no
  // second request to name the brief's papers.
  const first = (
    view.picks as { paperId: string; title: string; topics: string[] }[]
  ).find((pick) => pick.paperId === "pap_0")!;
  expect(first).toMatchObject({ paperId: "pap_0", source: "arxiv", day });
  expect(typeof first.title).toBe("string");
  expect(first.title.length).toBeGreaterThan(0);
  expect(Array.isArray(first.topics)).toBe(true);
  expect(view.radar).toContainEqual(
    expect.objectContaining({ paperId: "pap_0", source: "arxiv", day }),
  );
  expect(JSON.stringify(view.radar)).not.toContain("newerField");
  const legacy = await data(`/digests/${day}`);
  expect(legacy.picks).toEqual(picks);
  const batch = await data(
    `/feed/days/${day}/references?${new URLSearchParams({
      ids: JSON.stringify([
        { paperId: "pap_0", source: "arxiv", day },
        { paperId: "pap_0", source: "huggingface", day },
      ]),
    })}`,
  );
  expect(batch.items).toHaveLength(2);
  expect(batch.items).toContainEqual(
    expect.objectContaining({
      paperId: "pap_0",
      source: "huggingface",
      topics: ["HF"],
    }),
  );
  expect(
    (
      await call(
        `/feed/days/${day}/references?${new URLSearchParams({ ids: JSON.stringify(Array.from({ length: 51 }, () => ({ paperId: "pap_0", source: "arxiv", day }))) })}`,
      )
    ).status,
  ).toBe(400);
});
it("M1d R2 exposes bounded day cursors and counts without paper metadata", async () => {
  for (const prefix of ["/feed", "/public"]) {
    const list = await data(`${prefix}/days?view=page&limit=1`);
    expect(list.items).toHaveLength(1);
    expect(list.nextBefore).toBeNull();
    const counts = await data(`${prefix}/days/${day}/counts`);
    expect(counts).toMatchObject({
      day,
      status: "crawled",
      counts: { total: 80 },
    });
    expect(counts).not.toHaveProperty("items");
  }
});

it("M1d R2 keeps a 100-day page within the D1 parameter limit", async () => {
  await db.batch(
    Array.from({ length: 105 }, (_, i) =>
      db
        .prepare("INSERT INTO feed_days(day,status) VALUES (?,'empty')")
        .bind(
          new Date(Date.parse(day) - (i + 1) * 86400000)
            .toISOString()
            .slice(0, 10),
        ),
    ),
  );
  let maxBindings = 0;
  const tracked = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => {
        maxBindings = Math.max(maxBindings, args.length);
        return bind(...args);
      };
      return stmt;
    },
    batch: db.batch.bind(db),
  } as D1Database;
  const response = await app.request(
    "/api/v1/feed/days?view=page&limit=100",
    {},
    { ...env, DB: tracked },
  );
  expect(response.status).toBe(200);
  const page = (await response.json()) as {
    data: { items: unknown[]; nextBefore: string | null };
  };
  expect(page.data.items).toHaveLength(100);
  expect(page.data.nextBefore).not.toBeNull();
  expect(maxBindings).toBeLessThanOrEqual(100);
});

it("shows the other language's digest in the reader but keeps the CLI digest exact", async () => {
  await db
    .prepare(
      "INSERT INTO digests(day,lang,kind,body_md,picks,radar) VALUES ('1998-06-01','zh','daily','Chinese report','[]','[]')",
    )
    .run();
  expect(await data("/feed/days/1998-06-01/digest?lang=en")).toMatchObject({
    lang: "zh",
    bodyMd: "Chinese report",
  });
  expect(await data("/digests/1998-06-01?lang=en")).toBeNull();
  await db
    .prepare(
      "INSERT INTO digests(day,lang,kind,body_md,picks,radar) VALUES ('1998-06-01','en','daily','English report','[]','[]')",
    )
    .run();
  expect(await data("/feed/days/1998-06-01/digest?lang=en")).toMatchObject({
    lang: "en",
    bodyMd: "English report",
  });
});

it("M1d R2 handles absent/empty digests, retained records, and historical radar sources", async () => {
  expect(await data("/feed/days/1999-01-01/digest")).toBeNull();
  await db
    .prepare("INSERT INTO feed_days(day,status) VALUES ('2000-01-01','empty')")
    .run();
  await db
    .prepare(
      "INSERT INTO digests(day,lang,body_md,picks,radar) VALUES ('2000-01-01','en','Empty','[]','[]')",
    )
    .run();
  expect(await data("/feed/days/2000-01-01/digest")).toMatchObject({
    picks: [],
    radar: [],
  });
  await db
    .prepare(
      "INSERT INTO papers(id,title,title_norm,source) VALUES ('pap_past','Past paper','past','arxiv')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO feed_items(day,paper_id,source,topics) VALUES ('2000-01-01','pap_past','journal','[\"Past\"]')",
    )
    .run();
  await db
    .prepare(
      "UPDATE digests SET picks=?,radar=? WHERE day=? AND lang='en' AND kind='daily'",
    )
    .bind(
      JSON.stringify(["pap_private", "pap_absent"]),
      JSON.stringify([
        {
          paperId: "pap_past",
          level: "borrow",
          reason: "Past",
          lookBack: true,
        },
      ]),
      day,
    )
    .run();
  const digest = await data(`/feed/days/${day}/digest`);
  expect(digest.picks).toEqual([
    // A retained record outside the feed: its title, no feed topics.
    {
      paperId: "pap_private",
      source: "manual",
      day: null,
      title: expect.any(String),
      topics: [],
    },
    { paperId: "pap_absent", source: null, day: null },
  ]);
  expect(digest.radar).toContainEqual(
    expect.objectContaining({
      paperId: "pap_past",
      source: "journal",
      day: "2000-01-01",
    }),
  );
  const refs = [
    { paperId: "pap_private", source: "manual", day: null },
    { paperId: "pap_past", source: "journal", day: "2000-01-01" },
  ];
  expect(
    (
      await data(
        `/feed/days/${day}/references?${new URLSearchParams({ ids: JSON.stringify(refs) })}`,
      )
    ).items,
  ).toHaveLength(2);
});
