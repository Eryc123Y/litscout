import { paperSchema, type PaperInput } from "./contracts/index";

/** The fields of an arXiv listing row that become a paper input. */
export type ArxivListingRow = {
  id: string;
  title: string;
  summary?: string | null;
  authors: readonly unknown[];
  categories: readonly string[];
  abs: string;
  pdf: string;
  code_url?: string | null;
};

export const listingInput = (p: ArxivListingRow): PaperInput =>
  paperSchema.parse({
    key: p.id,
    title: p.title,
    abstract: p.summary || null,
    authors: p.authors,
    categories: p.categories,
    source: "arxiv",
    identifiers: [{ scheme: "arxiv", value: p.id }],
    links: [
      { kind: "landing", url: p.abs },
      { kind: "pdf_arxiv", url: p.pdf },
      ...(p.code_url ? [{ kind: "code", url: p.code_url }] : []),
    ],
  });
