import { afterAll, beforeAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { writeEvidence } from "@litscout/db/test/evidence";
import { app } from "../src/app";
import { countingDb } from "./helpers/counting-db";
import { workerEnv } from "./helpers/worker-env";

const day = "2026-11-18";
const id = "pap_library_test";
const token = "lsk_" + "R".repeat(52);
let close: () => Promise<void>;
let meter: ReturnType<typeof countingDb>;
let env: ReturnType<typeof workerEnv>["env"];
const counts: Record<string, { calls: number; maxParams: number }> = {};

beforeAll(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  meter = countingDb(h.db.$client as unknown as D1Database);
  env = {
    ...workerEnv().env,
    LOCAL_DEV: "true",
    PUBLIC_FEED: "true",
    DB: meter.db,
  };
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toString("hex");
  await meter.db.batch([
    meter.db
      .prepare(
        "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_library','test',?,?)",
      )
      .bind(hash, '["read","write","ingest"]'),
    meter.db
      .prepare(
        "INSERT INTO papers(id,title,title_norm,authors,abstract,venue,year) VALUES (?, 'Binocular rendering','binocularrendering','[{\"name\":\"Ada Laplace\"}]','hidden keyword','TOG',2026),('pap_other','Binocular matching','binocularmatching','[]',NULL,'CVPR',2025)",
      )
      .bind(id),
    meter.db.prepare("INSERT INTO feed_days(day) VALUES (?)").bind(day),
    meter.db
      .prepare(
        "INSERT INTO feed_items(day,paper_id,source) VALUES (?,?,'arxiv')",
      )
      .bind(day, id),
    meter.db
      .prepare(
        "INSERT INTO paper_links(id,paper_id,kind,url) VALUES ('lnk_doi',?,'doi','https://doi.org/10.1000/example')",
      )
      .bind(id),
  ]);
});
afterAll(async () => {
  await writeEvidence("m2a-library-counts.json", counts);
  await close();
});
async function request(
  path: string,
  method = "GET",
  input?: unknown,
  status = 200,
) {
  await meter.db.prepare("UPDATE api_tokens SET last_used_at=NULL").run();
  meter.reset();
  const response = await app.request(
    "/api/v1" + path,
    {
      method,
      headers: { authorization: "Bearer " + token },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
    env,
  );
  const responseText = await response.text();
  expect(response.status, responseText).toBe(status);
  const { calls, maxParams } = meter.stats();
  expect(calls).toBeLessThanOrEqual(40);
  expect(maxParams).toBeLessThanOrEqual(100);
  const route = path
    .split("?")[0]!
    .replace(/^\/notes\/[^/]+$/, "/notes/:id")
    .replace(/^\/library\/pap_[^/]+$/, "/library/:paperId");
  const name = `${method} ${route} ${status}`;
  counts[name] = {
    calls: Math.max(counts[name]?.calls ?? 0, calls),
    maxParams: Math.max(counts[name]?.maxParams ?? 0, maxParams),
  };
  return responseText ? JSON.parse(responseText).data : undefined;
}

it("paginates saved papers and filters by title, author, tags, venue, year and status", async () => {
  await request("/library", "POST", { paperId: id });
  await request("/library", "POST", { paperId: "pap_other" });
  const page = await request("/library?limit=1");
  expect(page.items).toHaveLength(1);
  const second = await request(
    "/library?limit=1&cursor=" + encodeURIComponent(page.nextCursor),
  );
  expect(second.items[0].paperId).not.toBe(page.items[0].paperId);
  await request("/library?q=bi", "GET", undefined, 400);
  const updated = await request("/library/" + id, "PATCH", {
    status: "reading",
    tags: ["vision"],
    if_rev: 1,
  });
  expect(updated.rev).toBe(2);
  const found = await request(
    "/library?q=Laplace&tags=vision&status=reading&venue=TOG&year=2026",
  );
  expect(found.items).toMatchObject([
    {
      paperId: id,
      origin: ["litscout"],
      status: "reading",
      link: { kind: "doi" },
    },
  ]);
  expect((await request("/library?q=hidden")).items).toEqual([]);
  await request("/library/" + id, "DELETE", { if_rev: 1 }, 409);
  await request("/library/" + id, "DELETE", { if_rev: 2 });
  expect((await request("/library?q=Laplace")).items).toEqual([]);
  await request("/library", "POST", { paperId: id });
  await request("/library", "HEAD");
});

it("records every event kind and only changes that reading field", async () => {
  for (const kind of [
    "open",
    "rate_down",
    "rate_clear",
    "rate_up",
    "star",
    "unstar",
    "star",
    "save",
    "from_report",
  ]) {
    await request("/events", "POST", { paperId: id, kind, day });
  }
  expect((await request("/state?day=" + day)).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        paperId: id,
        starred: true,
        rating: "up",
        readAt: expect.any(String),
      }),
    ]),
  );
  const feed = await request("/feed/days/" + day + "?unread=true");
  expect(feed.items).toEqual([]);
  await request("/state?day=" + day, "HEAD");
});

it("version-checks quick notes, prevents other targets and soft-deletes", async () => {
  await request(
    "/notes",
    "POST",
    { target: id, targetType: "idea", bodyMd: "hello" },
    400,
  );
  await request(
    "/notes",
    "POST",
    { target: id, bodyMd: "x".repeat(4001) },
    400,
  );
  const note = await request("/notes", "POST", {
    target: id,
    bodyMd: "**reading**",
  });
  expect((await request("/notes?target=" + id)).items).toMatchObject([
    { id: note.id, bodyMd: "**reading**", rev: 1 },
  ]);
  await request("/notes/" + note.id, "PATCH", {
    if_rev: 1,
    bodyMd: "**edited**",
  });
  await request("/notes/" + note.id, "DELETE", { if_rev: 1 }, 409);
  await request("/notes/" + note.id, "DELETE", { if_rev: 2 });
  expect((await request("/notes?target=" + id)).items).toEqual([]);
  await request("/notes?target=" + id, "HEAD");
});

it("checks links through ingest and keeps the stored DOI", async () => {
  await meter.db.batch(
    Array.from({ length: 19 }, (_, n) =>
      meter.db
        .prepare(
          "INSERT INTO paper_links(id,paper_id,kind,url) VALUES (?,?, 'landing', ?)",
        )
        .bind("lnk_z" + n, id, "https://publisher.example/" + n),
    ),
  );
  const items = (await request("/ingest/links?limit=20")).items as {
    id: string;
    url: string;
  }[];
  expect(items).toHaveLength(20);
  expect(items).toContainEqual({
    id: "lnk_doi",
    url: "https://doi.org/10.1000/example",
  });
  await request("/ingest/links", "POST", {
    checks: items.map((item) => ({
      ...item,
      httpStatus: 404,
      checkedAt: day + "T00:00:00.000Z",
    })),
  });
  expect((await request("/papers/" + id)).links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "doi",
        url: "https://doi.org/10.1000/example",
        httpStatus: 404,
      }),
    ]),
  );
  await request("/ingest/links?limit=20", "HEAD");
});

it("does not expose saved papers, notes, state or events through the public API", async () => {
  await request("/library", "POST", { paperId: "pap_other" });
  await request("/notes", "POST", { target: id, bodyMd: "private-annotation" });
  await request("/events", "POST", { paperId: id, kind: "star", day });
  const publicEnv = { ...env, LOCAL_DEV: undefined };
  for (const path of [
    "/library",
    "/state",
    "/notes",
    "/events",
    "/library/save",
  ]) {
    expect((await app.request("/api/v1" + path, {}, publicEnv)).status).toBe(
      503,
    );
    expect(
      (await app.request("/api/v1/public" + path, {}, publicEnv)).status,
    ).toBe(404);
  }
  expect((await request("/public/papers/" + id)).readingState).toBeUndefined();
  expect(JSON.stringify(await request("/public/days/" + day))).not.toMatch(
    /private-annotation|readingState|pap_other/,
  );
  await request("/public/papers/pap_other", "GET", undefined, 404);
});

it("counts the largest page, full tag filter, note limit and stored identifier save", async () => {
  const tags = Array.from({ length: 20 }, (_, n) => "tag" + n);
  const values = Array.from(
    { length: 101 },
    (_, n) => `pap_budget_${String(n).padStart(3, "0")}`,
  );
  await meter.db.batch(
    values.flatMap((id) => [
      meter.db
        .prepare(
          "INSERT INTO papers(id,title,title_norm,year,venue) VALUES (?,'Budget paper','budgetpaper',2026,'TOG')",
        )
        .bind(id),
      meter.db
        .prepare(
          "INSERT INTO library_items(paper_id,added_via,tags) VALUES (?,'web',?)",
        )
        .bind(id, JSON.stringify(tags)),
    ]),
  );
  const q = new URLSearchParams({
    status: "saved",
    q: "Budget",
    tags: tags.join(","),
    venue: "TOG",
    year: "2026",
    limit: "100",
  });
  const found: string[] = [];
  for (const size of [36, 36, 29]) {
    const page = await request("/library?" + q);
    expect(page.items).toHaveLength(size);
    found.push(...page.items.map((item: { paperId: string }) => item.paperId));
    if (page.nextCursor) q.set("cursor", page.nextCursor);
    else expect(size).toBe(29);
  }
  expect(found.sort()).toEqual(values);
  await request("/notes", "POST", {
    target: values[0],
    bodyMd: "x".repeat(4000),
  });
  expect(
    await request("/library/save", "POST", { query: values[1] }),
  ).toMatchObject({ paperId: values[1] });
});

it("keeps library writes and the ingest link routes under their own scopes", async () => {
  async function scope(value: string) {
    await meter.db
      .prepare("UPDATE api_tokens SET scopes=?")
      .bind(JSON.stringify([value]))
      .run();
  }
  try {
    await scope("read");
    await request("/library", "GET");
    await request("/library/save", "POST", { query: id }, 403);
    await request("/ingest/links", "GET", undefined, 403);
    await scope("ingest");
    await request("/ingest/links", "GET");
    await request("/notes?target=" + id, "GET", undefined, 403);
    await request("/events", "POST", { paperId: id, kind: "open" }, 403);
  } finally {
    await meter.db
      .prepare("UPDATE api_tokens SET scopes=?")
      .bind('["read","write","ingest"]')
      .run();
  }
});
