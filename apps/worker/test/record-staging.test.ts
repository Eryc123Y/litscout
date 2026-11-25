import { readFileSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import { securityWorker } from "./helpers/security-worker";
let local: Awaited<ReturnType<typeof securityWorker>>;
beforeAll(async () => {
  local = await securityWorker();
});
afterAll(async () => {
  await local?.worker.dispose();
});
const original = readFileSync(
  "packages/sync/test/fixtures/round3/data/2026-11-11.jsonl",
  "utf8",
)
  .trim()
  .split("\n")
  .map((row) => JSON.parse(row))
  .find((row) => row.id === "doi:10.46298/lmcs-22(4:18)2026");
const recordedPaper = () => ({
  key: original.id,
  title: original.title,
  authors: original.authors,
  source: original.source,
  venue: original.venue,
  venueKind: "journal",
  publishedOn: original.published,
  identifiers: [{ scheme: "doi", value: original.doi }],
  links: [{ kind: "landing", url: original.url }],
});
let paperId: string;
it("T3 each ingest chunk reports skipped rows and keeps the valid real DOI record", async () => {
  const good = recordedPaper(),
    bad = {
      ...good,
      key: "bad-scheme",
      links: [{ kind: "landing", url: "javascript:alert(1)" }],
    };
  const response = await local.call("/ingest/papers", "POST", {
    day: "2026-11-17",
    papers: [bad, good],
  });
  expect(response.status).toBe(200);
  const data = (await response.json()) as {
    data: {
      papers: { paperId: string }[];
      accepted: number;
      skipped: number;
      invalid: unknown[];
    };
  };
  paperId = data.data.papers[0]!.paperId;
  expect(data.data).toMatchObject({
    accepted: 1,
    skipped: 1,
    invalid: [{ day: "2026-11-17", id: "bad-scheme", field: "links.0.url" }],
  });
  expect(
    (
      await local.call("/ingest/papers", "POST", {
        day: "2026-11-17",
        papers: Array(101).fill(good),
      })
    ).status,
  ).toBe(413);
});
it("T3 malformed DOI identifiers cannot roll back valid records in the same chunk", async () => {
  const good = {
    ...recordedPaper(),
    key: "new-valid",
    identifiers: [{ scheme: "doi", value: "10.1234/real-batch-guard" }],
  };
  const response = await local.call("/ingest/papers", "POST", {
    day: "2026-11-17",
    papers: [
      {
        ...good,
        key: "invalid-doi",
        identifiers: [{ scheme: "doi", value: "not-a-doi" }],
      },
      good,
    ],
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      accepted: 1,
      skipped: 1,
      invalid: [{ id: "invalid-doi", field: "identifiers.0.value" }],
    },
  });
});
it("T3 summaries and radar skip malformed or missing references without aborting valid rows", async () => {
  const summary = {
    paperId,
    content: {
      tldr: "One",
      motivation: "Two",
      method: "Three",
      result: "Four",
      conclusion: "Five",
    },
  };
  const response = await local.call("/ingest/summaries", "POST", {
    day: "2026-11-17",
    summaries: [
      { ...summary, paperId: "pap_missing" },
      summary,
      { paperId: "pap_invalid", content: { tldr: "Incomplete" } },
    ],
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { accepted: 1, skipped: 2 },
  });
  expect(
    await (
      await local.call("/ingest/radar", "POST", {
        radar: [
          { day: "2026-11-17", paperId, level: "borrow", reason: "Useful" },
          {
            day: "2026-11-17",
            paperId,
            level: "borrow",
            reason: "Missing project",
            projectId: "missing",
          },
        ],
      })
    ).json(),
  ).toMatchObject({ data: { accepted: 1, skipped: 1 } });
});
