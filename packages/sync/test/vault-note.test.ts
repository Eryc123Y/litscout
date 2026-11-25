import { expect, it } from "vitest";
import {
  editFrontmatter,
  editStatus,
  managedBlock,
  parseNote,
  putBlock,
} from "../src/vault-note";

const arxiv = "2406.09415";
const note = (header: string) => "---\n" + header + "\n---\nBody\n";

it.each([
  ["quoted", 'status: "seed" # keep', 'status: "parked" # keep'],
  ["plain", "status: seed # keep", "status: parked # keep"],
  ["string tag", "status: !!str seed", "status: !!str parked"],
  ["empty", "status: # keep", 'status: "parked" # keep'],
  ["missing", "other: yes", 'other: yes\nstatus: "parked"'],
  ["flow", "{ other: yes }", '{ other: yes, status: "parked" }'],
  ["empty flow", "{}", '{ status: "parked"}'],
  [
    "flow trailing comma",
    "{ other: yes, }",
    '{ other: yes, status: "parked" }',
  ],
  ["unchanged", "status: parked # keep", "status: parked # keep"],
])(
  "keeps the %s status layout and surrounding bytes",
  (_variant, before, after) => {
    expect(editStatus(note(before), "parked")).toBe(note(after));
  },
);

it("inserts frontmatter without changing the BOM or body", () => {
  expect(editStatus("\uFEFFBody\r\n", "parked")).toBe(
    '\uFEFF---\r\nstatus: "parked"\r\n---\r\nBody\r\n',
  );
  expect(() => editStatus(note("status: !!int 1"), "parked")).toThrow();
  expect(() => editStatus(note("status: |\n  seed"), "parked")).toThrow(
    "formatting",
  );
  expect(() => parseNote(note("[not, a, mapping]"))).toThrow("mapping");
  expect(() => parseNote("---\nstatus: seed\n")).toThrow("closing delimiter");
});

it.each([
  ["empty inline", "papers: []", 'papers: ["2406.09415"]'],
  [
    "inline with trailing comma",
    "papers: ['10.1000/source', ]",
    "papers: ['10.1000/source', \"2406.09415\" ]",
  ],
  ["empty field", "papers: # reserved", 'papers: ["2406.09415"] # reserved'],
  ["new field", "status: seed", 'status: seed\npapers: ["2406.09415"]'],
  [
    "comments",
    "papers: [\n  '10.1000/source' # source\n]",
    "papers: [\n  '10.1000/source', # source\n  \"2406.09415\"\n]",
  ],
  [
    "comments and comma",
    "papers: [\n  '10.1000/source', # source\n]",
    "papers: [\n  '10.1000/source', # source\n  \"2406.09415\"\n]",
  ],
  [
    "canonical duplicate",
    "papers: ['arXiv:2406.09415v2']",
    "papers: ['arXiv:2406.09415v2']",
  ],
])(
  "extends a %s papers list without reformatting other content",
  (_variant, before, after) => {
    const edited = editFrontmatter(note(before), "papers", arxiv);
    expect(edited).toBe(note(after));
    expect(parseNote(edited).body).toBe("Body\n");
  },
);

it("leaves unsupported list formatting alone", () => {
  for (const value of [
    "papers: lone",
    "papers: [\n  { ref: key } ]",
    "papers:\n  - { ref: key }",
  ])
    expect(() => editFrontmatter(note(value), "papers", arxiv)).toThrow(
      "formatting",
    );
});

it.each([
  "<!-- litscout:begin -->",
  "<!-- litscout:end -->",
  "<!-- litscout:end -->\n<!-- litscout:begin -->",
  "<!-- litscout:begin -->\n<!-- litscout:end -->",
  "<!-- litscout:begin -->\n<!-- litscout:begin -->\n<!-- litscout:end -->",
])("refuses to replace a damaged or unowned managed block", (text) => {
  expect(() => putBlock(text, "Replacement")).toThrow("edited by hand");
});

it("updates one owned block and preserves its surroundings exactly", () => {
  const ownersText = "Before\r\n\r\nAfter";
  const built = putBlock(
    ownersText,
    "first\nsecond",
    ownersText.indexOf("After"),
  );
  expect(managedBlock(built)?.content).toBe("first\r\nsecond");
  const next = putBlock(built, "third");
  expect(next).toContain("Before\r\n");
  expect(next).toMatch(/\r\nAfter$/);
  expect(managedBlock(next)?.content).toBe("third");
  expect(putBlock(next, "third")).toBe(next);
});
