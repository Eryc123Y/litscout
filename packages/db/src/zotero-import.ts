import { sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { doiPath, titleKey, vaultTitleKey } from "@litscout/core/normalize";
import { publicHttpUrl } from "@litscout/core/public-url";
import { paperReservation } from "@litscout/pipeline/write-reservation";
import {
  newZoteroProgress,
  zoteroProgress,
  zoteroTitleEvidence,
  zoteroTitleKey,
  type ZoteroBatch,
  type ZoteroEntry,
} from "@litscout/pipeline/zotero-contracts";
import { atomic, decodeRow, type Database } from "./database";
import { stableId, type IngestDatabase } from "./ingest-store";
import { addLibraryItemQueries } from "./library";
import { newResolvedPaperQueries } from "./papers";

const cursorName = (batch: ZoteroBatch) =>
  "zotero:" + batch.format + ":" + batch.hash;

export async function zoteroCheckpoint(db: IngestDatabase, batch: ZoteroBatch) {
  const name = cursorName(batch);
  const value = await db
    .prepare("SELECT value FROM sync_cursors WHERE name=?")
    .bind(name)
    .first<string>("value");
  const progress =
    value === null
      ? newZoteroProgress()
      : zoteroProgress.parse(JSON.parse(value));
  return { name, value, progress };
}
type Checkpoint = Awaited<ReturnType<typeof zoteroCheckpoint>>;

type Candidate = {
  id: string;
  rev: number;
  priority: number;
  title: string;
  authors: { name: string }[];
  year: number | null;
  verified: boolean;
  deletedAt: string | null;
  doi: string | null;
  arxiv: string | null;
};

function candidateQuery(entry: ZoteroEntry, fallback: string) {
  const ascii = entry.title && titleKey(entry.title);
  const unicode = entry.title && vaultTitleKey(entry.title);
  const byTitle =
    unicode && (entry.authors.length || entry.year)
      ? sql`UNION ALL SELECT id,4 FROM (
      SELECT id FROM papers WHERE deleted_at IS NULL AND (
        vault_title_norm=${unicode} OR title_norm=${ascii || null}
        OR (title_norm='' AND title=${entry.title}))
      LIMIT 21
    )`
      : sql``;
  return sql`
    WITH related(id,priority) AS (
      SELECT paper_id,1 FROM paper_ids WHERE scheme='doi' AND value=${entry.doi ?? null}
      UNION ALL SELECT paper_id,2 FROM paper_ids WHERE scheme='arxiv' AND value=${entry.arxiv ?? null}
      UNION ALL SELECT id,3 FROM papers WHERE id=${fallback}
      ${byTitle}
    )
    SELECT p.id,p.rev,min(r.priority) AS priority,p.title,p.authors,p.year,p.verified,p.deleted_at,
      (SELECT value FROM paper_ids WHERE paper_id=p.id AND scheme='doi' LIMIT 1) AS doi,
      (SELECT value FROM paper_ids WHERE paper_id=p.id AND scheme='arxiv' LIMIT 1) AS arxiv
    FROM related r JOIN papers p ON p.id=r.id
    GROUP BY p.id ORDER BY priority,p.id`;
}

function findCandidate(entry: ZoteroEntry, candidates: Candidate[]) {
  const exact = candidates.find((p) => p.priority < 4 && !p.deletedAt);
  if (exact) return exact;
  const title = zoteroTitleKey(entry.title);
  const matches = candidates.filter(
    (p) =>
      p.priority === 4 &&
      title === zoteroTitleKey(p.title) &&
      (!p.doi || !entry.doi || p.doi === entry.doi) &&
      (!p.arxiv || !entry.arxiv || p.arxiv === entry.arxiv) &&
      zoteroTitleEvidence(entry, {
        authors: p.authors.map((author) => author.name),
        year: p.year,
      }),
  );
  // An overfull candidate set cannot establish a unique title match.
  if (
    matches.length === 1 &&
    candidates.filter((p) => p.priority === 4).length < 21
  )
    return matches[0];
  return candidates.find((p) => p.priority < 4);
}

function newPaper(entry: ZoteroEntry, title: string) {
  const identifiers = [
    ...(entry.doi ? [{ scheme: "doi" as const, value: entry.doi }] : []),
    ...(entry.arxiv ? [{ scheme: "arxiv" as const, value: entry.arxiv }] : []),
  ];
  const doi = entry.doi && "https://doi.org/" + doiPath(entry.doi);
  const arxiv = entry.arxiv && "https://arxiv.org/pdf/" + entry.arxiv;
  const landing = publicHttpUrl(entry.url ?? "")?.href;
  return {
    title,
    source: "zotero",
    verified: identifiers.length > 0,
    authors: entry.authors.map((name) => ({ name })),
    year: entry.year,
    abstract: entry.abstract,
    venue: entry.venue,
    identifiers,
    links: [
      ...(doi ? [{ kind: "doi" as const, url: doi }] : []),
      ...(arxiv ? [{ kind: "pdf_arxiv" as const, url: arxiv }] : []),
      ...(landing && landing !== doi && landing !== arxiv
        ? [{ kind: "landing" as const, url: landing }]
        : []),
    ],
  };
}

const snapshot = (candidate: Candidate) => [
  candidate.id,
  candidate.rev,
  candidate.priority,
  candidate.doi,
  candidate.arxiv,
];

const dialect = new SQLiteAsyncDialect();

export async function planZoteroBatch(
  db: IngestDatabase,
  batch: ZoteroBatch,
  records: ZoteroEntry[],
  checkpoint: Checkpoint | undefined,
  day: string,
  now: string,
) {
  const entries = await Promise.all(
    records.map(async (entry) => {
      // For identifierless records, identical normalised data can be replayed
      // across exports even when there is no author or year for title matching.
      const id = await stableId(
        "pap_",
        JSON.stringify([
          "zotero",
          entry.doi,
          entry.arxiv,
          zoteroTitleKey(entry.title) || entry.title,
          entry.year,
          entry.authors,
        ]),
      );
      const query = candidateQuery(entry, id);
      const compiled = dialect.sqlToQuery(query);
      return {
        entry,
        id,
        query,
        statement: db.prepare(compiled.sql).bind(...compiled.params),
      };
    }),
  );
  const results = await db.batch<Record<string, unknown>>(
    entries.map((item) => item.statement),
  );
  const progress = {
    ...(checkpoint?.progress ?? newZoteroProgress()),
    next: batch.offset + batch.entries.length,
  };
  progress.duplicates += batch.entries.length - records.length;
  const guards: SQL[] = [];
  const writes: SQL[] = [];
  const unresolved: number[] = [];
  let cost = 4; // Insert or advance the checkpoint.
  for (const [index, { entry, id, query }] of entries.entries()) {
    const candidates = results[index]!.results.map(decodeRow<Candidate>);
    const existing = findCandidate(entry, candidates);
    // Check all planned matches before the first mutation. A concurrent save,
    // import, or merge can then force a replan instead of creating a duplicate.
    guards.push(sql`SELECT CASE WHEN (
      SELECT json_group_array(json_array(id,rev,priority,doi,arxiv)) FROM (${query})
    )=${JSON.stringify(candidates.map(snapshot))} THEN 1 ELSE json('revision conflict') END`);
    if (!existing && !entry.title) {
      progress.invalid++;
      unresolved.push(index);
      continue;
    }
    if (existing) {
      progress.linked++;
      if (!existing.verified) progress.unverified++;
      if (existing.deletedAt)
        writes.push(
          sql`UPDATE papers SET deleted_at=NULL,updated_at=${now},rev=rev+1 WHERE id=${existing.id}`,
        );
    } else {
      const paper = newPaper(entry, entry.title!);
      progress.new++;
      if (!paper.verified) progress.unverified++;
      writes.push(...newResolvedPaperQueries(id, paper, now));
      cost += paperReservation(paper);
    }

    writes.push(
      ...addLibraryItemQueries(existing?.id ?? id, "cli", day, now, entry.tags),
    );
    cost += 12; // Save event, library tags and indexes, and possible reactivation.
  }
  return { progress, cost, guards, writes, unresolved };
}

export async function applyZoteroBatch(
  db: Database,
  checkpoint: Checkpoint,
  plan: Awaited<ReturnType<typeof planZoteroBatch>>,
  now: string,
) {
  return atomic(db, [
    sql`SELECT CASE WHEN (SELECT value FROM sync_cursors WHERE name=${checkpoint.name}) IS ${checkpoint.value}
      THEN 1 ELSE json('revision conflict') END`,
    ...plan.guards,
    ...plan.writes,
    sql`INSERT INTO sync_cursors(name,value,updated_at)
      VALUES (${checkpoint.name},${JSON.stringify(plan.progress)},${now})
      ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  ]);
}
