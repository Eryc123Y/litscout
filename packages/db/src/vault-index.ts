import { sql } from "drizzle-orm";
import type { z } from "zod";
import { vaultTitleKey } from "@litscout/core/normalize";
import type {
  indexBatch,
  indexCommit,
  indexHead,
} from "@litscout/pipeline/vault-contracts";
import { atomic, first, rows, type Database } from "./database";
import { identifierCandidates } from "./vault-identifiers";
import {
  titleKeysPending,
  titleKeysPendingCount,
  updateVaultTitleMatches,
} from "./vault-title-matches";

export async function hashVaultText(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function getVaultIndex(
  db: Database,
  includeTitleKeys = false,
  includeTitleKeyCount = false,
) {
  const counted = includeTitleKeys && includeTitleKeyCount;
  const { snapshot, count, pending, pendingCount } = (await first<
    z.output<typeof indexHead> & { pending?: number; pendingCount?: number }
  >(
    db,
    sql`SELECT snapshot, note_count AS count
      ${includeTitleKeys ? sql`, (${titleKeysPending}) AS pending` : sql``}
      ${counted ? sql`, (${titleKeysPendingCount}) AS pendingCount` : sql``}
      FROM vault_sync`,
  ))!;
  return {
    snapshot,
    count,
    ...(includeTitleKeys ? { titleKeysPending: Boolean(pending) } : {}),
    // Asked for separately: an older CLI parses the plain head strictly.
    ...(counted ? { titleKeysPendingCount: Number(pendingCount ?? 0) } : {}),
  };
}

export function vaultIndexIds(db: Database, after: string, take: number) {
  return rows<{ id: string; fingerprint: string }>(
    db,
    sql`SELECT id, fingerprint FROM vault_notes
    WHERE deleted_at IS NULL AND id > ${after} ORDER BY id LIMIT ${take}`,
  );
}

export async function stageVaultIndex(
  db: Database,
  { snapshot, previous, part, notes, removed = [] }: z.input<typeof indexBatch>,
) {
  const encoded = JSON.stringify(
    await Promise.all(
      notes.map(async (note) => ({
        ...note,
        fingerprint: await hashVaultText(JSON.stringify(note)),
        titleNorm:
          note.kind === "paper_note" &&
          !note.frontmatter.arxiv &&
          !note.frontmatter.doi
            ? vaultTitleKey(note.title)
            : "",
      })),
    ),
  );
  const result = await rows<{ part: number }>(
    db,
    sql`
    INSERT INTO vault_index_parts(part, snapshot, notes, removed)
    SELECT ${part}, ${snapshot}, ${encoded}, ${JSON.stringify(removed)}
    WHERE EXISTS(SELECT 1 FROM vault_sync WHERE snapshot IS ${previous}) AND ${snapshot} IS NOT ${previous}
    ON CONFLICT(part) DO UPDATE SET snapshot=excluded.snapshot, notes=excluded.notes, removed=excluded.removed
    WHERE excluded.snapshot IS NOT vault_index_parts.snapshot OR excluded.notes IS NOT vault_index_parts.notes OR excluded.removed IS NOT vault_index_parts.removed
    RETURNING part
  `,
  );
  const accepted =
    result.length > 0 ||
    Boolean(
      await first(
        db,
        sql`
    SELECT 1 FROM vault_index_parts WHERE part=${part} AND snapshot=${snapshot} AND notes=${encoded} AND removed=${JSON.stringify(removed)}
  `,
      ),
    );
  return { accepted, rowsWritten: result.length };
}

// Resolve frontmatter references with or without Obsidian link brackets and a display alias.
const ref = (value: ReturnType<typeof sql>) => sql`
  lower(trim(CASE WHEN substr(trim(${value}), 1, 2) = '[[' THEN
    CASE WHEN instr(trim(${value}), '|') THEN substr(trim(${value}), 3, instr(trim(${value}), '|') - 3)
      ELSE substr(trim(${value}), 3, length(trim(${value})) - 4) END
    ELSE trim(${value}) END))`;
const lookupOrder = sql`
  CASE WHEN lower(path) = ref OR lower(substr(path, 1, length(path)-3)) = ref THEN 0
       WHEN lower(title) = ref THEN 1 ELSE 2 END, id`;
const matchesRef = sql`(lower(title) = ref OR lower(path) = ref OR lower(substr(path, 1, length(path)-3)) = ref
  OR substr(lower(path), -(length(ref)+4)) = '/' || ref || '.md')`;
const projectId = sql`(SELECT id FROM (
  SELECT p.id,p.title,v.path,${ref(sql`n.frontmatter ->> 'project'`)} AS ref
  FROM projects p JOIN vault_notes v ON v.id=p.vault_note_id WHERE p.deleted_at IS NULL
) WHERE ${matchesRef} ORDER BY ${lookupOrder} LIMIT 1)`;

const paperIds = sql`
  (SELECT json_group_array(paper_id) FROM (
    SELECT DISTINCT ids.value AS paper_id FROM json_each(n.frontmatter, '$.papers') r
    CROSS JOIN json_each((SELECT json_group_array(paper_id) FROM (
      ${identifierCandidates("arxiv", sql`lower(r.value)`)}
      UNION ALL
      ${identifierCandidates("doi", sql`lower(r.value)`)}
    ))) ids
    ORDER BY paper_id
  ))`;

export async function publishVaultIndex(
  db: Database,
  input: z.output<typeof indexCommit>,
  now: string,
) {
  const { snapshot, previous, parts, count, changes } = input;
  const current = await getVaultIndex(db);
  if (current.snapshot === snapshot) {
    if (previous === snapshot && changes === 0) {
      if (count !== current.count) return { published: false, rowsWritten: 0 };
      const rowsWritten = await atomic(db, [
        updateVaultTitleMatches(
          sql`EXISTS(SELECT 1 FROM vault_sync WHERE snapshot=${snapshot})`,
        ),
      ]);
      return {
        published: (await getVaultIndex(db)).snapshot === snapshot,
        rowsWritten,
      };
    }
    return { published: true, rowsWritten: 0 };
  }
  const token = crypto.randomUUID();
  const staged = sql`SELECT * FROM vault_staged_notes WHERE snapshot=${snapshot} AND part < ${parts}`;
  const claimed = sql`EXISTS (SELECT 1 FROM vault_sync WHERE publish_token=${token})`;
  const removals = sql`SELECT id FROM vault_staged_removals WHERE snapshot=${snapshot} AND part < ${parts}`;
  const deltaIds = sql`SELECT id FROM (${staged}) UNION ALL SELECT id FROM (${removals})`;
  const liveAdds = sql`SELECT count(*) FROM (${staged}) s LEFT JOIN vault_notes n ON n.id=s.id
    WHERE n.id IS NULL OR n.deleted_at IS NOT NULL`;
  const liveRemovals = sql`SELECT count(*) FROM (${removals}) s CROSS JOIN vault_notes n ON n.id=s.id
    WHERE n.deleted_at IS NULL`;
  const changed = sql`SELECT id FROM (${deltaIds})`;
  const projectsTouched = sql`EXISTS (SELECT 1 FROM (${staged}) WHERE kind='project')
    OR EXISTS (SELECT 1 FROM (${changed}) c CROSS JOIN projects p ON p.vault_note_id=c.id)`;
  const ideasTouched = sql`EXISTS (SELECT 1 FROM (${staged}) WHERE kind='idea')
    OR EXISTS (SELECT 1 FROM (${changed}) c CROSS JOIN idea_index i ON i.id=c.id)`;
  const rowsWritten = await atomic(db, [
    sql`UPDATE vault_sync SET snapshot=${snapshot}, publish_token=${token}, note_count=${count}
      WHERE snapshot IS ${previous}
      AND (SELECT count(*) FROM vault_index_parts WHERE snapshot=${snapshot} AND part < ${parts})=${parts}
      AND (SELECT count(*) FROM (${deltaIds}))=${changes}
      AND (SELECT count(DISTINCT id) FROM (${deltaIds}))=${changes}
      AND note_count + (${liveAdds}) - (${liveRemovals}) = ${count}`,
    sql`INSERT INTO vault_notes(id,path,kind,title,frontmatter,hash,body_hash,fingerprint,synced_at,title_norm,body_md)
      SELECT id,path,kind,title,frontmatter,hash,body_hash,fingerprint,${now},title_norm,body_md FROM (${staged}) WHERE ${claimed}
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,frontmatter=excluded.frontmatter,
        hash=excluded.hash,body_hash=excluded.body_hash,fingerprint=excluded.fingerprint,synced_at=excluded.synced_at,
        body_md=excluded.body_md,
        deleted_at=NULL,title_norm=excluded.title_norm,title_paper_id=NULL
      WHERE vault_notes.fingerprint IS NOT excluded.fingerprint OR vault_notes.deleted_at IS NOT NULL`,
    sql`INSERT INTO projects(id,slug,title,status,summary,vault_note_id,updated_at)
      SELECT id, lower(replace(title, ' ', '-')) || '-' || substr(id,1,12),
        title, coalesce(frontmatter ->> 'status', 'active'), frontmatter ->> 'description', id, ${now}
      FROM vault_notes WHERE ${claimed} AND kind='project' AND id IN (SELECT id FROM (${staged}))
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, slug=excluded.slug,
        status=excluded.status, summary=excluded.summary, updated_at=excluded.updated_at, deleted_at=NULL
      WHERE projects.title IS NOT excluded.title OR projects.status IS NOT excluded.status
        OR projects.summary IS NOT excluded.summary OR projects.deleted_at IS NOT NULL`,
    // A note that leaves the index takes its uploaded body with it.
    sql`UPDATE vault_notes SET deleted_at=${now}, body_md=NULL WHERE ${claimed} AND deleted_at IS NULL
      AND id IN (${removals})`,
    sql`UPDATE projects SET deleted_at=${now} WHERE ${claimed} AND deleted_at IS NULL AND vault_note_id IN (
        SELECT n.id FROM (${changed}) c CROSS JOIN vault_notes n ON n.id=c.id
        WHERE n.deleted_at IS NOT NULL OR n.kind<>'project')`,
    sql`INSERT INTO idea_index(id,vault_note_id,title,status,description,project_id,paper_ids,updated_at)
      SELECT n.id,n.id,n.title,n.frontmatter ->> 'status',n.frontmatter ->> 'description',
        ${projectId},
        ${paperIds},${now}
      FROM vault_notes n WHERE ${claimed} AND n.kind='idea' AND n.deleted_at IS NULL
        AND ((${projectsTouched}) OR n.id IN (${changed}))
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,
        description=excluded.description,project_id=excluded.project_id,paper_ids=excluded.paper_ids,updated_at=excluded.updated_at
      WHERE idea_index.title IS NOT excluded.title OR idea_index.status IS NOT excluded.status OR
        idea_index.description IS NOT excluded.description OR idea_index.project_id IS NOT excluded.project_id OR
        idea_index.paper_ids IS NOT excluded.paper_ids`,
    sql`INSERT INTO working_paper_index(id,vault_note_id,title,status,project_id,idea_ids,paper_ids,updated_at)
      SELECT n.id,n.id,n.title,n.frontmatter ->> 'status',${projectId},
        (SELECT json_group_array(id) FROM (
          SELECT (SELECT id FROM (
            SELECT v.id, v.title, v.path, ${ref(sql`r.value`)} AS ref
            FROM idea_index i JOIN vault_notes v ON v.id=i.vault_note_id
            WHERE v.kind='idea' AND v.deleted_at IS NULL
          ) WHERE ${matchesRef} ORDER BY ${lookupOrder} LIMIT 1) AS id
          FROM json_each(n.frontmatter, '$.ideas') r ORDER BY r.key
        ) WHERE id IS NOT NULL),
        ${paperIds},${now}
      FROM vault_notes n WHERE ${claimed} AND n.kind='working_paper' AND n.deleted_at IS NULL
        AND ((${projectsTouched}) OR (${ideasTouched}) OR n.id IN (${changed}))
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,
        project_id=excluded.project_id,idea_ids=excluded.idea_ids,paper_ids=excluded.paper_ids,updated_at=excluded.updated_at
      WHERE working_paper_index.title IS NOT excluded.title OR working_paper_index.status IS NOT excluded.status
        OR working_paper_index.project_id IS NOT excluded.project_id
        OR working_paper_index.idea_ids IS NOT excluded.idea_ids OR working_paper_index.paper_ids IS NOT excluded.paper_ids`,
    sql`DELETE FROM idea_index WHERE ${claimed} AND vault_note_id IN (
      SELECT n.id FROM (${changed}) c CROSS JOIN vault_notes n ON n.id=c.id
      WHERE n.deleted_at IS NOT NULL OR n.kind<>'idea')`,
    sql`DELETE FROM working_paper_index WHERE ${claimed} AND vault_note_id IN (
      SELECT n.id FROM (${changed}) c CROSS JOIN vault_notes n ON n.id=c.id
      WHERE n.deleted_at IS NOT NULL OR n.kind<>'working_paper')`,
    updateVaultTitleMatches(claimed),
    sql`DELETE FROM vault_index_parts WHERE ${claimed} AND snapshot=${snapshot} AND part < ${parts}`,
  ]);
  const published = (await getVaultIndex(db)).snapshot === snapshot;
  return { published, rowsWritten };
}
