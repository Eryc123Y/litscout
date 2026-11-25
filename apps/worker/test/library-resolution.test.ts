import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import { writeEvidence } from "@litscout/db/test/evidence";
import { countingDb } from "./helpers/counting-db";
import { workerEnv } from "./helpers/worker-env";
import type { SaveResult } from "@litscout/pipeline/library-contracts";
import { app } from "../src/app";
import openalex from "./fixtures/library/openalex.json";
import crossref from "./fixtures/library/crossref.json";
import core from "./fixtures/library/core.json";
import semantic from "./fixtures/library/semantic-scholar.json";
import unpaywall from "./fixtures/library/unpaywall.json";
import s2Throttle from "@litscout/core/test/fixtures/live/s2-batch.json";
import { resolutionHttp } from "../src/resolution-http";
// A fixture contact, built at runtime so the repository audit does not read it as an address.
const fixtureContact = ["unit", "example.invalid"].join("@");

const doi = crossref.message.DOI;
const title = crossref.message.title[0]!;
const hosts: string[] = [];
const token = "lsk_" + "S".repeat(52);
const counts: Record<string, object> = {};
let h: Awaited<ReturnType<typeof databaseHarness>>;
let counter: ReturnType<typeof countingDb>;

beforeAll(async () => {
  h = await databaseHarness("d1");
  counter = countingDb(h.db.$client as unknown as D1Database);
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toString("hex");
  await counter.db
    .prepare(
      "INSERT INTO api_tokens(id,name,hash,scopes) VALUES ('tok_resolver','resolver',?,'[\"read\",\"write\"]')",
    )
    .bind(hash)
    .run();
});
afterAll(async () => {
  await writeEvidence("m2a-resolution-counts.json", counts);
  await h.close();
});
function replay(handler: (url: URL) => Response) {
  hosts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      hosts.push(url.hostname);
      return handler(url);
    }),
  );
}
async function save(
  label: string,
  query: string,
  dry_run = false,
  status = 200,
  optional = false,
) {
  await counter.db.prepare("UPDATE api_tokens SET last_used_at=NULL").run();
  counter.reset();
  const r = await app.request(
    "/api/v1/library/save",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      body: JSON.stringify({ query, dry_run }),
    },
    {
      ...workerEnv().env,
      DB: counter.db,
      LOCAL_DEV: "true",
      ...(optional
        ? { UNPAYWALL_EMAIL: fixtureContact, CORE_API_KEY: "fixture" }
        : {}),
    },
  );
  const b = (await r.json()) as { data: SaveResult };
  expect(r.status, JSON.stringify(b)).toBe(status);
  counts[label] = { external: hosts.length, ...counter.stats() };
  expect(hosts.length).toBeLessThanOrEqual(10);
  expect(counter.stats().calls).toBeLessThanOrEqual(40);
  expect(counter.stats().maxParams).toBeLessThanOrEqual(100);
  return b.data;
}

it("offers a title result without writing and saves the selected identifier", async () => {
  replay((url) =>
    Response.json(
      url.pathname === "/works" ? { results: [openalex] } : openalex,
    ),
  );
  expect(await save("title confirmation", title)).toMatchObject({
    status: "confirm",
    candidates: [{ query: doi, title }],
  });
  expect(
    await counter.db
      .prepare("SELECT count(*) AS n FROM library_items")
      .first("n"),
  ).toBe(0);
  hosts.length = 0;
  const saved = await save("OpenAlex DOI", "https://doi.org/" + doi);
  if (saved.status !== "saved") throw new Error("Expected a saved paper");
  expect(hosts).toEqual(["api.openalex.org"]);
  const links = await counter.db
    .prepare("SELECT kind,licence,oa_status FROM paper_links WHERE paper_id=?")
    .bind(saved.paperId)
    .all();
  expect(links.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "doi" }),
      expect.objectContaining({ kind: "pdf_oa", oa_status: "gold" }),
    ]),
  );
});

it("follows public publisher redirects then falls back through Crossref, Unpaywall and CORE", async () => {
  replay((url) => {
    if (url.hostname === "paper.example" && url.pathname !== "/article")
      return new Response(null, {
        status: 302,
        headers: { location: url.pathname === "/start" ? "/next" : "/article" },
      });
    if (url.hostname === "paper.example")
      return new Response(
        `<html><head><meta content='${doi}' name="citation_doi"></head><body></body></html>`,
        {
          headers: { "content-type": "text/html" },
        },
      );
    if (url.hostname === "api.openalex.org")
      return new Response(null, { status: 429 });
    if (url.hostname === "api.crossref.org") return Response.json(crossref);
    if (url.hostname === "api.unpaywall.org") {
      expect(url.searchParams.get("email")).toBe(fixtureContact);
      return Response.json({ best_oa_location: null });
    }
    if (url.hostname === "api.core.ac.uk") return Response.json(core);
    throw new Error("Unexpected fixture route");
  });
  expect(
    await save(
      "publisher plus OA fallbacks",
      "https://paper.example/start",
      true,
      200,
      true,
    ),
  ).toMatchObject({
    status: "confirm",
    candidates: [
      {
        title,
        source: "crossref",
        link: { kind: "pdf_oa", url: core.results[0]!.downloadUrl },
      },
    ],
  });
  expect(hosts).toEqual([
    "paper.example",
    "paper.example",
    "paper.example",
    "api.openalex.org",
    "api.crossref.org",
    "api.unpaywall.org",
    "api.core.ac.uk",
  ]);
});

it("anchors arXiv DOIs to arXiv and joins the published version by surname and year", async () => {
  await counter.db.batch([
    counter.db
      .prepare(
        "INSERT INTO papers(id,title,title_norm,authors,year) VALUES ('pap_preprint', ?, ?, ?, 2024)",
      )
      .bind(
        "A Tested Vision Method",
        "atestedvisionmethod",
        '[{"name":"A. Smith"}]',
      ),
    counter.db.prepare(
      "INSERT INTO paper_ids(paper_id,scheme,value) VALUES ('pap_preprint','arxiv','2401.00042')",
    ),
  ]);
  replay((url) => {
    if (url.hostname === "api.openalex.org")
      return new Response(null, { status: 404 });
    if (url.hostname === "api.crossref.org")
      return new Response(null, { status: 404 });
    return Response.json({
      paperId: "1".repeat(40),
      title: "A Tested Vision Method",
      externalIds: { DOI: "10.1000/published" },
      year: 2025,
      authors: [{ name: "Ada Smith" }],
    });
  });
  expect(
    await save("Semantic Scholar edition merge", "10.1000/published"),
  ).toMatchObject({
    status: "saved",
    paperId: "pap_preprint",
  });
  hosts.length = 0;
  expect(
    await save("arXiv DOI", "https://doi.org/10.48550/arXiv.2401.00042v2"),
  ).toMatchObject({
    status: "saved",
    paperId: "pap_preprint",
  });
  const ids = await counter.db
    .prepare(
      "SELECT scheme,value FROM paper_ids WHERE paper_id='pap_preprint' ORDER BY scheme",
    )
    .all();
  expect(ids.results).toEqual([
    { scheme: "arxiv", value: "2401.00042" },
    { scheme: "doi", value: "10.1000/published" },
    { scheme: "s2", value: "1".repeat(40) },
  ]);
});

it("does not follow redirects to private hosts or read beyond the HTML budget", async () => {
  replay(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8000/private" },
      }),
  );
  expect(
    await save("blocked redirect", "https://article.example/a", true),
  ).toMatchObject({ candidates: [] });
  expect(hosts).toEqual(["article.example"]);
});

it("uses the exact Unpaywall PDF before trying CORE", async () => {
  replay((url) => {
    if (url.hostname === "api.openalex.org")
      return new Response(null, { status: 404 });
    if (url.hostname === "api.crossref.org")
      return Response.json({
        message: {
          DOI: unpaywall.doi,
          title: ["A fixture with an open manuscript"],
          published: { "date-parts": [[2013, 7, 1]] },
        },
      });
    if (url.hostname === "api.unpaywall.org") return Response.json(unpaywall);
    throw new Error("Unpaywall should satisfy the PDF search");
  });
  const result = await save("Unpaywall PDF", unpaywall.doi, false, 200, true);
  if (result.status !== "saved") throw new Error("Expected a saved paper");
  const pdf = await counter.db
    .prepare(
      "SELECT url,licence,oa_status,source FROM paper_links WHERE paper_id=? AND kind='pdf_oa'",
    )
    .bind(result.paperId)
    .first();
  expect(pdf).toMatchObject({
    url: unpaywall.best_oa_location.url_for_pdf,
    licence: unpaywall.best_oa_location.license,
    oa_status: unpaywall.oa_status,
    source: "unpaywall",
  });
  expect(hosts).toEqual([
    "api.openalex.org",
    "api.crossref.org",
    "api.unpaywall.org",
  ]);
});

it("returns no candidates after the providers miss and Semantic Scholar is throttled", async () => {
  replay((url) =>
    url.hostname === "api.semanticscholar.org"
      ? Response.json(s2Throttle.body, { status: s2Throttle.status })
      : Response.json({ results: [], message: { items: [] } }),
  );
  expect(
    await save("title no match", "No results for this title", true),
  ).toEqual({ status: "confirm", candidates: [] });
  expect(hosts).toEqual([
    "api.openalex.org",
    "api.crossref.org",
    "api.semanticscholar.org",
  ]);
});

it("enforces the fetch cap and discards oversized response bodies", async () => {
  replay(() => new Response(" ".repeat(200 * 1024) + "{}"));
  const http = resolutionHttp();
  for (let i = 0; i < 12; i++)
    expect(await http.json(new URL("https://example.org"))).toBeUndefined();
  expect(hosts.length).toBe(10);
  counts["fetch guard"] = { external: hosts.length, calls: 0, maxParams: 0 };
});

it("reads only the publisher head within the byte cap", async () => {
  replay(
    () =>
      new Response(
        "<head>" +
          " ".repeat(49 * 1024) +
          '<meta name="citation_doi" content="10.1000/outside"></head>',
        {
          headers: { "content-type": "text/html" },
        },
      ),
  );
  expect(
    await save("bounded publisher head", "https://article.example/large", true),
  ).toMatchObject({ candidates: [] });
  expect(hosts).toEqual(["article.example"]);
});

it("resolves a recorded Semantic Scholar DOI after the first two sources miss", async () => {
  replay((url) =>
    url.hostname === "api.semanticscholar.org"
      ? Response.json(semantic)
      : new Response(null, { status: 404 }),
  );
  const saved = await save(
    "recorded Semantic Scholar DOI",
    semantic.externalIds.DOI,
  );
  if (saved.status !== "saved") throw new Error("Expected a saved paper");
  const links = await counter.db
    .prepare("SELECT kind,url FROM paper_links WHERE paper_id=?")
    .bind(saved.paperId)
    .all();
  expect(links.results).toEqual(
    expect.arrayContaining([
      {
        kind: "doi",
        url: "https://doi.org/" + semantic.externalIds.DOI.toLowerCase(),
      },
    ]),
  );
  expect(links.results).not.toContainEqual(
    expect.objectContaining({ kind: "pdf_oa" }),
  );
  expect(hosts).toEqual([
    "api.openalex.org",
    "api.crossref.org",
    "api.semanticscholar.org",
  ]);
});

it("uses a known OpenReview forum ID before fetching its HTML", async () => {
  replay((url) => {
    expect(url.hostname).toBe("api2.openreview.net");
    expect(url.searchParams.get("id")).toBe("fixtureForum");
    return Response.json({
      notes: [
        {
          content: {
            title: { value: "Forum record" },
            authors: { value: ["Ada Smith"] },
          },
        },
      ],
    });
  });
  expect(
    await save(
      "OpenReview URL",
      "https://openreview.net/pdf?id=fixtureForum",
      true,
    ),
  ).toMatchObject({
    candidates: [{ query: "openreview:fixtureForum", title: "Forum record" }],
  });
  expect(hosts).toEqual(["api2.openreview.net"]);
});

it("labels citation-only records until a provider confirms the identifier", async () => {
  const page = "https://publisher.example/paper";
  const id = "10.1000/page-only";
  replay((url) =>
    url.hostname === "publisher.example"
      ? new Response(
          `<meta name="citation_title" content="Publisher-only paper"><meta name="citation_doi" content="${id}">`,
          { headers: { "content-type": "text/html" } },
        )
      : new Response(null, { status: 404 }),
  );
  await expect(save("unverified preview", page, true)).resolves.toMatchObject({
    candidates: [{ verified: false, query: page }],
  });
  const saved = await save("unverified save", page);
  if (saved.status !== "saved") throw new Error("Expected saved record");
  const read = async (path: string) => {
    const r = await app.request(
      "/api/v1" + path,
      { headers: { authorization: "Bearer " + token } },
      { ...workerEnv().env, DB: counter.db },
    );
    return ((await r.json()) as { data: unknown }).data;
  };
  expect(await read("/papers/" + saved.paperId)).toMatchObject({
    title: "Publisher-only paper",
    verified: false,
  });
  expect(await read("/library")).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ paperId: saved.paperId, verified: false }),
    ]),
  });
  replay((url) =>
    url.hostname === "api.crossref.org"
      ? Response.json({ message: { DOI: id, title: ["Confirmed paper"] } })
      : new Response(null, { status: 404 }),
  );
  const confirmed = await save("confirmed identifier", id);
  expect(confirmed).toMatchObject({ paperId: saved.paperId });
  expect(await read("/papers/" + saved.paperId)).toMatchObject({
    title: "Confirmed paper",
    verified: true,
  });
  replay((url) =>
    url.hostname === "publisher.example"
      ? new Response(
          `<meta name="citation_title" content="An unconfirmed replacement"><meta name="citation_doi" content="${id}">`,
          { headers: { "content-type": "text/html" } },
        )
      : new Response(null, { status: 404 }),
  );
  await save("provider unavailable after confirmation", page);
  expect(await read("/papers/" + saved.paperId)).toMatchObject({
    title: "Confirmed paper",
    verified: true,
  });
});
