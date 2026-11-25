import { sql, type SQL } from "drizzle-orm";

/** A live identifier takes precedence over copies in the compact index. */
export function identifierCandidates(scheme: "arxiv" | "doi", value: SQL) {
  const column = sql.identifier(scheme === "arxiv" ? "arxiv_id" : "doi");
  return sql`
    SELECT paper_id FROM paper_ids WHERE scheme=${scheme} AND value=(${value})
    UNION ALL
    SELECT paper_id FROM paper_index WHERE ${column}=(${value})
      AND NOT EXISTS(SELECT 1 FROM paper_ids WHERE scheme=${scheme} AND value=(${value}))
  `;
}
