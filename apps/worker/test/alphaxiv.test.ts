import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { databaseHarness } from "@litscout/db/test/harness";
import { libraryPageSchema } from "@litscout/pipeline/library-contracts";
import { mirrorState } from "@litscout/pipeline/alphaxiv-contracts";
import { app } from "../src/app";
import { registerLibraryTools } from "../src/mcp-library";
import { countingDb } from "./helpers/counting-db";
import { workerEnv } from "./helpers/worker-env";

const initial = { takenAt: "2026-11-18T10:00:00.000Z", digest: "a".repeat(64) };
const later = { takenAt: "2026-11-19T10:00:00.000Z", digest: "b".repeat(64) };
const folder = {
  id: "10000000-0000-4000-8000-000000000001",
  path: "FYP / Depth",
  type: "default-completed",
};
const shared = {
  paperId: "2611.00001",
  paperType: "public",
  title: "Mirrored stereo paper",
  folders: [folder],
  status: "read",
  publicationDate: "2026-11-18",
  annotation: { highlightCount: 4, hasNotes: true },
};
const upload = {
  paperId: "upload_7",
  paperType: "private",
  title: "Private stereo draft",
  folders: [folder],
  status: "read",
};
const fetched = {
  ...shared,
  paperId: "2611.00002",
  title: "Another stereo paper",
  metadata: {
    title: "arXiv title",
    abstract: "Original abstract",
    authors: [{ name: "Ada Author" }],
    publicationDate: "2026-11-17",
  },
};
const offline = {
  ...shared,
  paperId: "2611.00003",
  title: "Offline stereo paper",
  annotation: null,
};
const path = "/ingest/alphaxiv";
let close: () => Promise<void>;
let meter: ReturnType<typeof countingDb>;
let env: ReturnType<typeof workerEnv>["env"];

beforeEach(async () => {
  const h = await databaseHarness("d1");
  close = h.close;
  meter = countingDb(h.db.$client as unknown as D1Database);
  env = {
    ...workerEnv().env,
    LOCAL_DEV: "true",
    PUBLIC_FEED: "true",
    DB: meter.db,
  };
  await meter.db.batch([
    meter.db.prepare(
      "INSERT INTO papers(id,title,title_norm) VALUES ('pap_shared','Original title','original title')",
    ),
    meter.db.prepare(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_shared','arxiv','2611.00001')",
    ),
  ]);
});
afterEach(async () => {
  await close?.();
});

async function request(
  route: string,
  input?: unknown,
  status = 200,
  bindings = env,
  authorization?: string,
) {
  meter.reset();
  const response = await app.request(
    "/api/v1" + route,
    {
      method: input === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
    bindings,
  );
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(status);
  expect(meter.stats().calls).toBeLessThanOrEqual(40);
  expect(meter.stats().maxParams).toBeLessThanOrEqual(100);
  return z
    .object({
      data: z.unknown().optional(),
      meta: z
        .object({
          rowsWritten: z.number().optional(),
          budgetRowsWritten: z.number().optional(),
        })
        .optional(),
    })
    .parse(result);
}

const library = async (query = "") =>
  libraryPageSchema.parse((await request("/library" + query)).data);
const accepted = z.object({ accepted: z.number() });
async function seedMirror() {
  await request("/library", { paperId: "pap_shared" });
  await request(path + "/start", initial);
  return request(path, {
    ...initial,
    items: [shared, upload, fetched, offline],
  });
}

it("imports through budgeted ingest, merges origins, and exposes private uploads only as title and link", async () => {
  const result = await seedMirror();
  await request(
    path,
    { ...initial, items: Array.from({ length: 41 }, () => upload) },
    413,
  );
  await request(
    path,
    { ...initial, items: [{ ...upload, metadata: fetched.metadata }] },
    400,
  );
  expect(accepted.parse(result.data).accepted).toBe(4);
  expect(result.meta?.rowsWritten).toBeGreaterThan(0);
  expect(result.meta?.budgetRowsWritten).toBeGreaterThan(0);
  const repeated = await request(path, {
    ...initial,
    items: [shared, upload, fetched, offline],
  });
  expect(repeated.meta?.rowsWritten).toBe(0);
  await request(path + "/finish", initial);
  expect(
    (await request(path + "/known?id=" + shared.paperId + "&id=2611.11111"))
      .data,
  ).toEqual([shared.paperId]);
  expect(mirrorState.parse((await request(path)).data).items).toHaveLength(4);

  const raw = (await request("/library?limit=100&origin=alphaxiv")).data;
  const data = libraryPageSchema.parse(raw);
  expect(data.alphaXiv).toMatchObject({
    syncedAt: initial.takenAt,
    folders: [{ id: folder.id, path: folder.path }],
  });
  expect(data.items).toHaveLength(4);
  expect(
    data.items.find((row) => "paperId" in row && row.paperId === "pap_shared"),
  ).toMatchObject({
    title: shared.title,
    origin: ["litscout", "alphaxiv"],
    status: "saved",
    alphaXiv: {
      status: "read",
      hasNotes: true,
      highlightCount: 4,
      folders: [{ id: folder.id, path: folder.path }],
    },
  });
  const rawRows = z
    .object({ items: z.array(z.looseObject({ title: z.string() })) })
    .parse(raw).items;
  expect(rawRows.find((row) => row.title === upload.title)).toEqual({
    title: upload.title,
    origin: ["alphaxiv-private"],
    link: {
      kind: "alphaxiv",
      url: "https://www.alphaxiv.org/private/upload_7",
    },
  });
  expect(
    data.items.find((row: { title: string }) => row.title === fetched.title),
  ).toMatchObject({
    status: "read",
    rev: null,
    authors: [{ name: "Ada Author" }],
    year: 2026,
  });
  expect(
    data.items.find((row: { title: string }) => row.title === offline.title),
  ).toMatchObject({
    status: "read",
    authors: [],
    year: 2026,
  });
  expect(
    await meter.db
      .prepare("SELECT count(*) AS count FROM papers")
      .first("count"),
  ).toBe(3);
  expect(
    await meter.db
      .prepare("SELECT count(*) AS count FROM feed_items")
      .first("count"),
  ).toBe(0);
  expect(
    await meter.db
      .prepare("SELECT count(*) AS count FROM notes")
      .first("count"),
  ).toBe(0);

  const paged = [];
  for (let cursor: string | null = ""; paged.length < 4;) {
    const page = await library(
      "?limit=1&cursor=" + encodeURIComponent(cursor ?? ""),
    );
    paged.push(...page.items.map(({ title }) => title));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(new Set(paged)).toEqual(
    new Set([shared.title, upload.title, fetched.title, offline.title]),
  );
  expect((await library("?origin=litscout")).items).toHaveLength(1);

  const registerTool = vi.fn();
  registerLibraryTools({ registerTool } as never, env, {
    read: true,
    write: false,
    identity: "test",
  });
  const search = registerTool.mock.calls.find(
    ([name]) => name === "search_library",
  )![2];
  const reply = await search({ q: "stereo", origin: "alphaxiv" });
  expect(JSON.parse(reply.content[0].text).result.items).toHaveLength(4);
  const get = registerTool.mock.calls.find(
    ([name]) => name === "get_paper",
  )![2];
  expect(
    (
      await get({
        ids: "https://www.alphaxiv.org/private/upload_7",
        full: true,
      })
    ).isError,
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();

  await request("/library", undefined, 503, { ...env, LOCAL_DEV: "false" });
  const token = "lsk_" + "R".repeat(52);
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toString("hex");
  await meter.db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_reader','test',?,'[\"read\"]')",
    )
    .bind(hash)
    .run();
  await request(path, undefined, 403, env, "Bearer " + token);
});

it("blocks stale writes, hides removed rows, and advances sync time only on completion", async () => {
  await seedMirror();
  await request(path + "/finish", initial);
  const interrupted = {
    takenAt: "2026-11-18T18:00:00.000Z",
    digest: "c".repeat(64),
  };
  await request(path + "/start", interrupted);
  await request(path + "/start", later);
  expect(
    (await request(path, { ...interrupted, items: [upload] })).data,
  ).toEqual({ accepted: 0 });
  await request(path, {
    ...later,
    items: [
      { ...shared, folders: [] },
      { ...upload, folders: [] },
    ],
  });
  expect((await library()).alphaXiv?.syncedAt).toBe(initial.takenAt);
  expect((await request(path + "/finish", interrupted)).data).toEqual({
    applied: false,
    completed: false,
    missingMetadata: 1,
  });
  await request(path + "/finish", later);
  expect(await library()).toMatchObject({
    alphaXiv: { syncedAt: later.takenAt },
    items: expect.arrayContaining([
      expect.objectContaining({
        title: "Original title",
        origin: ["litscout"],
      }),
    ]),
  });
  expect((await library("?origin=alphaxiv")).items).toHaveLength(2);
  const removed = await meter.db
    .prepare("SELECT count(*) FROM alphaxiv_items WHERE removed_at=?")
    .bind(later.takenAt)
    .first("count(*)");
  expect(removed).toBe(2);
});

it("enriches the existing fallback paper and leaves already known records intact", async () => {
  await seedMirror();
  const paper = async (id: string) =>
    meter.db
      .prepare(
        "SELECT p.id,p.source,p.abstract,p.title,p.authors FROM papers p JOIN paper_ids i ON i.paper_id=p.id WHERE i.scheme='arxiv' AND i.value=?",
      )
      .bind(id)
      .first();
  const original = await paper(offline.paperId);
  expect(original).toMatchObject({ source: "alphaxiv", abstract: null });
  const state = z.object({ pendingMetadata: z.array(z.string()) });
  expect(state.parse((await request(path)).data).pendingMetadata).toContain(
    offline.paperId,
  );
  expect((await request(path + "/known?id=" + offline.paperId)).data).toEqual(
    [],
  );
  await request(path + "/finish", initial);
  await request(path + "/start", later);
  const metadata = {
    title: "arXiv recovered",
    authors: [{ name: "Alice Example" }],
    abstract: "Recovered abstract",
  };
  await request(path, {
    ...later,
    items: [
      { ...offline, metadata },
      { ...shared, metadata },
    ],
  });
  expect(await paper(offline.paperId)).toMatchObject({
    id: original?.id,
    source: "arxiv",
    title: metadata.title,
    abstract: metadata.abstract,
    authors: JSON.stringify(metadata.authors),
  });
  expect(await paper(shared.paperId)).toMatchObject({
    title: "Original title",
    abstract: null,
  });
  expect((await request(path + "/known?id=" + offline.paperId)).data).toEqual([
    offline.paperId,
  ]);
  expect(state.parse((await request(path)).data).pendingMetadata).not.toContain(
    offline.paperId,
  );
  expect((await request(path + "/finish", later)).data).toMatchObject({
    completed: true,
    missingMetadata: 0,
  });
});

it("updates and removes mirror rows with missing identifiers without duplicating or blocking other papers", async () => {
  await seedMirror();
  await request(path + "/finish", initial);
  await meter.db
    .prepare("DELETE FROM paper_ids WHERE scheme='arxiv' AND value IN (?,?)")
    .bind(shared.paperId, offline.paperId)
    .run();
  await request(path + "/start", later);
  await request(path, {
    ...later,
    items: [
      { ...shared, title: "Changed title" },
      { ...offline, folders: [] },
      { ...upload, title: "Changed draft" },
    ],
  });
  expect(
    await meter.db
      .prepare("SELECT paper_id,title FROM alphaxiv_items WHERE alphaxiv_id=?")
      .bind(shared.paperId)
      .first(),
  ).toEqual({ paper_id: "pap_shared", title: "Changed title" });
  expect(
    await meter.db
      .prepare("SELECT removed_at FROM alphaxiv_items WHERE alphaxiv_id=?")
      .bind(offline.paperId)
      .first("removed_at"),
  ).toBe(later.takenAt);
  expect(
    await meter.db.prepare("SELECT count(*) FROM papers").first("count(*)"),
  ).toBe(3);
  expect((await library("?q=Changed")).items.map((row) => row.title)).toEqual(
    expect.arrayContaining(["Changed title", "Changed draft"]),
  );
});

it("excludes private folders from facets and folder matches", async () => {
  const secret = {
    id: "10000000-0000-4000-8000-000000000009",
    path: "Private collection",
    type: "custom",
  };
  const publicFolder = {
    id: "10000000-0000-4000-8000-000000000008",
    path: "Other public folder",
    type: "custom",
  };
  const privateUpload = {
    ...upload,
    folders: [secret, { ...folder, path: "Unlisted private label" }],
  };
  const aliasId = "2611.10001";
  await meter.db
    .prepare(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_shared','arxiv',?)",
    )
    .bind(aliasId)
    .run();
  await request(path + "/start", initial);
  await request(path, {
    ...initial,
    items: [
      shared,
      privateUpload,
      {
        ...shared,
        paperId: aliasId,
        title: "Alias title",
        folders: [publicFolder, folder],
        annotation: null,
      },
    ],
  });
  const page = await library("?origin=alphaxiv");
  const paths = [
    { id: folder.id, path: folder.path },
    { id: publicFolder.id, path: publicFolder.path },
  ];
  expect(page.alphaXiv?.folders).toEqual(paths);
  expect(page.items).toHaveLength(2);
  expect(page.items.find((item) => item.title === shared.title)).toMatchObject({
    alphaXiv: { folders: paths },
  });
  expect((await library("?folder=" + secret.id)).items).toEqual([]);
  expect(
    (await library("?folder=" + folder.id)).items.map((item) => item.title),
  ).toEqual([shared.title]);
});
