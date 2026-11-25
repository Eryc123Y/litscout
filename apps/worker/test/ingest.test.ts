import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { migrationStatements } from "@litscout/db/test/harness";
let mf: Miniflare;
const tokens = { read: "R", ingest: "I", write: "W" };
const raw = (scope: keyof typeof tokens) => "lsk_" + tokens[scope].repeat(52);
beforeAll(async () => {
  await build({
    entryPoints: ["apps/worker/src/index.ts"],
    outfile: ".artifacts/ingest-worker.js",
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    define: { __GIT_SHA__: '"test"' },
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: ".artifacts/ingest-worker.js",
      compatibilityDate: "2026-10-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      kvNamespaces: ["OAUTH_KV"],
      durableObjects: {
        PAIRING_STORE: { className: "PairingStore", useSQLite: true },
        SOURCE_LIMITER: { className: "SourceLimiter", useSQLite: true },
      },
      outboundService: () => new Response("Network disabled", { status: 503 }),
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const statement of migrationStatements())
    await db.prepare(statement).run();
  for (const scope of Object.keys(tokens) as (keyof typeof tokens)[]) {
    const hash = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(raw(scope)),
      ),
    ).toString("hex");
    await db
      .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
      .bind(`tok_${scope}`, scope, hash, JSON.stringify([scope]))
      .run();
  }
});
afterAll(async () => {
  await mf?.dispose();
});
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  scope: keyof typeof tokens = method === "GET" ? "read" : "ingest",
) =>
  mf.dispatchFetch(`http://local/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${raw(scope)}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const paper = {
  key: "2611.00001",
  title: "Stereo method",
  authors: ["A"],
  abstract: "A depth abstract",
  source: "arxiv",
  categories: ["cs.CV"],
  identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
  topics: ["Vision"],
  shortlisted: true,
};
let paperId: string;
it("ingests <=40 papers atomically, returns D1 rows and performs zero unchanged writes", async () => {
  const data = { day: "2026-11-17", papers: [paper] };
  const first = await request("/ingest/papers", "POST", data);
  expect(first.status).toBe(200);
  const out = (await first.json()) as {
    data: { papers: { paperId: string }[] };
    meta: { rowsWritten: number };
  };
  expect(out.meta.rowsWritten).toBeGreaterThan(0);
  paperId = out.data.papers[0]!.paperId;
  const again = await request("/ingest/papers", "POST", data);
  expect(await again.json()).toMatchObject({ meta: { rowsWritten: 0 } });
  expect(
    (
      await request("/ingest/papers", "POST", {
        ...data,
        papers: Array(101).fill(paper),
      })
    ).status,
  ).toBe(413);
});
it("reads joined metadata, summaries, topics and indexed filters", async () => {
  const content = Object.fromEntries(
    ["tldr", "motivation", "method", "result", "conclusion"].map((k) => [
      k,
      "field",
    ]),
  );
  const body = { summaries: [{ paperId, lang: "en", content }] };
  expect((await request("/ingest/summaries", "POST", body)).status).toBe(200);
  expect(
    await (await request("/ingest/summaries", "POST", body)).json(),
  ).toMatchObject({ meta: { rowsWritten: 0 } });
  expect(
    (
      await request("/ingest/summaries", "POST", {
        summaries: Array(101).fill(body.summaries[0]),
      })
    ).status,
  ).toBe(413);
  const day = await (
    await request(
      "/feed/days/2026-11-17?topic=Vision&shortlisted=true&source=arxiv",
    )
  ).json();
  expect(day).toMatchObject({
    data: {
      items: [
        {
          paperId,
          title: paper.title,
          topics: ["Vision"],
          tldr: [{ lang: "en", text: content.tldr }],
        },
      ],
    },
  });
  expect(
    await (await request("/feed/days/2026-11-17?topic=Other")).json(),
  ).toMatchObject({ data: { items: [] } });
  expect((await request("/feed/days/not-a-day")).status).toBe(400);
});
it("validates feed status, digest/radar idempotency and digest alias", async () => {
  const day = { day: "2026-11-17", status: "summarised", counts: { arxiv: 1 } };
  expect((await request("/ingest/feed-day", "POST", day)).status).toBe(200);
  expect(
    await (await request("/ingest/feed-day", "POST", day)).json(),
  ).toMatchObject({ meta: { rowsWritten: 0 } });
  const draft = {
    day: day.day,
    lang: "en",
    bodyMd: "# Daily",
    picks: [paperId],
    radar: [],
    final: false,
  };
  expect((await request(`/digests/${day.day}`, "PUT", draft)).status).toBe(200);
  expect(
    await (await request(`/digests/${day.day}`, "PUT", draft)).json(),
  ).toMatchObject({ meta: { rowsWritten: 0 } });
  for (const path of [`/digests/${day.day}`, `/feed/days/${day.day}/digest`])
    expect(await (await request(path)).json()).toMatchObject({
      data: { bodyMd: "# Daily" },
    });
  const radar = {
    radar: [
      {
        day: day.day,
        paperId,
        level: "borrow",
        reason: "reuse",
        fullTextRead: false,
      },
    ],
  };
  expect((await request("/ingest/radar", "POST", radar)).status).toBe(200);
  expect(
    await (await request("/ingest/radar", "POST", radar)).json(),
  ).toMatchObject({ meta: { rowsWritten: 0 } });
  expect(
    (
      await request("/ingest/radar", "POST", {
        radar: Array(101).fill(radar.radar[0]),
      })
    ).status,
  ).toBe(413);
});
it("enforces ingest scope on every write including PUT digests and read on reads", async () => {
  for (const path of [
    "/ingest/papers",
    "/ingest/summaries",
    "/ingest/feed-day",
    "/ingest/radar",
    "/digests/2026-11-17",
  ]) {
    for (const scope of ["read", "write"] as const)
      expect(
        (
          await request(
            path,
            path.startsWith("/digests") ? "PUT" : "POST",
            {},
            scope,
          )
        ).status,
      ).toBe(403);
  }
  expect(
    (await request("/feed/days/2026-11-17", "GET", undefined, "ingest")).status,
  ).toBe(403);
  expect(
    (await request("/digests/2026-11-17", "GET", undefined, "ingest")).status,
  ).toBe(403);
});
