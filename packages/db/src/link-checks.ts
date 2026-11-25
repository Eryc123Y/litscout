import { sql } from "drizzle-orm";
import {
  readDerivedArxivLinks,
  type ArxivLinkRecipe,
} from "@litscout/pipeline/legacy-links";
import type { z } from "zod";
import type { linkChecksInput } from "@litscout/pipeline/library-contracts";
import type { IngestDatabase } from "./ingest-store";
import { OWNER } from "./library";
import { first, rows, type Database } from "./database";

export function linksDue(db: Database, limit: number) {
  return rows<{ id: string; url: string }>(
    db,
    sql`
    SELECT l.id,l.url FROM paper_links l WHERE l.user_id=${OWNER}
    AND EXISTS(SELECT 1 FROM papers WHERE id=l.paper_id AND deleted_at IS NULL)
    ORDER BY l.checked_at,l.id LIMIT ${limit}`,
  );
}

export async function updateLinkChecks(
  db: IngestDatabase,
  checks: z.output<typeof linkChecksInput>["checks"],
) {
  const results = await db.batch(
    checks.map(({ id, url, httpStatus, checkedAt }) =>
      db
        .prepare(
          "UPDATE paper_links SET checked_at=?,http_status=? WHERE id=? AND url=? AND user_id=? AND (checked_at IS NULL OR checked_at<?)",
        )
        .bind(checkedAt, httpStatus, id, url, OWNER, checkedAt),
    ),
  );
  return {
    updated: results.reduce((n, result) => n + (result.meta.changes ?? 0), 0),
    rowsWritten: results.reduce(
      (n, result) => n + (result.meta.rows_written ?? 0),
      0,
    ),
  };
}

export async function preferredReadingLink(db: Database, paperId: string) {
  const stored = await first<{ kind: string; url: string }>(
    db,
    sql`
    SELECT kind,url FROM paper_links WHERE paper_id=${paperId} AND user_id=${OWNER}
      AND kind IN ('pdf_oa','pdf_arxiv','doi','landing')
    ORDER BY CASE kind WHEN 'pdf_oa' THEN 0 WHEN 'pdf_arxiv' THEN 1 WHEN 'doi' THEN 2 ELSE 3 END,
      http_status>=400, CASE source WHEN 'openalex' THEN 0 WHEN 'unpaywall' THEN 1 WHEN 'core' THEN 2 ELSE 3 END, id LIMIT 1`,
  );
  if (stored?.kind === "pdf_oa" || stored?.kind === "pdf_arxiv") return stored;
  const recipes = await first<{ derivedArxivLinks: ArxivLinkRecipe[] }>(
    db,
    sql`SELECT derived_arxiv_links FROM papers
    WHERE id=${paperId} AND deleted_at IS NULL`,
  );
  const pdf = readDerivedArxivLinks(recipes?.derivedArxivLinks).find(
    (link) => link.kind === "pdf_arxiv",
  );
  return pdf ? { kind: pdf.kind, url: pdf.url } : stored;
}
