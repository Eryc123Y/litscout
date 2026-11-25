import { expect, it } from "vitest";
import { author, paper } from "./fixtures";
import { parsePaperId } from "../src/ids";
import { authorRecordLine, paperLine, truncate } from "../src/format";
import { jaccard, nameKey, nameParts } from "../src/normalize";
import { features, mergeAuthors, pairScore } from "../src/merge";
import { dedupePapers } from "../src/dedupe";

it("handles empty names and disjoint or empty sets", () => {
  expect(nameParts("")).toEqual({ surname: "", given: [] });
  expect(nameKey("Surname")).toBe("Surname".toLowerCase());
  expect(jaccard(new Set(), new Set([1]))).toBe(0);
  expect(jaccard(new Set([1]), new Set())).toBe(0);
  expect(jaccard(new Set([1, 2]), new Set([2, 3]))).toBeCloseTo(1 / 3);
});
it("renders sparse records and long author lists without invented metadata", () => {
  expect(authorRecordLine(author("openalex", "A1", "Name"))).toBe(
    "OpenAlex A1: Name",
  );
  const p = paper("s2", "1", "Title", ["A", "B", "C", "D", "E", "F"], {
    openalexId: "W1",
  });
  expect(paperLine(p, 0)).toContain("+1 | W1");
  expect(paperLine(paper("arxiv", "x", "Title", []), 0)).not.toContain(" | ");
  expect(truncate("abcdefghij klmnop", 12)).toBe("abcdefghij…");
  expect(
    dedupePapers([
      paper("s2", "1", "Same long paper name", [], { citationCount: 2 }),
      paper("openalex", "2", "Same long paper name", []),
    ])[0]?.citationCount,
  ).toBe(2);
});
it.each([
  "",
  "arxiv:bad",
  "pmid:no",
  "pmcid:no",
  "openalex:no",
  "s2:no",
  "s2:123",
  "s2:" + "a".repeat(40),
  "openalex:W1",
])("accepts or rejects explicit identifiers: %s", (id) => {
  if (["s2:123", "s2:" + "a".repeat(40), "openalex:W1"].includes(id))
    expect(parsePaperId(id).value).toBeTruthy();
  else expect(() => parsePaperId(id)).toThrow();
});
it("scores incompatible names, coauthor tiers and partial affiliation overlap", () => {
  expect(
    pairScore(
      features(author("s2", "1", "A One")),
      features(author("s2", "2", "B Two")),
    ).score,
  ).toBe(0);
  for (const count of [1, 2, 4, 8]) {
    const names = Array.from({ length: count }, (_, i) => `Person Surname${i}`);
    const one = author("s2", "1", "Ada Lovelace", {
      affiliations: ["alpha beta"],
      papers: [paper("s2", "x", "Short", names)],
    });
    const two = author("openalex", "2", "A Lovelace", {
      affiliations: ["alpha gamma"],
      papers: [paper("openalex", "y", "Other", names)],
    });
    expect(pairScore(features(one), features(two)).score).toBeGreaterThan(0.15);
  }
  expect(
    mergeAuthors([
      author("s2", "1", "A One"),
      author("openalex", "2", "B Two"),
    ]),
  ).toHaveLength(2);
});
