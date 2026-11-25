import { expect, it } from "vitest";
import {
  contracts,
  schemas,
  paperSchema,
  summarySchema,
  digestSchema,
} from "../src/contracts/index";
it("publishes JSON Schema for all input and output contracts", () => {
  const json = contracts();
  for (const key of Object.keys(schemas))
    expect(json[key]).toHaveProperty("$schema");
  expect(Object.keys(json).length).toBeGreaterThan(12);
});
it("validates paper metadata and rejects invalid dates, identifiers, limits and unknown keys", () => {
  const paper = {
    key: "2611.00001",
    title: "Stereo",
    authors: ["A"],
    source: "arxiv",
    identifiers: [{ scheme: "arxiv", value: "2611.00001" }],
  };
  expect(paperSchema.parse(paper).categories).toEqual([]);
  for (const value of [
    { ...paper, title: "" },
    { ...paper, publishedOn: "bad" },
    { ...paper, secret: true },
    { ...paper, identifiers: [] },
  ])
    expect(paperSchema.safeParse(value).success).toBe(false);
  expect(
    schemas.papers.safeParse({
      day: "2026-11-17",
      papers: Array(101).fill(paper),
    }).success,
  ).toBe(false);
  expect(
    schemas.summaries.safeParse({ summaries: Array(101).fill({}) }).success,
  ).toBe(false);
});
it("requires all five nonblank fields and checks radar full-text claims", () => {
  expect(
    summarySchema.safeParse({ paperId: "pap_test", content: { tldr: "one" } })
      .success,
  ).toBe(false);
  const draft = {
    day: "2026-11-17",
    topics: {},
    radar: [
      {
        paperId: "pap_one",
        level: "high",
        reason: "test",
        fullTextRead: false,
      },
    ],
  };
  expect(digestSchema.safeParse(draft).success).toBe(false);
  expect(
    digestSchema.safeParse({
      ...draft,
      radar: [{ ...draft.radar[0], fullTextRead: true }],
    }).success,
  ).toBe(true);
});
