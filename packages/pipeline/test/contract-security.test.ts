import { expect, it } from "vitest";
import {
  paperSchema,
  summarySchema,
  digestRecordSchema,
  contracts,
} from "../src/contracts/index";
import { renderDigest } from "../src/digest";
import { digestSchema } from "../src/contracts/index";
import {
  cursorValueSchema,
  boundedJson,
  httpUrlSchema,
} from "../src/contracts/limits";
const paper = {
  key: "p",
  title: "T",
  source: "arxiv",
  identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
};
it("S6 cursor values contain only bounded operational state", () => {
  const name = "legacy:" + "a".repeat(32);
  for (const value of [
    { name: "venue-feed", value: '{"since":"2026-11-17"}' },
    { name: "fulltext:2026-11-17", value: '["pap_one","pap_two"]' },
    { name, value: '{"offset":2,"version":2,"runId":"run_fixture"}' },
    { name, value: '{"offset":2,"runId":"run_fixture"}' },
  ])
    expect(cursorValueSchema.safeParse(value).success).toBe(true);
  for (const value of [
    { name, value: "broken" },
    { name, value: '{"offset":1,"private":"data"}' },
    { name: "venue-feed", value: '{"private":"data"}' },
    { name: "fulltext:2026-11-17", value: '["not-a-paper"]' },
    { name: "fulltext:2026-11-17", value: '["pap_a","pap_b","pap_c"]' },
  ])
    expect(cursorValueSchema.safeParse(value).success).toBe(false);
  expect(
    httpUrlSchema.safeParse("http://example.org/path%28safe%29").success,
  ).toBe(true);
  expect(
    boundedJson.safeParse({ a: { b: { c: { d: { e: { f: 1 } } } } } }).success,
  ).toBe(false);
});
it("S2 bounds paper metadata and every summary field", () => {
  for (const extra of [
    { title: "x".repeat(1001) },
    { abstract: "x".repeat(20001) },
    { authors: Array(501).fill("A") },
    { identifiers: Array(21).fill(paper.identifiers[0]) },
    { links: Array(21).fill({ kind: "code", url: "https://example.org" }) },
    { categories: Array(21).fill("c") },
    { topics: Array(51).fill("t") },
  ])
    expect(paperSchema.safeParse({ ...paper, ...extra }).success).toBe(false);
  const content = {
    tldr: "T",
    motivation: "M",
    method: "M",
    result: "R",
    conclusion: "C",
  };
  for (const key of Object.keys(content))
    expect(
      summarySchema.safeParse({
        paperId: "pap_p",
        content: { ...content, [key]: "x".repeat(5001) },
      }).success,
    ).toBe(false);
  expect(
    digestRecordSchema.safeParse({
      day: "2026-11-17",
      bodyMd: "x".repeat(200001),
    }).success,
  ).toBe(false);
});
it("S2 publishes finite string and array bounds throughout JSON Schema", () => {
  const missing: string[] = [];
  function visit(value: unknown, path: string) {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (
      row.type === "string" &&
      !row.enum &&
      row.const === undefined &&
      row.maxLength === undefined
    )
      missing.push(path + " string");
    if (row.type === "array" && row.maxItems === undefined)
      missing.push(path + " array");
    for (const [key, entry] of Object.entries(row))
      if (typeof entry === "object") visit(entry, path + "." + key);
  }
  visit(contracts(), "contracts");
  expect(missing).toEqual([]);
});
it("S3 accepts HTTP(S), rejects executable schemes and encodes unsafe destinations", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,attack",
    "file:///tmp/private",
  ])
    expect(
      paperSchema.safeParse({ ...paper, links: [{ kind: "code", url }] })
        .success,
    ).toBe(false);
  const draft = digestSchema.parse({
    day: "2026-11-17",
    other: [{ paperId: "p", gist: "gist" }],
  });
  const p = {
    paperId: "p",
    title: "T",
    abstract: "A",
    authors: [],
    source: "arxiv",
    topics: [],
    shortlisted: false,
    summaries: [],
    identifiers: [],
    links: [
      {
        kind: "code" as const,
        url: "javascript:alert(1)",
        licence: null,
        oaStatus: "unknown" as const,
      },
    ],
  };
  expect(() => renderDigest(draft, [p], [], "https://example.org")).toThrow();
  expect(() =>
    renderDigest(draft, [{ ...p, links: [] }], [], "javascript:alert(1)"),
  ).toThrow();
});

it("caps digest suggestion bodies at 4 KiB of UTF-8", () => {
  const draft = (bodyMd: string) => ({
    day: "2026-11-17",
    suggestions: [
      {
        kind: "new_idea",
        title: "Try it",
        bodyMd,
        ideaIds: [],
        projectIds: [],
        paperIds: ["pap_one"],
      },
    ],
  });
  expect(digestSchema.safeParse(draft("x".repeat(4096))).success).toBe(true);
  expect(digestSchema.safeParse(draft("x".repeat(4097))).success).toBe(false);
  expect(digestSchema.safeParse(draft("学".repeat(1366))).success).toBe(false);
});
