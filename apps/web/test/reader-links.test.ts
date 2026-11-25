import { expect, it } from "vitest";
import { chooseLinks, framablePdf } from "../src/PaperParts";

const pdfArxiv = { kind: "pdf_arxiv", url: "https://arxiv.org/pdf/2611.00001" };
const pdfOa = { kind: "pdf_oa", url: "https://journal.example/paper.pdf" };
const abs = { kind: "landing", url: "https://arxiv.org/abs/2611.00001" };
const alpha = {
  kind: "alphaxiv",
  url: "https://www.alphaxiv.org/abs/2611.00001",
};
const doi = { kind: "doi", url: "https://doi.org/10.1000/x" };
const landing = { kind: "landing", url: "https://journal.example/paper" };

it("offers one PDF and one other link, alphaXiv first", () => {
  expect(chooseLinks([abs, pdfArxiv, alpha])).toEqual({
    pdf: pdfArxiv,
    other: { ...alpha, label: "alphaXiv" },
  });
  // Without an alphaXiv link the publisher, then the arXiv page, takes its place.
  expect(chooseLinks([pdfOa, doi, landing]).other).toEqual({
    ...doi,
    label: "Publisher page",
  });
  expect(chooseLinks([abs, pdfArxiv]).other).toEqual({
    ...abs,
    label: "arXiv page",
  });
  expect(chooseLinks([pdfOa]).other).toBeUndefined();
});

it("prefers the arXiv PDF and falls back to the open-access copy", () => {
  expect(chooseLinks([pdfOa, pdfArxiv]).pdf).toEqual(pdfArxiv);
  expect(chooseLinks([pdfOa, doi]).pdf).toEqual(pdfOa);
});

it("says there is no open PDF and links the publisher instead", () => {
  expect(chooseLinks([doi])).toEqual({
    other: { ...doi, label: "Publisher page" },
    noPdf: true,
  });
  expect(chooseLinks([landing])).toEqual({
    other: { ...landing, label: "Landing page" },
    noPdf: true,
  });
  expect(chooseLinks([])).toEqual({ noPdf: true });
});

it("frames only PDFs served from https://arxiv.org", () => {
  expect(framablePdf(pdfArxiv)).toBe("https://arxiv.org/pdf/2611.00001");
  // The CSP allows https://arxiv.org alone; anything else opens a new tab.
  for (const url of [
    "http://arxiv.org/pdf/2611.00001",
    "https://export.arxiv.org/pdf/2611.00001",
    "https://arxiv.org.example/pdf/2611.00001",
  ])
    expect(framablePdf({ kind: "pdf_arxiv", url })).toBeUndefined();
  expect(framablePdf(pdfOa)).toBeUndefined();
  expect(framablePdf(undefined)).toBeUndefined();
});
