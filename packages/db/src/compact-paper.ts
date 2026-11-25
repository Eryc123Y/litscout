import type { IngestDatabase } from "./ingest-store";

export type CompactPaper = {
  paperId: string;
  arxivId: string | null;
  doi: string | null;
  day: string;
  title: string;
  titleNorm: string | null;
  topics: string;
  venue: string | null;
};

export const compactFields = `paper_id AS paperId,arxiv_id AS arxivId,doi,day,title,
  title_norm AS titleNorm,topics,venue`;
export const compactIdentifiers = (
  paper: Pick<CompactPaper, "arxivId" | "doi">,
) => [
  ...(paper.arxivId
    ? [{ scheme: "arxiv" as const, value: paper.arxivId }]
    : []),
  ...(paper.doi ? [{ scheme: "doi" as const, value: paper.doi }] : []),
];

export function getCompactPaper(db: IngestDatabase, id: string) {
  return db
    .prepare(
      `SELECT ${compactFields} FROM paper_index
    WHERE paper_id=? AND has_canonical=0`,
    )
    .bind(id)
    .first<CompactPaper>();
}

export async function compactPaperId(
  db: IngestDatabase,
  value: string,
  scheme?: string,
) {
  if (scheme && scheme !== "arxiv" && scheme !== "doi") return null;
  const by =
    scheme === "arxiv"
      ? "arxiv_id=?1"
      : scheme === "doi"
        ? "doi=?1"
        : "(arxiv_id=?1 OR doi=?1)";
  return db
    .prepare(
      `SELECT paper_id FROM paper_index WHERE ${by} AND has_canonical=0
    ORDER BY (arxiv_id=?1) DESC,day,paper_id LIMIT 1`,
    )
    .bind(value)
    .first<string>("paper_id");
}
