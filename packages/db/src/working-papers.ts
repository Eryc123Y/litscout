import { sql } from "drizzle-orm";
import type { z } from "zod";
import type {
  workingPaper,
  workingPaperDetail,
} from "@litscout/pipeline/research-contracts";
import { shiftDay } from "@litscout/pipeline/daily";
import { first, rows, type Database } from "./database";
import { identifierNotePath } from "./vault-reads";

type WorkingPaper = z.output<typeof workingPaper>;
type Detail = z.output<typeof workingPaperDetail>;
const workingPapers = sql`
  SELECT w.id,w.title,n.path,w.status,p.title AS project_title
  FROM working_paper_index w JOIN vault_notes n ON n.id=w.vault_note_id
  LEFT JOIN projects p ON p.id=w.project_id AND p.deleted_at IS NULL
`;
export function listWorkingPapers(db: Database, after: string, limit: number) {
  return rows<WorkingPaper>(
    db,
    sql`${workingPapers} WHERE w.id>${after} ORDER BY w.id LIMIT ${limit}`,
  );
}
const paperIdeas = (id: string) => sql`
  SELECT i.id,i.title,n.path,i.description,i.paper_ids,CAST(ref.key AS INTEGER) AS position
  FROM working_paper_index w, json_each(w.idea_ids) ref
  JOIN idea_index i ON i.id=ref.value JOIN vault_notes n ON n.id=i.vault_note_id
  WHERE w.id=${id}
`;
const pendingReading = (id: string) => sql`
  SELECT json_extract(payload,'$.paperId') AS id FROM vault_requests
  WHERE target_note_id=${id} AND kind='add_reading' AND state='queued'
`;
const readingRefs = (id: string) => sql`
  SELECT ref.value AS id, NULL AS idea_id, -1 AS idea_position, CAST(ref.key AS INTEGER) AS paper_position
  FROM working_paper_index w, json_each(w.paper_ids) ref WHERE w.id=${id}
  UNION ALL SELECT ref.value,i.id,i.position,CAST(ref.key AS INTEGER)
  FROM (${paperIdeas(id)}) i,json_each(i.paper_ids) ref
  UNION ALL SELECT id,NULL,100,0 FROM (${pendingReading(id)})
`;
const readingLimit = 200;
// Each day of the week gets its own share, so a busy day cannot crowd out
// the rest of the week: up to 20 per day by shortlist and rank, 140 in all.
const recentPerDay = 20;
const recentCandidateLimit = 7 * recentPerDay;
type ReadingRow = Omit<Detail["reading"][number], "pending"> & {
  pending: number;
  total: number;
};
async function readingList(db: Database, id: string) {
  const reading = await rows<ReadingRow>(
    db,
    sql`
    WITH pending AS (${pendingReading(id)}), grouped AS (
      SELECT id,min(idea_position*100 + paper_position) AS position,
        json_group_array(DISTINCT idea_id ORDER BY idea_position) FILTER (WHERE idea_id IS NOT NULL) AS idea_ids
      FROM (${readingRefs(id)}) GROUP BY id
    ), page AS (
      SELECT g.*,coalesce(p.title,idx.title) AS title,count(*) OVER () AS total
      FROM grouped g LEFT JOIN papers p ON p.id=g.id AND p.deleted_at IS NULL
      LEFT JOIN paper_index idx ON idx.paper_id=g.id
      WHERE coalesce(p.title,idx.title) IS NOT NULL
      ORDER BY g.position,g.id LIMIT ${readingLimit}
    )
    SELECT g.id,g.title,g.idea_ids,g.total,
      coalesce(l.status,(SELECT a.status FROM alphaxiv_items a WHERE a.paper_id=g.id
        AND a.user_id='u_owner' AND a.removed_at IS NULL ORDER BY
        CASE a.status WHEN 'read' THEN 0 WHEN 'reading' THEN 1 ELSE 2 END LIMIT 1)) AS status,
      (${identifierNotePath(sql`g.id`)}) AS vault_path,
      EXISTS(SELECT 1 FROM pending WHERE id=g.id) AS pending
    FROM page g LEFT JOIN library_items l ON l.user_id='u_owner' AND l.paper_id=g.id AND l.deleted_at IS NULL
    ORDER BY g.position,g.id`,
  );
  return {
    reading: reading.map(({ total: _, pending, ...item }) => ({
      ...item,
      pending: Boolean(pending),
    })),
    readingMore: (reading[0]?.total ?? 0) - reading.length,
  };
}

type Idea = Detail["ideas"][number] & {
  description: string | null;
  paperIds: string[];
};
const stopWords = new Set([
  "about",
  "also",
  "based",
  "from",
  "into",
  "paper",
  "study",
  "that",
  "their",
  "these",
  "this",
  "using",
  "with",
]);
const words = (text: string) =>
  (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{4,}/gu) ?? []
  ).filter((word) => !stopWords.has(word));
type Candidate = Omit<Detail["recent"][number], "pending"> & {
  abstract: string | null;
};

function scoreRelatedPapers(
  candidates: Candidate[],
  keywords: Set<string>,
  linkedTopics: Set<string>,
) {
  const matchedWords = (text: string) =>
    new Set(words(text).filter((word) => keywords.has(word))).size;
  const scored = candidates
    .map(({ abstract, ...candidate }) => ({
      candidate,
      abstract,
      score:
        matchedWords(candidate.title + " " + candidate.topics.join(" ")) +
        3 *
          candidate.topics.filter((topic) =>
            linkedTopics.has(topic.toLowerCase()),
          ).length,
      tieBreak: undefined as number | undefined,
    }))
    .filter(({ score }) => score > 0);
  const tieBreak = (entry: (typeof scored)[number]) =>
    (entry.tieBreak ??= matchedWords(entry.abstract?.slice(0, 600) ?? ""));
  scored.sort((a, b) => b.score - a.score || tieBreak(b) - tieBreak(a));
  const unique = new Map<string, Detail["recent"][number]>();
  for (const { candidate } of scored) {
    if (!unique.has(candidate.id))
      unique.set(candidate.id, { ...candidate, pending: false });
    if (unique.size === 8) break;
  }
  return [...unique.values()];
}

async function relatedReading(
  db: Database,
  id: string,
  day: string,
  ideas: Idea[],
) {
  if (!ideas.length) return [];
  const keywords = new Set(
    ideas.flatMap(({ title, description }) =>
      words(title + " " + (description ?? "")),
    ),
  );
  const linkedIds = [...new Set(ideas.flatMap((idea) => idea.paperIds))];
  const topics = await rows<{ topic: string }>(
    db,
    sql`
    SELECT DISTINCT t.value AS topic
    FROM json_each(${JSON.stringify(linkedIds)}) ids
    CROSS JOIN feed_items f ON f.paper_id=ids.value, json_each(f.topics) t
    UNION
    SELECT DISTINCT t.value FROM json_each(${JSON.stringify(linkedIds)}) ids
    CROSS JOIN paper_index p ON p.paper_id=ids.value, json_each(p.topics) t
  `,
  );
  // The week in two statements run together instead of seven in a row:
  // each collects the papers this draft already reads once, then lets each
  // day take its share from the feed index (which supplies the full sort
  // order within a day). D1 allows five terms in a compound SELECT, so the
  // seven days go as four and three.
  const dayShare = (offset: number) => sql`
      SELECT * FROM (
        SELECT f.paper_id AS id,p.title,f.day,f.source,f.topics,
          substr(p.abstract,1,600) AS abstract,f.shortlisted,f.rank_sort
        FROM feed_items f INDEXED BY feed_items_keyword_read_order
        JOIN papers p ON p.id=f.paper_id AND p.deleted_at IS NULL
        WHERE f.day=${shiftDay(day, -offset)}
          AND f.paper_id NOT IN (SELECT id FROM reading)
        ORDER BY f.shortlisted DESC,f.rank_sort,f.paper_id,f.source
        LIMIT ${recentPerDay}
      )`;
  const days = (offsets: number[]) =>
    rows<Candidate>(
      db,
      sql`
    WITH reading AS MATERIALIZED (SELECT id FROM (${readingRefs(id)}))
    SELECT id,title,day,source,topics,abstract FROM (
      ${sql.join(offsets.map(dayShare), sql` UNION ALL `)}
    )
    ORDER BY day DESC,shortlisted DESC,rank_sort,id,source
  `,
    );
  const candidates = (await Promise.all([days([0, 1, 2, 3]), days([4, 5, 6])]))
    .flat()
    .slice(0, recentCandidateLimit);
  return scoreRelatedPapers(
    candidates,
    keywords,
    new Set(topics.map(({ topic }) => topic.toLowerCase())),
  );
}

export async function getWorkingPaper(
  db: Database,
  id: string,
  day: string,
): Promise<Detail | null> {
  const detail = await first<WorkingPaper>(
    db,
    sql`${workingPapers} WHERE w.id=${id}`,
  );
  if (!detail) return null;
  const [ideas, reading] = await Promise.all([
    rows<Idea>(
      db,
      sql`SELECT id,title,path,description,paper_ids FROM (${paperIdeas(id)}) ORDER BY position`,
    ),
    readingList(db, id),
  ]);
  return {
    ...detail,
    ideas: ideas.map(({ id, title, path }) => ({ id, title, path })),
    ...reading,
    recent: await relatedReading(db, id, day, ideas),
  };
}
