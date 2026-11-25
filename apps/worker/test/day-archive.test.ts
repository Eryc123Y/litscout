import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { ingestPapers } from "@litscout/db/ingest-papers";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";
const day = "2026-11-16";
let db: D1Database, close: () => Promise<void>;
beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  db = h.db.$client as unknown as D1Database;
  await db.batch(
    Array.from({ length: 35 }, (_, i) =>
      db
        .prepare(
          "INSERT INTO feed_days(day,status,counts) VALUES (?,'crawled','{\"PRIVATE_COUNT\":999,\"arxiv\":999}')",
        )
        .bind(
          new Date(Date.parse(day) - i * 86400000).toISOString().slice(0, 10),
        ),
    ),
  );
  await ingestPapers(db, day, [
    {
      key: "a",
      title: "A",
      source: "arxiv",
      identifiers: [{ scheme: "arxiv", value: "2611.1" }],
    },
    {
      key: "b",
      title: "B",
      source: "openalex",
      identifiers: [{ scheme: "doi", value: "10.1234/b" }],
    },
  ]);
});
afterAll(async () => close?.());
it("H1 keeps operational cursor responses from exposing arbitrary stored fields", async () => {
  const env = { ...workerEnv().env, DB: db, LOCAL_DEV: "true" };
  await db
    .prepare("INSERT INTO sync_cursors(name,value) VALUES ('venue-feed',?)")
    .bind(JSON.stringify({ since: day, privateBody: "PRIVATE_CURSOR" }))
    .run();
  const response = await app.fetch(
    new Request("https://local/api/v1/sync/cursors?name=venue-feed"),
    env,
  );
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("PRIVATE_CURSOR");
  await db
    .prepare("UPDATE sync_cursors SET value=? WHERE name='venue-feed'")
    .bind(JSON.stringify({ since: day }))
    .run();
  expect(
    (
      await app.fetch(
        new Request("https://local/api/v1/sync/cursors?name=venue-feed"),
        env,
      )
    ).status,
  ).toBe(200);
});
it("H2 bounds the archive and returns only day/status/stored total and source counts", async () => {
  const env = {
    ...workerEnv().env,
    DB: db,
    LOCAL_DEV: "true",
    PUBLIC_FEED: "true",
  };
  for (const path of ["/feed/days", "/public/days"]) {
    const response = await app.fetch(
        new Request(`https://local/api/v1${path}`),
        env,
      ),
      body = (await response.json()) as { data: unknown[] };
    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(30);
    expect(body.data[0]).toEqual({
      day,
      status: "crawled",
      counts: { total: 2, sources: { arxiv: 1, openalex: 1 } },
    });
    expect(JSON.stringify(body)).not.toContain("PRIVATE_COUNT");
    const max = await app.fetch(
      new Request(`https://local/api/v1${path}?limit=100`),
      env,
    );
    expect(((await max.json()) as { data: unknown[] }).data).toHaveLength(35);
    for (const limit of ["0", "101", "1.5"])
      expect(
        (
          await app.fetch(
            new Request(`https://local/api/v1${path}?limit=${limit}`),
            env,
          )
        ).status,
      ).toBe(400);
  }
});

it("returns the keyword shortlist first with abstracts on both no-LLM day routes, including at a page boundary", async () => {
  const readingDay = "2026-11-17";
  await ingestPapers(db, readingDay, [
    {
      key: "no-match",
      title: "An unmatched paper",
      source: "arxiv",
      identifiers: [{ scheme: "arxiv", value: "2611.00011" }],
      rankInSource: 0,
      abstract: "Unmatched abstract",
    },
    {
      key: "match",
      title: "A keyword match",
      source: "arxiv",
      identifiers: [{ scheme: "arxiv", value: "2611.00012" }],
      rankInSource: 9,
      abstract: "Shortlisted abstract",
      shortlisted: true,
      topics: ["Vision"],
    },
  ]);
  const env = {
    ...workerEnv().env,
    DB: db,
    LOCAL_DEV: "true",
    PUBLIC_FEED: "true",
    INSTANCE_CONFIG: JSON.stringify({ keywordOnly: true }),
  };
  for (const route of ["feed", "public"]) {
    const url = `/api/v1/${route}/days/${readingDay}?limit=1`;
    const first = (await (await app.request(url, {}, env)).json()) as {
      data: { items: unknown[]; nextCursor: string };
    };
    expect(first.data.items).toMatchObject([
      { title: "A keyword match", abstract: "Shortlisted abstract", tldr: [] },
    ]);
    const second = (await (
      await app.request(`${url}&cursor=${first.data.nextCursor}`, {}, env)
    ).json()) as { data: { items: unknown[]; nextCursor: string | null } };
    expect(second.data.items).toMatchObject([
      { title: "An unmatched paper", abstract: "Unmatched abstract" },
    ]);
    expect(second.data.nextCursor).toBeNull();
  }
});
