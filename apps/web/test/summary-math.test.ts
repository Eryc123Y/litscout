// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { PaperSummary } from "../src/PaperParts";

afterEach(() => cleanup());

const paperWith = (content: Record<string, string>) =>
  ({
    paperId: "pap_a",
    title: "Bounds",
    abstract: "Abstract",
    authors: [],
    source: "arxiv",
    topics: [],
    shortlisted: false,
    summaries: [{ lang: "en", content }],
    identifiers: [],
    links: [],
    venue: null,
    venueKind: "preprint",
    year: 2026,
    publishedOn: null,
    categories: [],
    hfUpvotes: 0,
  }) as never;

it("renders inline TeX in a summary written after cutover", () => {
  render(
    createElement(PaperSummary, {
      paper: paperWith({
        tldr: "A regret bound of $O(d^{2})$ under $\\ell_2$ loss.",
        motivation: "Costs of $5 and $10 stay as written.",
        method: "Uses $\\alpha$-mixing.",
        result: "Plain result.",
        conclusion: "Plain conclusion.",
      }),
      language: "en",
    }),
  );
  const tldr = screen.getByText(/regret bound/);
  expect(tldr.textContent).toBe("A regret bound of O(d2) under ℓ2 loss.");
  expect(tldr.querySelector("sup")?.textContent).toBe("2");
  expect(tldr.querySelector("sub")?.textContent).toBe("2");
  expect(screen.getByText(/Costs of/).textContent).toBe(
    "Costs of $5 and $10 stay as written.",
  );
  expect(screen.getByText(/mixing/).textContent).toBe("Uses α-mixing.");
});

it("leaves today's plain-text summaries exactly as they are", () => {
  const plain = "Achieves O_tilde(d^{p/(2p+2)}) regret.";
  render(
    createElement(PaperSummary, {
      paper: paperWith({
        tldr: plain,
        motivation: "M",
        method: "Me",
        result: "R",
        conclusion: "C",
      }),
      language: "en",
    }),
  );
  expect(screen.getByText(plain).textContent).toBe(plain);
});
