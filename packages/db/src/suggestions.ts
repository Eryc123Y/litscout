import { sql } from "drizzle-orm";
import type { z } from "zod";
import type {
  suggestion,
  suggestionsQuery,
} from "@litscout/pipeline/research-contracts";
import type { CaptureReference } from "@litscout/pipeline/vault-contracts";
import { atomic, first, rows, type Database } from "./database";
import { readVaultPapers } from "./vault-reads";
import { createVaultRequest, VaultRequestError } from "./vault-requests";

type Suggestion = z.output<typeof suggestion>;
const privateSuggestions = sql`
  SELECT s.id,s.day,s.kind,s.title,s.body_md,s.idea_ids,s.paper_ids,s.project_ids,
    s.status,s.resolved_at,s.request_id,r.state AS request_state
  FROM suggestions s LEFT JOIN vault_requests r ON r.id=s.request_id
  WHERE s.user_id='u_owner' AND s.deleted_at IS NULL
`;

export async function listSuggestions(
  db: Database,
  { day, status, after }: z.output<typeof suggestionsQuery>,
  limit: number,
) {
  const items = await rows<Suggestion>(
    db,
    sql`${privateSuggestions} AND s.id>${after ?? ""}
    ${day ? sql`AND s.day=${day}` : sql``}
    ${status ? sql`AND s.status=${status}` : sql``}
    ORDER BY s.id LIMIT ${limit}`,
  );
  const ids = [
    ...new Set(
      items.flatMap(({ ideaIds, projectIds, paperIds }) => [
        ...ideaIds,
        ...projectIds,
        ...paperIds,
      ]),
    ),
  ];
  if (!ids.length) return items;
  const named = await rows<{ id: string; title: string; kind: string }>(
    db,
    sql`
    WITH refs AS (SELECT value AS id FROM json_each(${JSON.stringify(ids)}))
    SELECT refs.id,n.title,n.kind FROM refs CROSS JOIN vault_notes n
      ON n.id=refs.id AND n.deleted_at IS NULL AND n.kind IN ('idea','project')
    UNION ALL
    SELECT refs.id,coalesce(p.title,i.title),'paper' FROM refs
      LEFT JOIN papers p ON p.id=refs.id AND p.deleted_at IS NULL
      LEFT JOIN paper_index i ON i.paper_id=refs.id
    WHERE coalesce(p.title,i.title) IS NOT NULL
  `,
  );
  const names = new Map(
    named.map(({ id, title, kind }) => [kind + ":" + id, { id, title }]),
  );
  const titled = (ids: string[], kind: string) =>
    ids.flatMap((id) => names.get(kind + ":" + id) ?? []);
  return items.map((item) => ({
    ...item,
    references: {
      ideas: titled(item.ideaIds, "idea"),
      papers: titled(item.paperIds, "paper"),
      projects: titled(item.projectIds, "project"),
    },
  }));
}

async function references(db: Database, item: Suggestion, language: string) {
  const [notes, papers] = await Promise.all([
    rows<Extract<CaptureReference, { kind: "note" }>>(
      db,
      sql`
      SELECT 'note' AS kind,title,path FROM vault_notes
      WHERE deleted_at IS NULL AND kind IN ('idea','project') AND id IN (SELECT value FROM json_each(${JSON.stringify([...item.ideaIds, ...item.projectIds])}))
      ORDER BY kind,title,id`,
    ),
    readVaultPapers(db, item.paperIds.slice(1), language),
  ]);
  return [
    ...notes,
    ...papers.map(({ title, arxiv, doi, url }) => ({
      kind: "paper" as const,
      title,
      url: arxiv
        ? "https://arxiv.org/abs/" + arxiv
        : doi
          ? "https://doi.org/" + doi
          : url,
    })),
  ];
}

export async function resolveSuggestion(
  db: Database,
  id: string,
  action: "accept" | "dismiss",
  now: string,
  origin: string,
  language: string,
) {
  const read = () =>
    first<Suggestion>(db, sql`${privateSuggestions} AND s.id=${id}`);
  const item = await read();
  if (!item) throw new VaultRequestError("Suggestion is unavailable.");
  const status = action === "accept" ? "accepted" : "dismissed";
  if (item.status === status)
    return { status, requestId: item.requestId, rowsWritten: 0 };
  if (item.status !== "new")
    throw new VaultRequestError("Suggestion was already resolved.");
  if (action === "dismiss") {
    const rowsWritten = await atomic(db, [
      sql`UPDATE suggestions SET status='dismissed',resolved_at=${now},rev=rev+1
        WHERE id=${id} AND user_id='u_owner' AND deleted_at IS NULL AND status='new'`,
    ]);
    if (rowsWritten || (await read())?.status === status)
      return { status, requestId: null, rowsWritten };
    throw new VaultRequestError("Suggestion was already resolved.");
  }
  try {
    const request =
      item.kind === "paper_for_idea"
        ? await createVaultRequest(
            db,
            {
              kind: "link_paper",
              targetNoteId: item.ideaIds[0]!,
              paperId: item.paperIds[0]!,
            },
            now,
            origin,
            { id },
          )
        : await createVaultRequest(
            db,
            {
              kind: "capture",
              title: item.title,
              body: item.bodyMd,
              paperId: item.paperIds[0],
            },
            now,
            origin,
            { id, references: await references(db, item, language) },
          );
    return { status, requestId: request.id, rowsWritten: request.rowsWritten };
  } catch (error) {
    if (error instanceof VaultRequestError) {
      const latest = await read();
      if (latest?.status === status)
        return { status, requestId: latest.requestId, rowsWritten: 0 };
      if (latest?.status === "dismissed")
        throw new VaultRequestError("Suggestion was already resolved.");
    }
    throw error;
  }
}
