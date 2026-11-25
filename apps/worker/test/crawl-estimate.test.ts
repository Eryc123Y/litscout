import { createHash } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { databaseHarness } from "@litscout/db/test/harness";
import {
  crawlWriteEstimate,
  measuredWriteEstimate,
} from "@litscout/pipeline/write-reservation";
import { app } from "../src/app";
import { workerEnv } from "./helpers/worker-env";

const env = workerEnv().env;
const token = "lsk_" + "I".repeat(52);
const harnesses: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()));
});

async function instance() {
  const harness = await databaseHarness("d1");
  harnesses.push(harness);
  const db = harness.db.$client as unknown as D1Database;
  await db
    .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
    .bind(
      "tok_i",
      "ingest",
      createHash("sha256").update(token).digest("hex"),
      '["ingest"]',
    )
    .run();
  return async (day: string, papers: object[]) => {
    const response = await app.request(
      "/api/v1/ingest/papers",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ day, papers }),
      },
      { ...env, DB: db },
    );
    const body = (await response.json()) as { meta?: { rowsWritten?: number } };
    if (response.status !== 200)
      throw new Error(response.status + " " + JSON.stringify(body));
    return {
      actual: body.meta?.rowsWritten ?? 0,
      server: measuredWriteEstimate("/ingest/papers", { day, papers }),
      crawl: crawlWriteEstimate("/ingest/papers", { day, papers }),
    };
  };
}

const words = (stem: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${stem}${i}`).join(" ");
const arxiv = (i: number, extra: object = {}) => ({
  key: `2611.${10000 + i}`,
  title: `Paper ${i} ` + words(`t${i}w`, 12),
  abstract: words(`a${i}w`, 180),
  authors: Array.from({ length: 5 }, (_, a) => `Author ${i}-${a}`),
  source: "arxiv",
  categories: ["cs.CV", "cs.LG"],
  identifiers: [{ scheme: "arxiv", value: `2611.${10000 + i}` }],
  topics: i % 2 ? ["Vision", "Learning"] : ["Vision"],
  shortlisted: i % 3 === 0,
  ...extra,
});
const venue = (i: number) => ({
  key: `10.1000/jmlr.${i}`,
  title: `Venue paper ${i} ` + words(`v${i}w`, 10),
  abstract: words(`b${i}w`, 150),
  authors: ["A", "B"],
  venue: "Journal of Machine Learning Research",
  venueKind: "journal",
  year: 2026,
  source: "jmlr",
  identifiers: [{ scheme: "doi", value: `10.1000/jmlr.${i}` }],
  links: [
    { kind: "landing", url: `https://jmlr.example/${i}` },
    { kind: "pdf_oa", url: `https://jmlr.example/${i}.pdf` },
  ],
  topics: ["Learning"],
});
const range = (from: number, n: number) =>
  Array.from({ length: n }, (_, k) => from + k);
const day = "2026-11-18";
const next = "2026-11-19";
type Measured = { actual: number; server: number; crawl: number };
/**
 * The Worker's estimate must cover every request: writing more than it costs
 * the day 5,000 rows of its limit. The crawl plan only has to cover a batch,
 * without asking for much more on common shapes.
 */
const covers = (shape: string, measured: Measured, most?: number) => {
  expect(measured.actual, shape).toBeLessThanOrEqual(measured.server);
  expect(measured.actual, shape).toBeLessThanOrEqual(measured.crawl);
  if (most !== undefined)
    expect(measured.crawl, shape).toBeLessThanOrEqual(
      Math.ceil(most * measured.actual),
    );
};
/** A single-paper request, as adaptive batching sends near the budget's end. */
const single = (shape: string, measured: Measured) =>
  expect(measured.actual, shape).toBeLessThanOrEqual(measured.server);

// 2026-11-19: the crawl estimate charged at least 37 rows a paper, set before
// arXiv links were derived instead of stored, and refused the 11-19 crawl
// (22,520 estimated, 18,414 available). Measured here: about 18.5 rows a new
// paper plus 2 per identifier, 3 per link and 1 per topic.
it("estimates a crawl's writes from measured D1 rows for each shape", async () => {
  let post = await instance();
  covers(
    "new arXiv, fresh day",
    await post(
      day,
      range(0, 20).map((i) => arxiv(i)),
    ),
    1.4,
  );
  covers(
    "new arXiv, existing day",
    await post(
      day,
      range(20, 20).map((i) => arxiv(i)),
    ),
    1.4,
  );
  covers(
    "venue with DOI and two links",
    await post(day, range(0, 20).map(venue)),
    1.4,
  );
  covers(
    "listed again on a new day",
    await post(
      next,
      range(0, 20).map((i) => arxiv(i)),
    ),
  );
  covers(
    "HF signal update",
    await post(
      next,
      range(0, 20).map((i) => arxiv(i, { hfUpvotes: 30 + i, rankInSource: i })),
    ),
  );
  post = await instance();
  await post(
    day,
    range(0, 20).map((i) => arxiv(i, { abstract: null })),
  );
  covers(
    "abstract gained",
    await post(
      day,
      range(0, 20).map((i) => arxiv(i)),
    ),
  );
  const worst = (i: number) =>
    arxiv(i, {
      identifiers: [
        { scheme: "arxiv", value: `2611.${10000 + i}` },
        ...range(0, 19).map((k) => ({
          scheme: "doi",
          value: `10.2000/w${i}.${k}`,
        })),
      ],
      links: range(0, 20).map((k) => ({
        kind: "landing",
        url: `https://w.example/${i}/${k}`,
      })),
      topics: range(0, 50).map((k) => `Topic ${k}`),
      shortlisted: true,
    });
  covers("worst case", await post(day, range(100, 5).map(worst)), 1.4);
  post = await instance();
  single(
    "one new paper, fresh day",
    await post(day, [arxiv(200, { shortlisted: true })]),
  );
  single("one new paper, two topics", await post(day, [arxiv(201)]));
  single("one venue paper", await post(day, [venue(202)]));
  single("one paper on a new day", await post(next, [arxiv(201)]));
}, 120_000);
