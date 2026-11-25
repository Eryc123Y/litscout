import { z } from "zod";
import type { TriageQueue, TriageRow } from "@litscout/pipeline/web-contracts";
import type { IngestDatabase } from "./ingest-store";
import {
  codeLink,
  join,
  listRow,
  listSelection,
  stateJoin,
  visible,
} from "./bounded-read";
import { readDigest } from "./feed-read";

/** More than a morning's triage; a day's queue has stayed well under it. */
export const triageQueueMax = 120;

const storedDigest = z.object({
  picks: z.array(z.string()).catch([]),
  radar: z.array(z.object({ paperId: z.string() })).catch([]),
});

/**
 * The day's papers worth a decision: the brief's radar items and picks, then
 * the other papers on the reader's topics that link public code. The brief
 * decides the first two groups, so a day without one queues the code papers
 * only.
 */
export async function readTriageQueue(
  db: IngestDatabase,
  day: string,
  lang: string,
): Promise<TriageQueue> {
  const stored =
    (await readDigest(db, day, lang, "daily")) ??
    (await readDigest(db, day, lang === "zh" ? "en" : "zh", "daily"));
  const digest = storedDigest.safeParse(stored ?? {});
  const radar = (digest.data?.radar ?? []).map((item) => item.paperId);
  const picks = digest.data?.picks ?? [];
  const chosen = JSON.stringify([...new Set([...radar, ...picks])]);
  const [rows, waiting] = await Promise.all([
    db
      .prepare(
        `SELECT ${listSelection(false)},${codeLink} AS has_code ${join} ${stateJoin}
         WHERE f.day=?1 AND ${visible} AND (
           f.paper_id IN (SELECT value FROM json_each(?2))
           OR (f.shortlisted=1 AND ${codeLink}))
         ORDER BY f.paper_id IN (SELECT value FROM json_each(?2)) DESC,
           f.rank_sort,f.paper_id,f.source LIMIT ?3`,
      )
      .bind(day, chosen, triageQueueMax * 2)
      .all<Record<string, unknown>>(),
    db
      .prepare(
        "SELECT count(*) AS n FROM library_items WHERE user_id='u_owner' AND status='to_read' AND deleted_at IS NULL",
      )
      .first<{ n: number }>(),
  ]);
  // A paper listed under two sources that day is one decision.
  const byPaper = new Map<string, TriageRow>();
  const order = new Map(
    [...radar, ...picks]
      .reverse()
      .map((id, index, all) => [id, all.length - 1 - index]),
  );
  for (const row of rows.results) {
    const paper = listRow(row, false);
    if (byPaper.has(paper.paperId)) continue;
    byPaper.set(paper.paperId, {
      ...paper,
      reason: radar.includes(paper.paperId)
        ? "radar"
        : picks.includes(paper.paperId)
          ? "pick"
          : "code",
    });
  }
  // Radar first, then the picks in the brief's order, then code by rank.
  const items = [...byPaper.values()]
    .map((paper, rank) => ({ paper, rank }))
    .sort(
      (a, b) =>
        (order.get(a.paper.paperId) ?? Infinity) -
          (order.get(b.paper.paperId) ?? Infinity) || a.rank - b.rank,
    )
    .map(({ paper }) => paper)
    .slice(0, triageQueueMax);
  return { day, items, toRead: waiting?.n ?? 0 };
}
