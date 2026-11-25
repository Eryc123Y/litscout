// @vitest-environment jsdom
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { rowLead } from "../src/FeedParts";
import { PaperSummary } from "../src/PaperParts";

const row = {
  abstract: undefined,
  tldr: [] as { lang: "en" | "zh"; text: string }[],
};

it("tells a paper without an abstract apart from a pending summary in the list", () => {
  expect(rowLead({ ...row, hasAbstract: false }, "en", false)).toBe(
    "No abstract, so no summary",
  );
  expect(rowLead({ ...row, hasAbstract: true }, "en", false)).toBe(
    "Summary pending",
  );
  // Rows from older Workers carry no flag; keep the previous wording.
  expect(rowLead(row, "en", false)).toBe("Summary pending");
  expect(
    rowLead(
      { ...row, hasAbstract: true, tldr: [{ lang: "en", text: "TLDR" }] },
      "en",
      false,
    ),
  ).toBe("TLDR");
  expect(rowLead({ ...row, abstract: "Text" }, "en", true)).toBe("Text");
});

it("explains a missing summary on a paper without an abstract", () => {
  const paper = {
    paperId: "pap_x",
    title: "No abstract",
    abstract: null,
    authors: [],
    source: "crossref",
    topics: [],
    shortlisted: false,
    summaries: [],
    identifiers: [],
    links: [],
    venue: null,
    venueKind: "journal",
    year: null,
    publishedOn: null,
    categories: [],
    hfUpvotes: null,
  };
  render(createElement(PaperSummary, { paper, language: "en" }));
  expect(
    screen.getByText(
      "No summary: LitScout summarises from the abstract, and this paper has none.",
    ),
  ).toBeTruthy();
  render(
    createElement(PaperSummary, {
      paper: { ...paper, abstract: "Some text" },
      language: "en",
    }),
  );
  expect(
    screen.getByText("Summary pending. The abstract is available below."),
  ).toBeTruthy();
});
