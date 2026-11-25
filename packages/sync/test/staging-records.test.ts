import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { planLegacy } from "../src/legacy";
import { legacyPaper } from "../src/legacy-records";
import { httpUrlSchema } from "@litscout/pipeline/contracts/limits";
import { importTrace } from "../src/import-trace";
const files = Object.fromEntries(
  ["2026-11-10", "2026-11-11", "2026-11-12"].map((day) => [
    `data/${day}.jsonl`,
    readFileSync(
      new URL(`./fixtures/round3/data/${day}.jsonl`, import.meta.url),
      "utf8",
    ),
  ]),
);
const rows = (file: string) =>
  files[file]!.trim()
    .split("\n")
    .map((s) => JSON.parse(s));
it("T3 malformed JSONL, incomplete summaries, run logs and digest files are isolated and counted", () => {
  const sample = rows("data/2026-11-10.jsonl").slice(0, 500),
    raw = sample.map((p) => JSON.stringify(p)).join("\n");
  const plan = planLegacy(
    {
      "data/2026-11-10.jsonl": raw,
      "data/2026-11-10_AI_enhanced_English.jsonl": JSON.stringify(sample[0]),
      "logs/summary-runs.jsonl":
        '{"date":"2026-11-10","path":"crawl","at":"invalid"}',
    },
    { "digests/2026-11-10.md": "" },
    { from: "2026-11-10", to: "2026-11-10" },
  );
  expect(plan.days[0]).toMatchObject({ skipped: 3, totalRecords: 503 });
  expect(plan.invalid.map((issue) => issue.field)).toEqual(
    expect.arrayContaining(["AI", "at", "bodyMd"]),
  );
  const broken = planLegacy(
    { "data/2026-11-10.jsonl": "not-json\n" + raw },
    {},
    { from: "2026-11-10", to: "2026-11-10" },
  );
  expect(broken.invalid[0]).toMatchObject({
    day: "2026-11-10",
    id: "row:1",
    field: "$",
    reason: "Invalid JSON record",
  });
});
it("T3 upload responses are traced per chunk and a server-side skip still enforces the daily threshold", async () => {
  const plan = planLegacy(files, {}, { from: "2026-11-10", to: "2026-11-12" });
  const invalid = {
    day: "2026-11-10",
    id: "rejected",
    field: "title",
    reason: "Invalid title",
  };
  const api = {
    get: async () => null,
    write: async () => ({ accepted: 99, skipped: 1, invalid: [invalid] }),
  };
  const traced = importTrace(plan, api);
  await traced.api.write(
    "/ingest/papers",
    { day: "2026-11-10", papers: [] },
    1,
  );
  expect(traced.chunks[0]).toMatchObject({
    day: "2026-11-10",
    accepted: 99,
    skipped: 1,
    invalid: [invalid],
  });
  const smaller = { ...plan, days: [{ ...plan.days[0]!, totalRecords: 50 }] };
  await expect(
    importTrace(smaller, api).api.write(
      "/ingest/papers",
      { day: "2026-11-10", papers: [] },
      1,
    ),
  ).rejects.toThrow(/1%/);
  await expect(
    importTrace(smaller, api).api.write("/ingest/radar", { radar: [] }, 1),
  ).rejects.toThrow(/1%/);
});
it("T3 imports the three real days including the LMCS DOI that aborted staging", () => {
  const plan = planLegacy(files, {}, { from: "2026-11-10", to: "2026-11-12" });
  expect(plan.days.map((d) => [d.day, d.papers.length])).toEqual([
    ["2026-11-10", 1124],
    ["2026-11-11", 838],
    ["2026-11-12", 418],
  ]);
  const paper = plan.days[1]!.papers.find(
    (p) => p.key === "doi:10.46298/lmcs-22(4:18)2026",
  )!;
  expect(paper.links[0]!.url).toBe(
    "https://doi.org/10.46298/lmcs-22%284:18%292026",
  );
});
it("T3 normalises unsafe destination characters without changing schemes or double-encoding", () => {
  const original = rows("data/2026-11-11.jsonl").find(
    (p) => p.id === "doi:10.46298/lmcs-22(4:18)2026",
  );
  const expected = legacyPaper(original).links[0]!.url;
  expect(httpUrlSchema.parse(expected)).toBe(expected);
  expect(
    httpUrlSchema.parse("https://publisher.example/a b<(26)>[file].pdf"),
  ).toBe("https://publisher.example/a%20b%3C%2826%29%3E%5Bfile%5D.pdf");
  for (const url of [
    "javascript:alert(1)",
    "file:///private",
    "data:text/plain,secret",
  ])
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
});
it("T3 skips a bad record and reports its day/id/field, but fails above 1%", () => {
  const raw = rows("data/2026-11-10.jsonl");
  const bad = {
    ...raw[0],
    url: "javascript:alert(1)",
    abs: "javascript:alert(1)",
  };
  const plan = planLegacy(
    {
      "data/2026-11-10.jsonl": [bad, ...raw.slice(1)]
        .map((p) => JSON.stringify(p))
        .join("\n"),
    },
    {},
    { from: "2026-11-10", to: "2026-11-10" },
  );
  expect(plan.days[0]!.papers).toHaveLength(1123);
  expect(plan.invalid).toContainEqual(
    expect.objectContaining({
      day: "2026-11-10",
      id: bad.id,
      field: expect.stringContaining("links.0.url"),
      reason: expect.any(String),
    }),
  );
  expect(() =>
    planLegacy(
      {
        "data/2026-11-10.jsonl": [bad, ...raw.slice(1, 50)]
          .map((p) => JSON.stringify(p))
          .join("\n"),
      },
      {},
      { from: "2026-11-10", to: "2026-11-10" },
    ),
  ).toThrow(/1%/);
  expect(() =>
    planLegacy(
      {
        "data/2026-11-10.jsonl": [bad, ...raw.slice(1, 100)]
          .map((p) => JSON.stringify(p))
          .join("\n"),
      },
      {},
      { from: "2026-11-10", to: "2026-11-10" },
    ),
  ).not.toThrow();
});
