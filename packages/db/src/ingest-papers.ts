import { compactIdentifiers } from "./compact-paper";
import { ulid } from "ulid";
import {
  legacyArxivLinkRecipes,
  storedLegacyLinks,
  type ArxivLinkRecipe,
} from "@litscout/pipeline/legacy-links";
import {
  paperSchema,
  type PaperInput,
} from "@litscout/pipeline/contracts/index";
import {
  titleKey,
  normalizeDoi,
  vaultTitleKey,
} from "@litscout/core/normalize";
import {
  upsertStatement,
  writeBatch,
  stableId,
  type IngestDatabase,
} from "./ingest-store";
import { mergeQueries, mergeWriteBound } from "./papers";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { validateRecords } from "@litscout/pipeline/records";
export function normalizeIdentifiers(paper: PaperInput) {
  return paper.identifiers.map((i) => ({
    ...i,
    value:
      i.scheme === "doi"
        ? normalizeDoi(i.value)!
        : i.scheme === "arxiv"
          ? i.value.replace(/^arxiv:/i, "").replace(/v\d+$/, "")
          : i.value,
  }));
}
async function identities(
  db: IngestDatabase,
  papers: PaperInput[],
  legacy: boolean,
) {
  if (!papers.length) return [];
  const queries = papers.map((paper) => {
    const ids = normalizeIdentifiers(paper);
    const where = ids.map(() => "(i.scheme=? AND i.value=?)").join(" OR ");
    const params = ids.flatMap(({ scheme, value }) => [scheme, value]);
    const arxiv = JSON.stringify(
      ids.filter((i) => i.scheme === "arxiv").map((i) => i.value),
    );
    const doi = JSON.stringify(
      ids.filter((i) => i.scheme === "doi").map((i) => i.value),
    );
    return db
      .prepare(
        `
      WITH canonical AS MATERIALIZED (
        SELECT DISTINCT p.id,p.deleted_at,p.created_at,0 AS compact,
          ${legacy ? "p.derived_arxiv_links" : "'[]' AS derived_arxiv_links"},p.first_seen_on,p.abstract,p.authors,
          NULL AS arxiv_id,NULL AS doi,0 AS feed_days,p.venue,p.rev
        FROM paper_ids i JOIN papers p ON p.id=i.paper_id
        WHERE ${where} ORDER BY p.created_at,p.id ${legacy ? "LIMIT 1" : ""}
      )
      SELECT * FROM canonical UNION ALL
      SELECT i.paper_id,NULL,i.day,1,'[]',i.day,NULL,NULL,i.arxiv_id,i.doi,
        (SELECT count(DISTINCT f.day) FROM feed_items f WHERE f.paper_id=i.paper_id),i.venue,NULL
      FROM paper_index i
      WHERE (i.arxiv_id IN (SELECT value FROM json_each(?)) OR i.doi IN (SELECT value FROM json_each(?))) AND i.has_canonical=0
        ${legacy ? "AND NOT EXISTS(SELECT 1 FROM canonical)" : ""}
      ORDER BY compact,created_at,id ${legacy ? "LIMIT 1" : ""}`,
      )
      .bind(...params, arxiv, doi);
  });
  return (await db.batch(queries)).map(
    (r) => r.results as Record<string, unknown>[],
  );
}
function metadata(
  id: string,
  day: string,
  p: PaperInput,
  existing?: Record<string, unknown>,
) {
  return {
    id,
    title: p.title,
    title_norm: titleKey(p.title),
    vault_title_norm: vaultTitleKey(p.title),
    verified: 1,
    abstract: p.abstract ?? existing?.abstract ?? null,
    authors: p.authors.length
      ? p.authors.map((name) => ({ name }))
      : (existing?.authors ?? "[]"),
    venue: p.venue,
    venue_kind: p.venueKind,
    year: p.year,
    published_on: p.publishedOn,
    primary_category: p.categories[0] ?? null,
    categories: p.categories,
    first_seen_on: existing?.first_seen_on ?? day,
    source: p.source,
    deleted_at: null,
  };
}
async function linkStatements(
  db: IngestDatabase,
  id: string,
  p: PaperInput,
  ignoreExisting = false,
) {
  const links = await Promise.all(
    p.links.map(async (l) =>
      upsertStatement(
        db,
        "paper_links",
        ["paper_id", "kind", "url"],
        {
          id: await stableId("lnk_", id + l.kind + l.url),
          paper_id: id,
          kind: l.kind,
          url: l.url,
          licence: l.licence,
          oa_status: l.oaStatus,
          source: p.source,
        },
        false,
        ignoreExisting ? "0" : "1",
      ),
    ),
  );
  return links;
}
function feedItem(
  db: IngestDatabase,
  id: string,
  day: string,
  paper: PaperInput,
  legacy = false,
) {
  return upsertStatement(
    db,
    "feed_items",
    ["day", "paper_id", "source"],
    {
      day,
      paper_id: id,
      source: paper.source,
      rank_in_source: paper.rankInSource,
      hf_upvotes: paper.hfUpvotes,
      topics: paper.topics,
      shortlisted: paper.shortlisted,
    },
    true,
    legacy ? "0" : "1",
  );
}
function identifierStatements(
  db: IngestDatabase,
  id: string,
  ids: PaperInput["identifiers"],
  legacy: boolean,
) {
  return ids.map((i) =>
    upsertStatement(
      db,
      "paper_ids",
      ["scheme", "value"],
      {
        paper_id: id,
        scheme: i.scheme,
        value: i.value,
      },
      false,
      legacy ? "0" : "1",
    ),
  );
}
async function children(
  db: IngestDatabase,
  id: string,
  day: string,
  p: PaperInput,
  legacy: boolean,
  retainedIds: PaperInput["identifiers"],
) {
  const ids = normalizeIdentifiers(p);
  const extra = retainedIds.filter(
    (i) =>
      !ids.some(
        (existing) =>
          existing.scheme === i.scheme && existing.value === i.value,
      ),
  );
  const links = await linkStatements(
    db,
    id,
    legacy ? { ...p, links: storedLegacyLinks(p) } : p,
    legacy,
  );
  return [
    ...identifierStatements(db, id, ids, legacy),
    ...identifierStatements(db, id, extra, true),
    ...links,
    feedItem(db, id, day, p, legacy),
    ...(legacy
      ? []
      : [
          upsertStatement(db, "paper_index", ["paper_id"], {
            paper_id: id,
            arxiv_id:
              [...ids, ...extra].find((i) => i.scheme === "arxiv")?.value ??
              null,
            doi:
              [...ids, ...extra].find((i) => i.scheme === "doi")?.value ?? null,
            day,
            title: p.title,
            title_norm: vaultTitleKey(p.title),
            has_canonical: 1,
            topics: p.topics,
            venue: p.venue,
          }),
        ]),
  ];
}
export class PaperMergeConflict extends Error {}

const dialect = new SQLiteAsyncDialect();
function statement(db: IngestDatabase, query: SQL) {
  const { sql, params } = dialect.sqlToQuery(query);
  return db.prepare(sql).bind(...params);
}

function mergeGroups(existing: Record<string, unknown>[][]) {
  const parent = new Map<string, string>();
  const created = new Map<string, string>();
  function root(id: string): string {
    const next = parent.get(id);
    if (!next) return id;
    const keep = root(next);
    parent.set(id, keep);
    return keep;
  }
  for (const rows of existing) {
    const ids = rows.map((row) => {
      const id = String(row.id);
      created.set(id, String(row.compact) + ":" + String(row.created_at));
      return id;
    });
    for (const id of ids.slice(1)) {
      const a = root(ids[0]!);
      const b = root(id);
      if (a === b) continue;
      const aIsOlder =
        created.get(a)! < created.get(b)! ||
        (created.get(a) === created.get(b) && a < b);
      parent.set(aIsOlder ? b : a, aIsOlder ? a : b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const drop of parent.keys()) {
    const keep = root(drop);
    const group = groups.get(keep) ?? [keep];
    group.push(drop);
    groups.set(keep, group);
  }
  return { groups, root };
}

const historicCounterCost = `SELECT coalesce(sum((j.value->>'updates') * 4 *
  ((j.value->>'incomingCounters') + (SELECT coalesce(sum(6+json_array_length(topics)),0)
    FROM feed_items WHERE paper_id=j.value->>'id'))),0) AS n FROM json_each(?1) j`;

export async function preparePaperIngest(
  db: IngestDatabase,
  day: string,
  input: unknown[],
  legacy = false,
) {
  const validation = validateRecords(day, input, (p) => paperSchema.parse(p));
  const existing = await identities(db, validation.accepted, legacy);
  const byId = new Map(existing.flat().map((row) => [String(row.id), row]));
  const { groups, root } = mergeGroups(legacy ? [] : existing);
  const seen = new Map<string, string>();
  const metadataCounts = new Map<
    string,
    { updates: number; incomingCounters: number; changesCounters: boolean }
  >();
  const entries = validation.accepted.map((paper, index) => {
    const keys = normalizeIdentifiers(paper).map(
      (i) => i.scheme + ":" + i.value,
    );
    const prior = keys.map((key) => seen.get(key)).find(Boolean);
    const id = root(
      String(existing[index]?.[0]?.id ?? prior ?? `pap_${ulid()}`),
    );
    keys.forEach((key) => seen.set(key, id));
    const row = byId.get(id);
    if (!legacy && row) {
      const priorAbstract = row.abstract as string | null;
      const counts = metadataCounts.get(id) ?? {
        updates: 0,
        incomingCounters: 0,
        changesCounters: false,
      };
      counts.updates++;
      counts.incomingCounters += 6 + paper.topics.length;
      counts.changesCounters ||=
        Boolean(row.compact || row.deleted_at) ||
        (paper.venue ?? null) !== row.venue ||
        Boolean((paper.abstract ?? priorAbstract)?.trim()) !==
          Boolean(priorAbstract?.trim());
      metadataCounts.set(id, counts);
    }
    const compactRows = (groups.get(id) ?? [id])
      .map((key) => byId.get(key))
      .filter((candidate) => candidate?.compact);
    const retainedIds = compactRows.flatMap((candidate) =>
      compactIdentifiers({
        arxivId: candidate!.arxiv_id as string | null,
        doi: candidate!.doi as string | null,
      }),
    );
    const firstDay = [
      String(row?.first_seen_on ?? day),
      ...compactRows.map((candidate) => String(candidate!.first_seen_on)),
    ].sort()[0]!;
    return {
      paper,
      id,
      stored: row?.compact ? undefined : row,
      compact: Boolean(row?.compact),
      historicDays: Number(row?.feed_days ?? 0),
      firstDay,
      retainedIds,
    };
  });
  const merges = [...groups].flatMap(([keep, group]) =>
    group.slice(1).map((drop, index) => ({
      keep,
      drop,
      bound: mergeWriteBound(
        drop,
        group,
        index === 0 ? metadataCounts.get(keep) : undefined,
      ),
    })),
  );
  const estimates = merges.length
    ? await db.batch<{ estimate: number }>(
        merges.map(({ bound }) =>
          statement(db, sql`SELECT (${bound}) AS estimate`),
        ),
      )
    : [];
  const plannedMerges = merges.map((merge, index) => ({
    ...merge,
    estimate: Number(estimates[index]!.results[0]!.estimate),
  }));
  const affected = [...metadataCounts].flatMap(([id, counts]) =>
    !groups.has(id) && counts.changesCounters ? [{ id, ...counts }] : [],
  );
  const history = affected.length ? JSON.stringify(affected) : null;
  const historyWrites = history
    ? (await db.prepare(historicCounterCost).bind(history).first<number>("n"))!
    : 0;
  return {
    legacy,
    legacyOccurrences: legacy ? await legacyFeedFacts(db, day, entries) : null,
    validation,
    entries,
    merges: plannedMerges,
    history,
    historyWrites,
    mergeWrites: plannedMerges.reduce((sum, merge) => sum + merge.estimate, 0),
  };
}

/** Read identities, then apply all changes in one transaction. Merges add a count batch. */
export async function ingestPapers(
  db: IngestDatabase,
  day: string,
  input: unknown[],
  plan?: Awaited<ReturnType<typeof preparePaperIngest>>,
) {
  const {
    legacy,
    legacyOccurrences,
    validation,
    entries,
    merges,
    history,
    historyWrites,
  } = plan ?? (await preparePaperIngest(db, day, input));
  if (!entries.length)
    return {
      papers: [],
      rowsWritten: 0,
      accepted: 0,
      skipped: validation.skipped,
      invalid: validation.invalid,
    };
  const snapshots = JSON.stringify(
    entries.flatMap(({ id, stored, compact }) =>
      stored
        ? [{ id, rev: stored.rev }]
        : compact && !legacy
          ? [{ id, rev: null }]
          : [],
    ),
  );
  const statements = [
    ...(snapshots !== "[]"
      ? [
          db
            .prepare(
              `SELECT CASE WHEN EXISTS(
      SELECT 1 FROM json_each(?) j LEFT JOIN papers p ON p.id=j.value->>'id'
      WHERE p.rev IS NOT (j.value->>'rev')
        OR (p.id IS NULL AND NOT EXISTS(SELECT 1 FROM paper_index WHERE paper_id=j.value->>'id' AND has_canonical=0))
    ) THEN json('paper identity changed') END`,
            )
            .bind(snapshots),
        ]
      : []),
    ...(history
      ? [
          db
            .prepare(
              `SELECT CASE WHEN (${historicCounterCost})>?2
      THEN json('historical counters changed') END`,
            )
            .bind(history, historyWrites),
        ]
      : []),
    db.prepare("INSERT OR IGNORE INTO feed_days(day) VALUES (?)").bind(day),
    ...merges.flatMap(({ keep, drop, bound, estimate }) => [
      statement(
        db,
        sql`SELECT CASE WHEN (${bound})<=${estimate}
        THEN 1 ELSE json('paper merge changed') END`,
      ),
      ...mergeQueries(keep, drop).map((query) => statement(db, query)),
    ]),
  ];
  const mappings: { key: string; paperId: string }[] = [];
  if (legacy) {
    const compact = entries.filter((entry) => entry.compact);
    if (compact.length) {
      // The restore can write counters for every retained feed day. Validate
      // the quoted history and the compact identity in the write transaction.
      statements.push(
        db
          .prepare(
            `SELECT CASE WHEN EXISTS (
          SELECT 1 FROM json_each(?) j LEFT JOIN paper_index i ON i.paper_id=j.value->>'id'
          WHERE i.paper_id IS NULL OR i.has_canonical<>0
            OR i.arxiv_id IS NOT (SELECT value->>'value' FROM json_each(j.value->'retainedIds') WHERE value->>'scheme'='arxiv')
            OR i.doi IS NOT (SELECT value->>'value' FROM json_each(j.value->'retainedIds') WHERE value->>'scheme'='doi')
            OR (SELECT count(DISTINCT day) FROM feed_items WHERE paper_id=i.paper_id)>j.value->>'historicDays'
        ) THEN json('legacy compact history changed') END`,
          )
          .bind(
            JSON.stringify(
              compact.map(({ id, historicDays, retainedIds }) => ({
                id,
                historicDays,
                retainedIds,
              })),
            ),
          ),
      );
    }
    const claims = entries.flatMap(({ paper, stored }) =>
      stored ? [] : normalizeIdentifiers(paper),
    );
    if (claims.length) {
      const newIds = entries
        .filter(({ stored }) => !stored)
        .map(({ id }) => id);
      statements.push(
        db
          .prepare(
            `SELECT CASE WHEN EXISTS (
        SELECT 1 FROM json_each(?) j CROSS JOIN paper_ids i
        ON i.scheme=j.value ->> 'scheme' AND i.value=j.value ->> 'value'
      ) OR EXISTS (
        SELECT 1 FROM json_each(?) j CROSS JOIN papers p ON p.id=j.value
      ) THEN json('legacy identity changed') END`,
          )
          .bind(JSON.stringify(claims), JSON.stringify(newIds)),
      );
    }
  }
  const inserted = new Set<string>();
  for (const [
    index,
    { paper: p, id, stored, firstDay, retainedIds },
  ] of entries.entries()) {
    if (legacy && stored?.deleted_at) continue;
    if (legacy && (stored || inserted.has(id))) {
      const fact = legacyOccurrences?.get(index);
      if (!fact?.occurrence) statements.push(feedItem(db, id, day, p, true));
      const ids = fact?.missingIds ?? normalizeIdentifiers(p);
      const links = fact?.missingLinks ?? p.links;
      statements.push(
        ...identifierStatements(db, id, ids, true),
        ...(await linkStatements(db, id, { ...p, links }, true)),
      );
    } else {
      statements.push(
        upsertStatement(
          db,
          "papers",
          ["id"],
          {
            ...metadata(id, firstDay, p, stored),
            first_seen_on: firstDay,
            ...(legacy
              ? { derived_arxiv_links: legacyArxivLinkRecipes(p) }
              : {}),
          },
          true,
        ),
        ...(await children(db, id, day, p, legacy, retainedIds)),
      );
      if (legacy) inserted.add(id);
    }
    mappings.push({ key: p.key, paperId: id });
  }
  return {
    papers: mappings,
    rowsWritten: await writeBatch(db, statements).catch((error: unknown) => {
      if (
        (legacy || merges.length || snapshots !== "[]") &&
        /malformed JSON/i.test(String(error))
      )
        throw new PaperMergeConflict(
          "Paper references changed while reserving writes. Retry ingest.",
        );
      throw error;
    }),
    accepted: entries.length,
    skipped: validation.skipped,
    invalid: validation.invalid,
  };
}

type FeedFacts = {
  occurrence: number;
  dayPresent: number;
  days: number;
  languages: string;
  missingIds: PaperInput["identifiers"];
  missingLinks: PaperInput["links"];
};

async function legacyFeedFacts(
  db: IngestDatabase,
  day: string,
  entries: {
    id: string;
    paper: PaperInput;
    stored: Record<string, unknown> | undefined;
  }[],
) {
  const existing = entries.flatMap(({ stored, id, paper }, index) =>
    stored && !stored.deleted_at
      ? [
          {
            id,
            paper,
            index,
            ids: normalizeIdentifiers(paper),
            links: storedLegacyLinks(
              paper,
              JSON.parse(
                String(stored.derived_arxiv_links),
              ) as ArxivLinkRecipe[],
            ),
          },
        ]
      : [],
  );
  const facts = new Map<number, FeedFacts>();
  if (!existing.length) return facts;
  const results = await db.batch<
    Omit<FeedFacts, "missingIds" | "missingLinks"> & {
      missingIds: string;
      missingLinks: string;
    }
  >(
    existing.map(({ id, paper, ids, links }) =>
      db
        .prepare(
          `SELECT
      EXISTS(SELECT 1 FROM feed_items WHERE day=? AND paper_id=? AND source=?) occurrence,
      EXISTS(SELECT 1 FROM feed_items WHERE day=? AND paper_id=?) dayPresent,
      (SELECT count(DISTINCT day) FROM feed_items WHERE paper_id=?2
        AND NOT EXISTS(SELECT 1 FROM summaries WHERE paper_id=?2)) days,
      (SELECT json_group_array(lang) FROM summaries WHERE paper_id=?2 AND kind='five_part') languages,
      (SELECT json_group_array(j.key) FROM json_each(?) j
        WHERE NOT EXISTS(SELECT 1 FROM paper_ids i
          WHERE i.scheme=j.value ->> 'scheme' AND i.value=j.value ->> 'value')) missingIds,
      (SELECT json_group_array(j.key) FROM json_each(?) j
        WHERE NOT EXISTS(SELECT 1 FROM paper_links l WHERE l.paper_id=?2
          AND l.kind=j.value ->> 'kind' AND l.url=j.value ->> 'url')) missingLinks`,
        )
        .bind(
          day,
          id,
          paper.source,
          day,
          id,
          JSON.stringify(ids),
          JSON.stringify(links),
        ),
    ),
  );
  existing.forEach(({ index, ids, links }, i) => {
    const row = results[i]!.results[0]!;
    facts.set(index, {
      ...row,
      missingIds: (JSON.parse(row.missingIds) as number[]).map(
        (key) => ids[key]!,
      ),
      missingLinks: (JSON.parse(row.missingLinks) as number[]).map(
        (key) => links[key]!,
      ),
    });
  });
  return facts;
}

/** Bound the table, index and trigger writes of the prepared transaction. */
export function legacyPaperQuote(
  plan: Awaited<ReturnType<typeof preparePaperIngest>>,
) {
  let rows = 0;
  const papers = plan.entries.map(
    ({ paper, id, stored, compact, historicDays, retainedIds }, index) => {
      if (stored?.deleted_at)
        return {
          key: paper.key,
          paperId: id,
          summaryDays: 0,
          languages: [],
          deleted: true,
        };
      const current = plan.legacyOccurrences?.get(index);
      const languages = current
        ? (JSON.parse(current.languages) as string[])
        : [];
      const summaryDays = languages.length
        ? 0
        : (current?.days ?? historicDays) + (current?.dayPresent ? 0 : 1);
      if (current)
        rows += 2 * current.missingIds.length + 3 * current.missingLinks.length;
      else
        rows +=
          6 +
          Number(compact) * (12 + 3 * historicDays + 2 * retainedIds.length) +
          2 * paper.identifiers.length +
          3 * storedLegacyLinks(paper).length;
      if (!current?.occurrence) {
        // Concurrent metadata or summary updates can enable any optional counter
        // on a pre-existing paper. Newly inserted papers have a known shape.
        const optional = stored
          ? 4
          : Number(paper.venue != null) +
            Number(!paper.abstract?.trim()) +
            Number(paper.shortlisted);
        rows += 7 + optional + new Set(paper.topics).size;
      }
      return {
        key: paper.key,
        paperId: stored || compact ? id : null,
        summaryDays,
        languages,
      };
    },
  );
  return { rows: rows && rows + 3, papers };
}
