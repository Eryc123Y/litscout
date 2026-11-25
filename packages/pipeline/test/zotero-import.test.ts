import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseZotero, groupZoteroEntries } from "../src/zotero-import";

const fixture = (name: string) =>
  readFileSync(new URL("./fixtures/zotero/" + name, import.meta.url), "utf8");

it("reads BibTeX fields, macros, braces and escapes, recovering at the next entry", () => {
  const parsed = parseZotero(fixture("tricky.bib"), "bibtex");
  expect(parsed.issues).toEqual([{ line: 17, message: expect.any(String) }]);
  expect(parsed.entries).toEqual([
    {
      title: "On Stereo & Depth",
      authors: ["García, Ana", "Research and Development Lab"],
      year: 2024,
      doi: "10.1000/vision",
      arxiv: "2401.00042",
      venue: "Proceedings of the Test Society",
      abstract: 'A quoted "term" and "literal" escape.',
      tags: [
        "zotero/vision",
        "zotero/depth, binocular",
        "zotero/Reading",
        "zotero/Stereo/Methods",
      ],
    },
    { title: "After the error", authors: [], year: 2020, tags: [] },
  ]);
});

it("validates each CSL item without discarding its valid neighbors", () => {
  const parsed = parseZotero(fixture("items.json"), "csl");
  expect(parsed.issues).toEqual([{ item: 2, message: expect.any(String) }]);
  expect(parsed.entries[0]).toEqual({
    title: "A Vision Study",
    authors: ["García, Ana", "Vision Lab"],
    year: 2024,
    doi: "10.1000/vision",
    url: "https://publisher.example/vision",
    venue: "Vision Journal",
    abstract: "The exported abstract.",
    tags: ["zotero/vision", "zotero/depth", "zotero/shelf", "zotero/Reading"],
  });
  expect(parsed.entries[1]).toEqual({
    title: "A title alone",
    authors: [],
    tags: [],
  });
  expect(() => parseZotero("{}", "csl")).toThrow(/array/i);
});

it("counts malformed entries towards the entry cap and rejects oversized UTF-8", () => {
  expect(() =>
    parseZotero(JSON.stringify(Array(5001).fill(null)), "csl"),
  ).toThrow(/5,000/);
  expect(() =>
    parseZotero("@article{x, title={T}}\n".repeat(5001), "bibtex"),
  ).toThrow(/5,000/);
  expect(() => parseZotero("é".repeat(2_621_441), "bibtex")).toThrow(/5 MB/);
});

it("deduplicates strong identifiers and confirmed titles, retaining labels and file abstracts", () => {
  const parsed = parseZotero(
    `
@article{one, title={A Vision Study}, doi={10.1000/vision}, author={Ana García}}
@article{two, title={Different formatting}, doi={10.1000/VISION}, keywords={extra}, abstract={File abstract}}
@article{three, title={A vision study!}, author={García, Ana}, groups={Reading}}
@article{four, title={A vision study!}, doi={10.1000/other}, author={García, Ana}}
@article{five, title={A Title Alone}}
@article{six, title={A title alone}}
  `,
    "bibtex",
  );
  const result = groupZoteroEntries(parsed.entries);
  expect(result.duplicates).toBe(3);
  expect(result.entries).toMatchObject([
    {
      doi: "10.1000/vision",
      abstract: "File abstract",
      tags: ["zotero/extra", "zotero/Reading"],
    },
    { doi: "10.1000/other" },
    { title: "A Title Alone" },
  ]);
});

it("reports an entry without an opener and ignores an inline comment", () => {
  const parsed = parseZotero(
    "@article{first, title={First}} % @article{ignore, title={Ignore}}\n" +
      "@article missing-a-brace\n" +
      "@article{last, title={Last}}\n",
    "bibtex",
  );
  expect(parsed.issues).toMatchObject([{ line: 2 }]);
  expect(parsed.entries.map((entry) => entry.title)).toEqual(["First", "Last"]);
});
