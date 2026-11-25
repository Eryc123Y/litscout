import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { keywordMatches, topicsFor, importTopics } from "../src/topics";
import { dedupe } from "../src/dedupe";
import { nextStatus } from "../src/status";
const cases = JSON.parse(
  readFileSync(
    new URL("./fixtures/keyword-cases.json", import.meta.url),
    "utf8",
  ),
) as { keyword: string; text: string; matches: boolean }[];
for (const c of cases)
  it(`${c.keyword}: ${c.text}`, () =>
    expect(keywordMatches(c.text, c.keyword)).toBe(c.matches));
it("matches title, abstract and TLDR in topic order; empty terms match nothing", () => {
  expect(
    topicsFor({ title: "a", summary: "depth", AI: { tldr: "Lean" } }, [
      { name: "proof", keywords: ["Lean"] },
      { name: "vision", keywords: ["depth"] },
    ]),
  ).toEqual(["proof", "vision"]);
  expect(keywordMatches("a", " ")).toBe(false);
  expect(
    importTopics(
      "const TOPICS = [{name: 'Vision', keywords: ['depth', '2D-to-3D']}];",
    ),
  ).toEqual([{ name: "Vision", keywords: ["depth", "2D-to-3D"] }]);
  expect(() => importTopics("broken")).toThrow();
});
it("matches all Python dedupe golden cases including fuzzy matches and gained abstracts", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL("./fixtures/dedupe.golden.json", import.meta.url),
      "utf8",
    ),
  );
  for (const c of cases)
    expect(dedupe(c.existing, c.batch, c.lacking)).toEqual(c.expected);
});
it("reproduces the old topics and shortlist on five recorded weekdays and imports every preset", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/five-days.golden.json", import.meta.url),
      "utf8",
    ),
  );
  const js = readFileSync(
    new URL("./fixtures/interest-presets.js.txt", import.meta.url),
    "utf8",
  );
  expect(importTopics(js)).toEqual(fixture.topics);
  for (const day of fixture.days)
    expect(
      day.papers.map((p: { id: string; title: string; summary: string }) => ({
        id: p.id,
        topics: topicsFor(p, fixture.topics),
      })),
    ).toEqual(day.expected);
});
it("day status advances monotonically, with pending and empty retryable", () => {
  expect(nextStatus("crawled", "pending")).toBe("crawled");
  expect(nextStatus("pending", "empty")).toBe("empty");
  expect(nextStatus("empty", "crawled")).toBe("crawled");
  expect(nextStatus("final", "crawled")).toBe("final");
});
