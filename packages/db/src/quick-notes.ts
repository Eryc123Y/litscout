import { sql } from "drizzle-orm";
import { ulid } from "ulid";
import type { QuickNote } from "@litscout/pipeline/library-contracts";
import { first, rows, type Database } from "./database";
import { OWNER, livePaper } from "./library";

// Names come from client registration. Label them in every note response,
// including notes written before the attribution policy.
const noteFields = sql`id,user_id,target_type,target_id,body_md,origin,created_at,updated_at,deleted_at,rev,
  CASE WHEN client IS NOT NULL THEN client || ' (unverified)' END AS client`;

export function listNotes(db: Database, paperId: string, after = "") {
  return rows<QuickNote>(
    db,
    sql`SELECT ${noteFields} FROM notes WHERE target_type='paper' AND target_id=${paperId}
    AND user_id=${OWNER} AND deleted_at IS NULL AND id>${after} AND ${livePaper(paperId)}
    ORDER BY id LIMIT 51`,
  );
}

export async function addNote(
  db: Database,
  paperId: string,
  body: string,
  origin: string,
  now: string,
  client?: string,
) {
  // The same text on the same paper within a minute is a retry: return the
  // note already written instead of a second copy.
  const since = new Date(Date.parse(now) - 60_000).toISOString();
  const retry = await first<QuickNote>(
    db,
    sql`SELECT ${noteFields} FROM notes WHERE user_id=${OWNER} AND target_type='paper'
    AND target_id=${paperId} AND body_md=${body} AND deleted_at IS NULL AND created_at>=${since}
    ORDER BY created_at DESC LIMIT 1`,
  );
  if (retry) return retry;
  return first<QuickNote>(
    db,
    sql`INSERT INTO notes(id,user_id,target_type,target_id,body_md,origin,created_at,updated_at,client)
    SELECT ${`note_${ulid()}`},${OWNER},'paper',${paperId},${body},${origin},${now},${now},${client ?? null}
    WHERE ${livePaper(paperId)} RETURNING ${noteFields}`,
  );
}

export async function editNote(
  db: Database,
  id: string,
  ifRev: number,
  now: string,
  body: string | null,
) {
  const where = sql`id=${id} AND target_type='paper' AND user_id=${OWNER} AND deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM papers WHERE id=notes.target_id AND deleted_at IS NULL)`;
  const change = body === null ? sql`deleted_at=${now}` : sql`body_md=${body}`;
  const item = await first<QuickNote>(
    db,
    sql`UPDATE notes SET ${change},updated_at=${now},rev=rev+1
    WHERE ${where} AND rev=${ifRev} RETURNING ${noteFields}`,
  );
  return item
    ? { item }
    : {
        current: await first<QuickNote>(
          db,
          sql`SELECT ${noteFields} FROM notes WHERE ${where}`,
        ),
      };
}
