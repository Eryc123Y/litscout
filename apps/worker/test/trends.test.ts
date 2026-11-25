import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

it("stores one private monthly row, avoids unchanged writes, and keeps the source ingest-scoped", async () => {
  const { db, close } = await databaseHarness("d1");
  const client = db.$client as D1Database;
  const env = {
    ...workerEnv().env,
    DB: client,
    INSTANCE_CONFIG: JSON.stringify({
      name: "Test",
      language: "en",
      timezone: "Asia/Kuala_Lumpur",
      topics: ["Depth"],
    }),
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
  };
  const token = (suffix: string) => "lsk_" + suffix.toUpperCase().repeat(52);
  const request = (path: string, suffix?: string, rows?: unknown) =>
    app.request(
      "/api/v1" + path,
      {
        method: rows === undefined ? "GET" : "PUT",
        headers: suffix ? { authorization: "Bearer " + token(suffix) } : {},
        ...(rows === undefined ? {} : { body: JSON.stringify({ rows }) }),
      },
      env,
    );
  try {
    for (const suffix of ["read", "ingest"] as const)
      await client
        .prepare(
          "INSERT INTO api_tokens(id,name,hash,scopes,last_used_at) VALUES (?,?,?,?,?)",
        )
        .bind(
          suffix,
          suffix,
          createHash("sha256").update(token(suffix[0]!)).digest("hex"),
          JSON.stringify([suffix]),
          new Date().toISOString(),
        )
        .run();
    const row = {
      topic: "Depth",
      month: "2026-11",
      volume: 5,
      shortlisted: 2,
      picks: [],
      activity: [],
      recurring: [],
      rising: [],
      radar: { high: 1, medium: 0, borrow: 0 },
    };
    expect((await request("/trends?month=2026-11")).status).toBe(401);
    expect((await request("/trends?month=2026-11", "i")).status).toBe(403);
    expect(
      (await request("/ingest/trends/source?month=2026-11&kind=papers", "r"))
        .status,
    ).toBe(403);
    expect((await request("/ingest/trends", "r", [row])).status).toBe(403);
    const upload = await request("/ingest/trends", "i", [row]);
    expect(upload.status, await upload.clone().text()).toBe(200);
    expect(await upload.json()).toMatchObject({ meta: { rowsWritten: 1 } });
    expect(
      await (await request("/ingest/trends", "i", [row])).json(),
    ).toMatchObject({ meta: { rowsWritten: 0 } });
    expect(
      await (await request("/trends?month=2026-11", "r")).json(),
    ).toMatchObject({
      data: {
        topic: "Depth",
        month: "2026-11",
        detail: { volume: 5, shortlisted: 2 },
      },
    });
    // A row from an older CLI has no comparison; a new row keeps its own.
    const legacy = (await (
      await request("/trends?month=2026-11", "r")
    ).json()) as {
      data: { detail: object };
    };
    expect(legacy.data.detail).not.toHaveProperty("comparison");
    const rising = [{ term: "psnr", count: 2, score: 3.76 }];
    const comparison = { days: 1, first: "2026-10-30", last: "2026-10-30" };
    expect(
      await (
        await request("/ingest/trends", "i", [{ ...row, rising, comparison }])
      ).json(),
    ).toMatchObject({ meta: { rowsWritten: 1 } });
    expect(
      await (await request("/trends?month=2026-11", "r")).json(),
    ).toMatchObject({ data: { detail: { rising, comparison } } });
  } finally {
    await close();
  }
});

it("bounds source continuations, finds abstract terms, and reads both digest languages", async () => {
  const { db, close } = await databaseHarness("d1");
  const client = db.$client as D1Database;
  const { countingDb } = await import("./helpers/counting-db");
  const counter = countingDb(client);
  const env = { ...workerEnv().env, DB: counter.db, LOCAL_DEV: "true" };
  const get = async (route: string, params: Record<string, string> = {}) => {
    counter.reset();
    const response = await app.request(
      `/api/v1${route}?${new URLSearchParams(params)}`,
      {},
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return (
      (await response.json()) as {
        data: { items: unknown[]; nextCursor: string | null };
      }
    ).data;
  };
  const day = "2026-11-01";
  try {
    await client.batch([
      client.prepare(
        `INSERT INTO feed_days(day) VALUES ('${day}'),('2026-11-02'),('2026-10-31')`,
      ),
      client.prepare(`
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<500)
        INSERT INTO papers(id,title,title_norm,abstract)
        SELECT printf('p%03d',x),'Paper '||x,'paper '||x,
          CASE WHEN x IN (1,475) THEN 'Recurring wavelets improve accuracy' ELSE 'Other' END FROM n
      `),
      client.prepare(`
        INSERT INTO feed_items(day,paper_id,source,topics)
        SELECT '${day}',id,'test','["Depth"]' FROM papers
      `),
      client.prepare(`
        INSERT INTO events(id,paper_id,day,kind,source)
        SELECT id,id,'${day}','open','test' FROM papers
      `),
      client.prepare(`
        INSERT INTO events(id,paper_id,day,kind,source)
        VALUES ('save','p475','2026-11-02','save','test')
      `),
      client.prepare(`
        INSERT INTO digests(day,lang,kind,body_md,picks,radar,final)
        VALUES ('${day}','en','daily','Draft','["p001","p475"]','[{"paperId":"p001","level":"borrow","reason":"private"}]',0),
        ('${day}','zh','daily','Final','["p475"]','[]',1)
      `),
      client.prepare(`
        INSERT INTO radar_grades(id,day,paper_id,level,reason)
        VALUES ('radar','${day}','p001','medium','private')
      `),
    ]);
    const sources = async (kind: string, steps: number, maxRead: number) => {
      const found: unknown[] = [];
      let cursor: string | undefined;
      for (let step = 0; step < steps; step++) {
        const result = await get("/ingest/trends/source", {
          kind,
          month: "2026-11",
          ...(cursor && { cursor }),
        });
        expect(counter.stats().calls).toBe(1);
        expect(
          counter.stats().rowsRead,
          kind + " page " + step,
        ).toBeLessThanOrEqual(maxRead);
        found.push(...result.items);
        if (!result.nextCursor) return found;
        expect(result.nextCursor).not.toBe(cursor);
        cursor = result.nextCursor;
      }
      throw new Error("Source never finished");
    };
    const papers = await sources("papers", 22, 80);
    expect(papers).toHaveLength(500);
    // Each paper names its listing day, so a refresh can count last month's days.
    expect(papers[0]).toMatchObject({ paperId: "p001", day });
    expect(await sources("digests", 2, 40)).toEqual([
      {
        picks: ["p001", "p475"],
        radar: [{ paperId: "p001", level: "borrow" }],
      },
      { picks: ["p475"], radar: [] },
    ]);
    expect(await sources("radar", 1, 32)).toEqual([
      { paperId: "p001", level: "medium" },
    ]);
    expect(await sources("events", 15, 100)).toMatchObject([
      { paperId: "p475", kind: "save" },
    ]);
    expect(await get("/ingest/trends/source/window")).toEqual({
      oldestMonth: "2026-10",
    });
    const params = { month: "2026-11", topic: "Depth", term: "wavelets" };
    expect(await get("/trends/search", params)).toMatchObject({
      items: [{ paperId: "p001", title: "Paper 1" }],
      nextCursor: expect.any(String),
    });
    expect(
      await get("/trends/search", {
        ...params,
        cursor: JSON.stringify([day, "p474", "test"]),
      }),
    ).toMatchObject({
      items: [{ paperId: "p475", title: "Paper 475" }],
      nextCursor: null,
    });
    expect(counter.stats().rowsRead).toBeLessThanOrEqual(150);
  } finally {
    await close();
  }
});
