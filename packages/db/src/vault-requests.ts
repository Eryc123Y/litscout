import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { z } from "zod";
import {
  queuedVaultRequest,
  type CaptureReference,
  type captureEdit,
  type pendingCapture,
  type NewVaultRequest,
  type resolveVaultRequest as resolutionSchema,
  type SyncReport,
  type vaultStatus,
} from "@litscout/pipeline/vault-contracts";
import { atomic, first, rows, type Database } from "./database";
import { readVaultPapers, paperVaultNote } from "./vault-reads";

export class VaultRequestError extends Error {}
const queueLimit = 200;
const pageLimit = 50;
type RequestState = "queued" | "applied" | "rejected" | "cancelled";
type RequestRow = {
  id: string;
  kind: NewVaultRequest["kind"];
  targetNoteId: string | null;
  path: string | null;
  baseHash: string | null;
  resultHash: string | null;
  payload: {
    paperId?: string;
    topic?: string;
    title: string;
    status?: string;
    references?: CaptureReference[];
  };
  bodyMd: string | null;
};

export async function createVaultRequest(
  db: Database,
  input: NewVaultRequest,
  now: string,
  origin = "cli",
  suggestion?: { id: string; references?: CaptureReference[] },
) {
  const { kind } = input;
  const paperId = "paperId" in input ? (input.paperId ?? null) : null;
  const paper = paperId
    ? (await readVaultPapers(db, [paperId], "en"))[0]
    : undefined;
  if (paperId && !paper)
    throw new VaultRequestError("The requested paper is unavailable.");
  const targetNoteId = "targetNoteId" in input ? input.targetNoteId : null;
  const targetKind = kind === "add_reading" ? "working_paper" : "idea";
  const title = "title" in input ? input.title : paper?.title;
  const status = kind === "set_status" ? input.status : undefined;
  const topic = kind === "make_paper_note" ? input.topic : undefined;
  if (kind === "capture" && !suggestion) {
    // The same capture within ten minutes is a retry: return it.
    const since = new Date(Date.parse(now) - 600_000).toISOString();
    const retry = await first<{ id: string }>(
      db,
      sql`SELECT r.id FROM vault_requests r JOIN captures c ON c.id=r.id
      WHERE r.kind='capture' AND r.state='queued' AND r.created_at>=${since}
        AND c.title=${input.title} AND c.body_md=${input.body ?? ""}
        AND coalesce(c.source_paper_id,'')=${paperId ?? ""}
      ORDER BY r.created_at DESC LIMIT 1`,
    );
    if (retry)
      return { id: retry.id, state: "queued" as const, rowsWritten: 0 };
  }
  const id = "req_" + ulid();
  if (kind === "make_paper_note") {
    const { path } = await paperVaultNote(db, input.paperId);
    if (path)
      throw new VaultRequestError(
        "This paper already has a vault note at " + path,
      );
  }
  const sameQueued = sql`SELECT id FROM vault_requests WHERE target_note_id=${targetNoteId}
    AND kind=${kind} AND state='queued' AND json_extract(payload,'$.paperId') IS ${paperId}`;
  const pending =
    kind === "set_status" || kind === "link_paper" || kind === "add_reading"
      ? sql`AND NOT EXISTS(${sameQueued})`
      : sql``;
  const fromSuggestion = suggestion
    ? sql`AND EXISTS(SELECT 1 FROM suggestions WHERE id=${suggestion.id}
      AND user_id='u_owner' AND deleted_at IS NULL AND status='new')`
    : sql``;
  const insert = sql`
    INSERT INTO vault_requests(id,kind,target_note_id,payload,base_hash,origin,created_at)
    SELECT ${id},${kind},${targetNoteId},json_patch(${JSON.stringify({ status, title, topic, paperId, references: suggestion?.references })},
      json_object('title',coalesce(${title ?? null}, n.title, 'Vault request'))),n.hash,${origin},${now}
    FROM (SELECT 1) LEFT JOIN vault_notes n ON n.id=${targetNoteId} AND n.kind=${targetKind} AND n.deleted_at IS NULL
    WHERE (${targetNoteId} IS NULL OR n.id IS NOT NULL)
      AND (SELECT count(*) FROM vault_requests WHERE state='queued') < ${queueLimit}
    ${pending} ${fromSuggestion}
    ON CONFLICT DO NOTHING`;
  const statements: [typeof insert, ...(typeof insert)[]] = [insert];
  if (kind === "capture")
    statements.push(sql`INSERT INTO captures(id,title,body_md,source_paper_id,suggestion_id,created_at)
      SELECT id,${input.title},${input.body ?? ""},${paperId},${suggestion?.id ?? null},${now}
      FROM vault_requests WHERE id=${id}`);
  const reuseLink = suggestion && kind === "link_paper";
  if (suggestion) {
    const request = reuseLink
      ? sql`(${sameQueued} ORDER BY created_at,id LIMIT 1)`
      : sql`(SELECT id FROM vault_requests WHERE id=${id})`;
    statements.push(sql`UPDATE suggestions SET status='accepted',resolved_at=${now},request_id=${request},rev=rev+1
      WHERE id=${suggestion.id} AND user_id='u_owner' AND deleted_at IS NULL
        AND status='new' AND ${request} IS NOT NULL`);
  }
  const rowsWritten = await atomic(db, statements);
  if (!rowsWritten) {
    if (kind === "make_paper_note") {
      const prior = await first<{ id: string }>(
        db,
        sql`SELECT id FROM vault_requests
        WHERE kind='make_paper_note' AND state='queued' AND payload ->> 'paperId'=${paperId}`,
      );
      if (prior) return { ...prior, state: "queued" as const, rowsWritten: 0 };
    }
    if (
      !suggestion &&
      (kind === "set_status" || kind === "link_paper" || kind === "add_reading")
    ) {
      // The same change already waits in the queue: a retry gets that
      // request. A different status is a new change and stays refused.
      const sameStatus =
        kind === "set_status"
          ? sql`AND json_extract(payload,'$.status') IS ${status}`
          : sql``;
      const prior = await first<{ id: string }>(
        db,
        sql`${sameQueued} ${sameStatus} ORDER BY created_at,id LIMIT 1`,
      );
      if (prior)
        return { id: prior.id, state: "queued" as const, rowsWritten: 0 };
    }
    throw new VaultRequestError(
      "The target note is unavailable, a change is already queued, or the request queue is full.",
    );
  }
  if (reuseLink) {
    const accepted = await first<{ requestId: string }>(
      db,
      sql`SELECT request_id FROM suggestions WHERE id=${suggestion.id} AND status='accepted'`,
    );
    if (!accepted)
      throw new VaultRequestError("The linked request has already ended.");
    return { id: accepted.requestId, state: "queued" as const, rowsWritten };
  }
  return { id, state: "queued" as const, rowsWritten };
}

export async function queuedVaultRequests(
  db: Database,
  now: string,
  language: string,
) {
  const queue = await rows<RequestRow>(
    db,
    sql`SELECT r.id,r.kind,r.target_note_id,r.base_hash,r.result_hash,r.payload,n.path,c.body_md
    FROM vault_requests r LEFT JOIN vault_notes n ON n.id=r.target_note_id
    LEFT JOIN captures c ON c.id=r.id WHERE r.state='queued' AND (r.claim_until IS NULL OR r.claim_until <= ${now})
    ORDER BY r.created_at,r.id LIMIT ${pageLimit}`,
  );
  const papers = await readVaultPapers(
    db,
    queue.flatMap(({ payload: { paperId } }) => (paperId ? [paperId] : [])),
    language,
  );
  const byId = new Map(papers.map((paper) => [paper.id, paper]));
  return queue.map(
    ({ id, kind, targetNoteId, path, baseHash, resultHash, payload, bodyMd }) =>
      queuedVaultRequest.parse({
        id,
        kind,
        title: payload.title,
        topic: payload.topic,
        status: payload.status,
        body: bodyMd ?? undefined,
        references: payload.references,
        paper: payload.paperId ? byId.get(payload.paperId) : undefined,
        target: targetNoteId ? { id: targetNoteId, path } : undefined,
        baseHash,
        resultHash: resultHash ?? undefined,
      }),
  );
}

export function claimVaultRequestKind(
  db: Database,
  id: string,
  claim: string,
  now: string,
  resultHash?: string,
) {
  const until = new Date(Date.parse(now) + 10 * 60_000).toISOString();
  return first<{ kind: NewVaultRequest["kind"] }>(
    db,
    sql`
    UPDATE vault_requests SET claim=${claim}, claim_until=${until},
      result_hash=CASE WHEN kind='set_status' THEN coalesce(result_hash,${resultHash ?? null}) ELSE NULL END
    WHERE id=${id} AND state='queued'
      AND (claim IS NULL OR claim_until<=${now} OR claim=${claim}) RETURNING kind`,
  );
}

export async function claimVaultRequest(
  ...args: Parameters<typeof claimVaultRequestKind>
) {
  return Boolean(await claimVaultRequestKind(...args));
}

async function endRequest(
  db: Database,
  id: string,
  state: RequestState,
  reason: string | null,
  claim: string | null,
  now: string,
) {
  const rowsWritten = await atomic(db, [
    sql`UPDATE vault_requests SET state=${state},reason=${reason},resolved_at=${now},claim=NULL,claim_until=NULL
      WHERE id=${id} AND state='queued' AND (claim IS ${claim} OR (${claim} IS NULL AND
        (${state}='cancelled' OR kind!='capture') AND claim_until<=${now}))`,
    sql`UPDATE suggestions SET status='new',request_id=NULL,resolved_at=NULL,rev=rev+1
      WHERE request_id=${id} AND status='accepted' AND changes()>0 AND ${state} IN ('cancelled','rejected')`,
    sql`DELETE FROM captures WHERE id=${id} AND ${state} IN ('applied','cancelled') AND EXISTS(
      SELECT 1 FROM vault_requests WHERE id=${id} AND state=${state})`,
  ]);
  const ended =
    rowsWritten > 0 ||
    Boolean(
      await first(
        db,
        sql`SELECT 1 FROM vault_requests WHERE id=${id} AND state=${state}`,
      ),
    );
  return { ended, rowsWritten };
}

export function cancelVaultRequest(db: Database, id: string, now: string) {
  return endRequest(db, id, "cancelled", null, null, now);
}
export async function clearRejectedMove(db: Database, id: string) {
  return Boolean(
    await first(
      db,
      sql`UPDATE vault_requests SET payload=json_set(payload,'$.rejectionCleared',1)
      WHERE id=${id} AND kind='set_status' AND state='rejected' RETURNING id`,
    ),
  );
}
export function resolveVaultRequest(
  db: Database,
  id: string,
  resolution: z.output<typeof resolutionSchema>,
  now: string,
) {
  return endRequest(
    db,
    id,
    resolution.state,
    "reason" in resolution ? resolution.reason : null,
    resolution.claim ?? null,
    now,
  );
}

export async function recordVaultSync(
  db: Database,
  report: SyncReport,
  at: string,
) {
  return atomic(db, [
    sql`UPDATE vault_sync SET report=${JSON.stringify(report)}, reported_at=${at} WHERE id=1`,
  ]);
}

export async function getVaultStatus(
  db: Database,
  now: string,
): Promise<z.output<typeof vaultStatus>> {
  const [last, queued, rejected, count] = await Promise.all([
    first<{ report: SyncReport; reportedAt: string }>(
      db,
      sql`SELECT report,reported_at FROM vault_sync WHERE report IS NOT NULL`,
    ),
    rows<z.output<typeof vaultStatus>["queued"][number]>(
      db,
      sql`
      SELECT r.id,r.kind,coalesce(c.title,r.payload ->> 'title') AS title,n.path,r.created_at,coalesce(r.claim_until>${now},0) AS applying
      FROM vault_requests r LEFT JOIN vault_notes n ON n.id=r.target_note_id
      LEFT JOIN captures c ON c.id=r.id
      WHERE r.state='queued' ORDER BY r.created_at,r.id LIMIT ${pageLimit}`,
    ),
    rows<z.output<typeof vaultStatus>["rejected"][number]>(
      db,
      sql`
      SELECT id,kind,payload ->> 'title' AS title,reason,resolved_at
      FROM vault_requests WHERE state='rejected' ORDER BY resolved_at DESC,id LIMIT ${pageLimit}`,
    ),
    first<{ count: number }>(
      db,
      sql`SELECT count(*) AS count FROM vault_requests WHERE state='queued'`,
    ),
  ]);
  return {
    last: last ? { ...last.report, at: last.reportedAt } : null,
    queued: queued.map((request) => ({
      ...request,
      applying: Boolean(request.applying),
    })),
    rejected,
    queuedCount: count?.count ?? 0,
  };
}

export async function pendingCaptures(db: Database, now: string) {
  const captures = await rows<
    Omit<z.output<typeof pendingCapture>, "applying"> & { applying: number }
  >(
    db,
    sql`SELECT c.id,c.title,c.body_md AS body,coalesce(p.title,i.title) AS paper_title,
      coalesce(r.claim_until>${now},0) AS applying
      FROM captures c JOIN vault_requests r ON r.id=c.id
      LEFT JOIN papers p ON p.id=c.source_paper_id AND p.deleted_at IS NULL
      LEFT JOIN paper_index i ON i.paper_id=c.source_paper_id
      WHERE r.state='queued' AND c.user_id='u_owner'
      ORDER BY c.created_at,c.id LIMIT ${queueLimit}`,
  );
  return captures.map((capture) => ({
    ...capture,
    applying: Boolean(capture.applying),
  }));
}

export async function editCapture(
  db: Database,
  id: string,
  input: z.output<typeof captureEdit>,
  now: string,
) {
  const editable = sql`id=${id} AND kind='capture' AND state='queued'
    AND (claim IS NULL OR claim_until<=${now})`;
  return atomic(db, [
    sql`UPDATE captures SET title=${input.title},body_md=${input.body}
      WHERE id=${id} AND user_id='u_owner' AND EXISTS(SELECT 1 FROM vault_requests WHERE ${editable})`,
    sql`UPDATE vault_requests SET payload=json_set(payload,'$.title',${input.title}),claim=NULL,claim_until=NULL
      WHERE ${editable} AND EXISTS(SELECT 1 FROM captures WHERE id=${id} AND user_id='u_owner')`,
  ]);
}

export function claimedCapture(db: Database, id: string, claim: string) {
  return first<{ title: string; body: string }>(
    db,
    sql`
    SELECT c.title,c.body_md AS body FROM captures c JOIN vault_requests r ON r.id=c.id
    WHERE r.id=${id} AND r.claim=${claim} AND r.state='queued'
  `,
  );
}
