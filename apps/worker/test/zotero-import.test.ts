import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { writeEvidence } from "@litscout/db/test/evidence";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";
import { countingDb } from "./helpers/counting-db";
import type {
  ZoteroBatch,
  ZoteroEntry,
  ZoteroProgress,
} from "@litscout/pipeline/zotero-contracts";
import crossref from "./fixtures/library/crossref.json";

let h: Awaited<ReturnType<typeof databaseHarness>>;
let db: D1Database;
let env: ReturnType<typeof workerEnv>["env"];
const date = () => new Date().toISOString().slice(0, 10);
const measures: Record<string, { payloadRows: number; budgetRows: number }> =
  {};
const entry = (data: Partial<ZoteroEntry>): ZoteroEntry => ({
  authors: [],
  tags: [],
  ...data,
});

beforeAll(async () => {
  h = await databaseHarness("d1");
  db = countingDb(h.db.$client as unknown as D1Database).db;
  env = { ...workerEnv().env, LOCAL_DEV: "true", DB: db };
  await db.batch([
    db.prepare(
      "INSERT INTO papers(id,title,title_norm,authors,year,abstract) VALUES ('pap_existing','Existing DOI','existingdoi','[]',2024,'Stored abstract')",
    ),
    db.prepare(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_existing','doi','10.1000/existing')",
    ),
    db.prepare(
      "INSERT INTO papers(id,title,title_norm,authors,year) VALUES ('pap_title','A confirmed title','aconfirmedtitle','[{\"name\":\"Ana García\"}]',2020)",
    ),
    db.prepare(
      "INSERT INTO library_items(paper_id,tags,added_via,status) VALUES ('pap_existing','[\"personal\"]','web','read')",
    ),
  ]);
});

afterAll(async () => {
  await writeEvidence("m4c-zotero-write-cost.json", measures);
  await h.close();
});

async function request(batch: ZoteroBatch, expected = 200, token?: string) {
  const response = await app.request(
    "/api/v1/library/import",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(batch),
    },
    env,
  );
  const result = (await response.json()) as {
    data: ZoteroProgress;
    error: { code: string };
    meta: { rowsWritten: number; budgetRowsWritten: number };
  };
  expect(response.status, JSON.stringify(result)).toBe(expected);
  return result;
}

const batch = (
  hash: string,
  entries: ZoteroEntry[],
  options: Partial<ZoteroBatch> = {},
): ZoteroBatch => ({
  hash: hash.repeat(64),
  format: "bibtex",
  offset: 0,
  total: entries.length,
  entries,
  dryRun: false,
  ...options,
});

it("previews without writing, then links DOI and confirmed titles and saves file metadata", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("Unexpected metadata lookup");
  });
  vi.stubGlobal("fetch", fetch);
  const payload = batch("a", [
    entry({
      title: "Alternative title",
      doi: "10.1000/existing",
      tags: ["zotero/Reading"],
    }),
    entry({
      title: "A CONFIRMED title!",
      year: 2020,
      tags: ["zotero/confirmed"],
    }),
    entry({
      title: "A preprint",
      arxiv: "2401.00042",
      abstract: "From the export",
      venue: "Test venue",
    }),
    entry({ title: "Unmatched title" }),
  ]);
  const expected = {
    next: 4,
    new: 2,
    linked: 2,
    duplicates: 0,
    invalid: 0,
    unverified: 1,
  };
  expect((await request({ ...payload, dryRun: true })).data).toEqual(expected);
  expect(
    await db.prepare("SELECT count(*) AS n FROM sync_cursors").first("n"),
  ).toBe(0);
  expect(
    await db.prepare("SELECT count(*) AS n FROM daily_write_usage").first("n"),
  ).toBe(0);
  const result = await request(payload);
  expect(result.data).toEqual(expected);
  expect(fetch).not.toHaveBeenCalled();
  measures.mixedBatch = {
    payloadRows: result.meta.rowsWritten,
    budgetRows: result.meta.budgetRowsWritten,
  };
  expect(result.meta.rowsWritten).toBeGreaterThan(0);
  const use = await db
    .prepare(
      "SELECT rows_written,estimate_overrun,reserved FROM daily_write_usage WHERE day=?",
    )
    .bind(date())
    .first();
  expect(use).toMatchObject({
    rows_written: result.meta.rowsWritten + result.meta.budgetRowsWritten,
    estimate_overrun: 0,
    reserved: 0,
  });
  expect(
    await db
      .prepare("SELECT title,abstract FROM papers WHERE id='pap_existing'")
      .first(),
  ).toMatchObject({ title: "Existing DOI", abstract: "Stored abstract" });
  expect(
    await db
      .prepare(
        "SELECT tags,status FROM library_items WHERE paper_id='pap_existing'",
      )
      .first(),
  ).toMatchObject({
    tags: '["personal","zotero/Reading"]',
    status: "read",
  });
  expect(
    await db
      .prepare("SELECT tags FROM library_items WHERE paper_id='pap_title'")
      .first("tags"),
  ).toBe('["zotero/confirmed"]');
  expect(
    await db
      .prepare(
        "SELECT title,abstract,venue,verified FROM papers JOIN paper_ids ON id=paper_id WHERE scheme='arxiv' AND value='2401.00042'",
      )
      .first(),
  ).toMatchObject({
    title: "A preprint",
    abstract: "From the export",
    venue: "Test venue",
    verified: 1,
  });
  expect(
    await db
      .prepare("SELECT verified FROM papers WHERE title='Unmatched title'")
      .first("verified"),
  ).toBe(0);
  expect((await request(payload)).data).toEqual(expected);
  expect(await db.prepare("SELECT count(*) AS n FROM papers").first("n")).toBe(
    4,
  );
});

it("pre-checks the budget and resumes from the committed batch, including overlapping retries", async () => {
  const first = batch("b", [entry({ title: "Resume first" })], { total: 2 });
  const second = {
    ...first,
    offset: 1,
    entries: [entry({ title: "Resume second" })],
  };
  expect((await request(first)).data).toMatchObject({ next: 1, new: 1 });
  await db
    .prepare("UPDATE daily_write_usage SET rows_written=79999 WHERE day=?")
    .bind(date())
    .run();
  expect((await request(second, 429)).error.code).toBe("WRITE_BUDGET_EXCEEDED");
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM papers WHERE title='Resume second'")
      .first("n"),
  ).toBe(0);
  await db
    .prepare("UPDATE daily_write_usage SET rows_written=0 WHERE day=?")
    .bind(date())
    .run();
  expect(
    (
      await request({
        ...first,
        entries: [...first.entries, ...second.entries],
      })
    ).data.next,
  ).toBe(1);
  const [one, two] = await Promise.all([request(second), request(second)]);
  expect(one.data).toEqual(two.data);
  expect(one.data).toMatchObject({ next: 2, new: 2, unverified: 2 });
  expect((await request(first)).data.next).toBe(2);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE paper_id IN (SELECT id FROM papers WHERE title LIKE 'Resume %')",
      )
      .first("n"),
  ).toBe(2);
});

it("uses DOI and arXiv metadata lookups for records missing titles, with an offline fallback", async () => {
  const doi = crossref.message.DOI;
  const fetch = vi.fn(async (url: URL) => {
    if (url.hostname === "api.crossref.org") return Response.json(crossref);
    if (url.hostname === "arxiv.org" && url.pathname === "/abs/2401.00111")
      return new Response(
        '<head><meta name="citation_title" content="An arXiv record"></head>',
        {
          headers: { "content-type": "text/html" },
        },
      );
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  const result = await request(
    batch("c", [
      entry({ doi, abstract: "Preferred file abstract" }),
      entry({
        title: crossref.message.title[0],
        year: 2007,
        tags: ["zotero/Publications"],
      }),
      entry({ arxiv: "2401.00111" }),
      entry({ arxiv: "2401.00112" }),
    ]),
  );
  expect(result.data).toMatchObject({
    next: 4,
    new: 2,
    invalid: 1,
    duplicates: 1,
  });
  expect(fetch.mock.calls.map(([url]) => url.hostname)).toEqual([
    "api.crossref.org",
    "arxiv.org",
    "arxiv.org",
  ]);
  expect(
    await db
      .prepare(
        "SELECT title,abstract FROM papers JOIN paper_ids ON id=paper_id WHERE value=?",
      )
      .bind(doi)
      .first(),
  ).toMatchObject({
    title: crossref.message.title[0],
    abstract: "Preferred file abstract",
  });
  expect(
    await db
      .prepare(
        "SELECT title FROM papers JOIN paper_ids ON id=paper_id WHERE value='2401.00111'",
      )
      .first("title"),
  ).toBe("An arXiv record");
});

it("requires the library write scope and reports single-record D1 write costs", async () => {
  const token = "lsk_" + "Z".repeat(52);
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toString("hex");
  await db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_zotero','fixture',?,'[\"read\"]')",
    )
    .bind(hash)
    .run();
  await request(batch("d", [entry({ title: "Scope test" })]), 403, token);
  await db
    .prepare("DELETE FROM library_items WHERE paper_id='pap_title'")
    .run();
  for (const [name, payload] of [
    [
      "newDoi",
      batch("d", [entry({ title: "Cost new DOI", doi: "10.1000/new-cost" })]),
    ],
    ["newTitleOnly", batch("e", [entry({ title: "Cost title only" })])],
    [
      "newArxiv",
      batch("1", [entry({ title: "Cost new arXiv", arxiv: "2401.00119" })]),
    ],
    [
      "linkedFirstSave",
      batch("2", [
        entry({ title: "A confirmed title", authors: ["Ana Garcia"] }),
      ]),
    ],
    [
      "linkedWithTag",
      batch("f", [entry({ doi: "10.1000/existing", tags: ["zotero/cost"] })]),
    ],
    ["linkedNoChange", batch("0", [entry({ doi: "10.1000/existing" })])],
  ] as const) {
    const result = await request(payload);
    measures[name] = {
      payloadRows: result.meta.rowsWritten,
      budgetRows: result.meta.budgetRowsWritten,
    };
  }
});
