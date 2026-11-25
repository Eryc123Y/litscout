import { sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { vaultTitleKey } from "@litscout/core/normalize";
import {
  readDerivedArxivLinks,
  type ArxivLinkRecipe,
} from "@litscout/pipeline/legacy-links";
import {
  vaultPaper,
  type VaultPaper,
  type vaultIdea,
  type vaultMatch,
  type vaultMatchResult,
  type vaultProject,
} from "@litscout/pipeline/vault-contracts";
import { first, rows, type Database } from "./database";
import { identifierCandidates } from "./vault-identifiers";
import { paperTitleKeysReady, uniqueVaultTitle } from "./vault-title-matches";

type Idea = z.output<typeof vaultIdea>;
type Project = z.output<typeof vaultProject>;
const ideas = sql`SELECT i.id,i.title,n.path,i.status,i.description,i.project_id,i.paper_ids,
    p.title AS project_title,
    CASE WHEN r.state='queued' OR (r.state='rejected' AND r.payload ->> 'rejectionCleared' IS NULL) THEN
      json_object('id',r.id,'state',r.state,'status',r.payload ->> 'status','reason',r.reason)
    END AS status_request
  FROM idea_index i JOIN vault_notes n ON n.id=i.vault_note_id
  LEFT JOIN projects p ON p.id=i.project_id AND p.deleted_at IS NULL
  LEFT JOIN vault_requests r ON r.id=(
    SELECT id FROM vault_requests
    WHERE target_note_id=n.id AND kind='set_status'
    ORDER BY created_at DESC,id DESC LIMIT 1)`;

export function listVaultIdeas(db: Database, after: string, limit: number) {
  return rows<Idea>(
    db,
    sql`${ideas} WHERE i.id>${after} ORDER BY i.id LIMIT ${limit}`,
  );
}

export function vaultIdeaById(db: Database, id: string) {
  return first<Idea>(db, sql`${ideas} WHERE i.id=${id}`);
}

export type VaultNoteBody = {
  id: string;
  kind: "project" | "idea" | "working_paper";
  title: string;
  path: string;
  bodyMd: string | null;
};

/** A live project, idea or draft note with its uploaded body (null when the
 * owner did not upload it), for read-only display. */
export function vaultNoteById(db: Database, id: string) {
  return first<VaultNoteBody>(
    db,
    sql`SELECT id,kind,title,path,body_md AS bodyMd FROM vault_notes
      WHERE id=${id} AND deleted_at IS NULL
        AND kind IN ('project','idea','working_paper')`,
  );
}

const projectPapers = sql`
  SELECT i.project_id, ref.value AS id
  FROM page p CROSS JOIN idea_index i ON i.project_id=p.id, json_each(i.paper_ids) ref
  UNION
  SELECT i.project_id, paper.value
  FROM working_paper_index w CROSS JOIN json_each(w.idea_ids) idea
  CROSS JOIN idea_index i ON i.id=idea.value CROSS JOIN json_each(w.paper_ids) paper
  WHERE i.project_id IN (SELECT id FROM page)
  UNION
  SELECT w.project_id, paper.value FROM working_paper_index w, json_each(w.paper_ids) paper
  WHERE w.project_id IN (SELECT id FROM page)`;

export async function listVaultProjects(
  db: Database,
  after = "",
  limit = 25,
  id?: string,
) {
  return rows<Project>(
    db,
    sql`
    WITH page AS MATERIALIZED (
      SELECT p.id,p.title,n.path,p.status,p.summary
      FROM projects p JOIN vault_notes n ON n.id=p.vault_note_id
      WHERE p.deleted_at IS NULL AND p.id>${after} ${id ? sql`AND p.id=${id}` : sql``}
      ORDER BY p.id LIMIT ${limit}
    ), refs AS MATERIALIZED (${projectPapers}), legacy_radar AS MATERIALIZED (
      SELECT lower(r.value ->> 'project') AS project_title,
        'digest_' || d.day || '_' || (r.value ->> 'paperId') AS id,
        r.value ->> 'paperId' AS paper_id,d.day,r.value ->> 'level' AS level,
        r.value ->> 'reason' AS reason
      FROM digests d, json_each(d.radar) r
      WHERE d.kind='daily' AND d.day>=date('now','-90 days')
        AND (r.value ->> 'projectId') IS NULL
        AND lower(r.value ->> 'project') IN (SELECT lower(title) FROM page)
    )
    SELECT p.*,
      (SELECT json_group_array(json_object('id',id,'title',title,'path',path))
        FROM (SELECT i.id,i.title,v.path FROM idea_index i JOIN vault_notes v ON v.id=i.vault_note_id
          WHERE i.project_id=p.id ORDER BY i.title,i.id LIMIT 100)) AS ideas,
      (SELECT json_group_array(json_object('id',id,'title',title))
        FROM (SELECT refs.id,coalesce(paper.title,idx.title) AS title FROM refs
          LEFT JOIN papers paper ON paper.id=refs.id AND paper.deleted_at IS NULL
          LEFT JOIN paper_index idx ON idx.paper_id=refs.id
          WHERE refs.project_id=p.id AND coalesce(paper.title,idx.title) IS NOT NULL ORDER BY coalesce(paper.title,idx.title),refs.id LIMIT 100)) AS papers,
      (SELECT json_group_array(json_object('id',id,'paperId',paper_id,'title',title,'day',day,'level',level,'reason',reason))
        FROM (
          SELECT hit.id,hit.paper_id,paper.title,hit.day,hit.level,hit.reason FROM (
            SELECT r.id,r.paper_id,r.day,r.level,r.reason FROM radar_grades r WHERE r.project_id=p.id
            UNION ALL
            SELECT l.id,l.paper_id,l.day,l.level,l.reason
            FROM legacy_radar l WHERE l.project_title=lower(p.title)
              AND NOT EXISTS(SELECT 1 FROM radar_grades rg WHERE rg.project_id=p.id
                AND rg.day=l.day AND rg.paper_id=l.paper_id)
            GROUP BY l.day,l.paper_id
          ) hit JOIN papers paper ON paper.id=hit.paper_id AND paper.deleted_at IS NULL
          ORDER BY hit.day DESC,hit.id LIMIT 30
        )) AS radar
    FROM page p ORDER BY p.id`,
  );
}

function noteIdentifier(scheme: "arxiv" | "doi") {
  return {
    scheme: sql.raw(`'${scheme}'`),
    index: sql.identifier("vault_notes_" + scheme),
    noteValue: sql.raw(`lower(json_extract(n.frontmatter,'$.${scheme}'))`),
    compactValue: sql.identifier(scheme === "arxiv" ? "arxiv_id" : "doi"),
  };
}

function identifierNotes(paperId: SQL, id: ReturnType<typeof noteIdentifier>) {
  return sql`
    SELECT n.path,n.frontmatter FROM (
      SELECT value FROM paper_ids WHERE paper_id=${paperId} AND scheme=${id.scheme}
      UNION ALL
      SELECT i.${id.compactValue} FROM paper_index i
        WHERE i.paper_id=${paperId} AND i.${id.compactValue} IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM paper_ids WHERE scheme=${id.scheme} AND value=i.${id.compactValue})
    ) i CROSS JOIN vault_notes n INDEXED BY ${id.index} ON ${id.noteValue}=lower(i.value)
    WHERE n.kind='paper_note' AND n.deleted_at IS NULL`;
}

function conflictingIdentifier(
  paperId: SQL,
  id: ReturnType<typeof noteIdentifier>,
) {
  return sql`
    EXISTS(SELECT 1 FROM paper_ids WHERE scheme=${id.scheme} AND value=${id.noteValue} AND paper_id<>${paperId})
    OR (
      NOT EXISTS(SELECT 1 FROM paper_ids WHERE scheme=${id.scheme} AND value=${id.noteValue})
      AND EXISTS(SELECT 1 FROM paper_index WHERE ${id.compactValue}=${id.noteValue} AND paper_id<>${paperId})
    )`;
}

export function identifierNotePath(paperId: SQL) {
  const arxiv = noteIdentifier("arxiv"),
    doi = noteIdentifier("doi");
  // Start with this paper's identifiers, then keep only notes whose identifiers
  // resolve to this paper alone. A canonical identifier supersedes a compact one.
  return sql`SELECT path FROM (
      ${identifierNotes(paperId, arxiv)}
      UNION ALL
      ${identifierNotes(paperId, doi)}
    ) n WHERE NOT (${conflictingIdentifier(paperId, arxiv)})
          AND NOT (${conflictingIdentifier(paperId, doi)})
    ORDER BY path LIMIT 1`;
}

export async function paperVaultNote(db: Database, paperId: string) {
  const result = await first<{
    path: string | null;
    titlePath: string | null;
    pending: number;
    capturePending: number;
    linkPending: number;
    notesWithoutIdentifiers: number | null;
  }>(
    db,
    sql`
    SELECT (${identifierNotePath(sql`${paperId}`)}) AS path,
      (SELECT path FROM vault_notes WHERE title_paper_id=${paperId}
        AND deleted_at IS NULL ORDER BY path LIMIT 1) AS title_path,
      EXISTS (SELECT 1 FROM vault_requests WHERE kind='make_paper_note' AND state='queued' AND json_extract(payload,'$.paperId')=${paperId}) AS pending,
      EXISTS (SELECT 1 FROM vault_requests WHERE kind='capture' AND state='queued' AND json_extract(payload,'$.paperId')=${paperId}) AS capture_pending,
      EXISTS (SELECT 1 FROM vault_requests WHERE kind='link_paper' AND state='queued' AND json_extract(payload,'$.paperId')=${paperId}) AS link_pending,
      (SELECT report ->> '$.conventions.paperNotesWithoutIdentifiers.count' FROM vault_sync WHERE id=1) AS notes_without_identifiers
  `,
  );
  return {
    path: result?.path ?? result?.titlePath ?? null,
    ...(!result?.path && result?.titlePath
      ? { matchedBy: "title" as const }
      : {}),
    pending: Boolean(result?.pending),
    ...(result?.capturePending ? { capturePending: true } : {}),
    ...(result?.linkPending ? { linkPending: true } : {}),
    ...(!result?.path && result?.notesWithoutIdentifiers != null
      ? { notesWithoutIdentifiers: result.notesWithoutIdentifiers }
      : {}),
  };
}

export async function lookupVaultMatches(
  db: Database,
  notes: z.output<typeof vaultMatch>[],
): Promise<z.output<typeof vaultMatchResult>[]> {
  const identified = notes.filter(({ arxiv, doi }) => arxiv || doi);
  const byIdentifier = identified.length
    ? await rows<{ id: string; paperId: string }>(
        db,
        sql`
    WITH matches AS MATERIALIZED (
      SELECT n.value ->> 'id' AS id,
        (SELECT min(paper_id) FROM (
          ${identifierCandidates("arxiv", sql`lower(n.value ->> 'arxiv')`)}
          UNION ALL
          ${identifierCandidates("doi", sql`lower(n.value ->> 'doi')`)}
        ) HAVING count(DISTINCT paper_id)=1) AS paper_id
      FROM json_each(${JSON.stringify(identified)}) n
    )
    SELECT id,paper_id FROM matches WHERE paper_id IS NOT NULL`,
      )
    : [];
  const titles = notes.flatMap(({ id, arxiv, doi, title }) => {
    const key = !arxiv && !doi && title ? vaultTitleKey(title) : "";
    return key ? [{ id, key }] : [];
  });
  const byTitle = titles.length
    ? await rows<{ id: string; paperId: string }>(
        db,
        sql`WITH matches AS MATERIALIZED (
          SELECT n.value ->> 'id' AS id, ${uniqueVaultTitle(sql`(n.value ->> 'key')`)} AS paper_id
          FROM json_each(${JSON.stringify(titles)}) n WHERE ${paperTitleKeysReady}
        )
        SELECT id,paper_id FROM matches WHERE paper_id IS NOT NULL`,
      )
    : [];
  return [
    ...byIdentifier,
    ...byTitle.map((match) => ({ ...match, matchedBy: "title" as const })),
  ];
}

export async function readVaultPapers(
  db: Database,
  ids: readonly string[],
  lang: string,
): Promise<VaultPaper[]> {
  if (!ids.length) return [];
  const result = await rows<
    VaultPaper & { derivedArxivLinks: ArxivLinkRecipe[] | null }
  >(
    db,
    sql`
    WITH ids AS (SELECT DISTINCT value AS id FROM json_each(${JSON.stringify(ids)}))
    SELECT ids.id,p.derived_arxiv_links,coalesce(p.title, idx.title) AS title, coalesce(
      (SELECT value FROM paper_ids WHERE paper_id=ids.id AND scheme='arxiv' ORDER BY value LIMIT 1), idx.arxiv_id) AS arxiv,
      coalesce((SELECT value FROM paper_ids WHERE paper_id=ids.id AND scheme='doi' ORDER BY value LIMIT 1), idx.doi) AS doi,
      (SELECT json_group_array(topic) FROM
        (SELECT value AS topic FROM json_each(idx.topics) UNION
         SELECT j.value FROM feed_items f, json_each(f.topics) j WHERE f.paper_id=ids.id ORDER BY topic)) AS topics,
      (SELECT json_group_array(json_object('kind',kind,'url',url))
        FROM (SELECT kind,url FROM paper_links WHERE paper_id=ids.id AND (url LIKE 'https://%' OR url LIKE 'http://%')
          ORDER BY CASE WHEN http_status BETWEEN 200 AND 299 THEN 0 ELSE 1 END, kind,url LIMIT 30)) AS links,
      (SELECT content FROM summaries WHERE paper_id=ids.id AND kind='five_part'
        ORDER BY CASE WHEN lang=${lang} THEN 0 ELSE 1 END,lang LIMIT 1) AS summary,
      (SELECT json_group_array(body_md) FROM
        (SELECT body_md FROM notes WHERE target_type='paper' AND target_id=ids.id AND user_id='u_owner'
          AND deleted_at IS NULL ORDER BY created_at,id LIMIT 50)) AS notes
    FROM ids LEFT JOIN papers p ON p.id=ids.id LEFT JOIN paper_index idx ON idx.paper_id=ids.id
    WHERE (p.id IS NOT NULL AND p.deleted_at IS NULL) OR (p.id IS NULL AND idx.paper_id IS NOT NULL)
  `,
  );
  return result.map(({ derivedArxivLinks, ...paper }) => {
    const links = paper.links.filter(
      (link) => vaultPaper.shape.links.element.safeParse(link).success,
    );
    for (const link of readDerivedArxivLinks(derivedArxivLinks))
      if (
        links.length < 30 &&
        !links.some(
          (saved) => saved.kind === link.kind && saved.url === link.url,
        )
      )
        links.push({ kind: link.kind, url: link.url });
    return vaultPaper.parse({
      ...paper,
      arxiv: paper.arxiv ?? undefined,
      doi: paper.doi ?? undefined,
      summary: vaultPaper.shape.summary.safeParse(
        typeof paper.summary === "string"
          ? JSON.parse(paper.summary)
          : paper.summary,
      ).data,
      links,
      url: links.find((link) =>
        ["landing", "publisher", "abs"].includes(link.kind),
      )?.url,
    });
  });
}

export async function readVaultDigest(db: Database, day: string, lang: string) {
  const digest = await first<{
    day: string;
    markdown: string;
    digestSuggestions: { title: string; rationale: string }[];
  }>(
    db,
    sql`
    SELECT d.day,d.body_md AS markdown,
      (SELECT json_group_array(json_object('title',title,'rationale',body_md))
        FROM (SELECT title,body_md FROM suggestions WHERE user_id='u_owner'
          AND day=d.day AND status!='dismissed' AND deleted_at IS NULL ORDER BY id LIMIT 10)
      ) AS digest_suggestions
    FROM digests d WHERE d.day=${day} AND d.kind='daily'
    ORDER BY CASE WHEN d.lang=${lang} THEN 0 ELSE 1 END,d.lang LIMIT 1
  `,
  );
  if (!digest) return null;
  const suggestions = digest.digestSuggestions.map(
    ({ title, rationale }) =>
      "- " +
      title.replace(/\s+/g, " ") +
      " — " +
      rationale.replace(/\s+/g, " "),
  );
  return {
    day: digest.day,
    markdown:
      digest.markdown +
      (suggestions.length
        ? "\n\n## Idea suggestions\n\n" + suggestions.join("\n")
        : ""),
  };
}
