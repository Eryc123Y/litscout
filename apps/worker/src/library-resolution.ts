import { compactPaperId, getCompactPaper } from "@litscout/db/compact-paper";
import { restoreCompactPaper } from "./compact-details";
import { dedupePapers } from "@litscout/core/dedupe";
import { samePaperEdition } from "@litscout/core/merge";
import { paperKeys } from "@litscout/core/normalize";
import { publicHttpUrl } from "@litscout/core/public-url";
import { getPaper, upsertResolvedPaper } from "@litscout/db/papers";
import { readPaper } from "@litscout/db/bounded-read";
import { preferredReadingLink } from "@litscout/db/link-checks";
import { listNotes } from "@litscout/db/quick-notes";
import { drizzle } from "drizzle-orm/d1";
import type {
  SaveCandidate,
  SaveResult,
} from "@litscout/pipeline/library-contracts";
import { addLibraryItem } from "@litscout/db/library";
import {
  doiUrl,
  identityFor,
  isPrivateAlphaXiv,
  lookupInput,
  paperIdentities,
  parsedId,
  type Identity,
} from "./paper-lookup";
import { citations, resolutionHttp } from "./resolution-http";
import { resolutionSources, type Resolved } from "./resolution-sources";
import type { AppEnv } from "./env";
import { userDay } from "./instance-day";

type Input = ReturnType<typeof lookupInput>;
type Sources = ReturnType<typeof resolutionSources>;
const stableKeys = (work: Resolved) =>
  paperKeys(work)
    .filter((key) => !key.startsWith("title:"))
    .concat(
      work.openalexId ? ["openalex:" + work.openalexId] : [],
      work.s2Id ? ["s2:" + work.s2Id] : [],
    );
const publishedDoi = (work: Resolved) =>
  paperIdentities(work).find((i) => i.scheme === "doi")?.value;
function citationWork(
  meta: Map<string, string[]>,
  page: URL,
): Resolved | undefined {
  const title = meta.get("citation_title")?.[0];
  if (!title) return undefined;
  const year = Number(
    (meta.get("citation_publication_date") ??
      meta.get("citation_date"))?.[0]?.match(/^\d{4}/)?.[0],
  );
  return {
    source: "publisher",
    verified: false,
    id: page.href,
    title,
    year: year || undefined,
    authors: (meta.get("citation_author") ?? []).map((name) => ({ name })),
    venue: (meta.get("citation_journal_title") ??
      meta.get("citation_conference_title"))?.[0],
    landing: page.href,
  };
}

async function ordered(sources: Sources, id?: Input["parsed"], title?: string) {
  for (const source of [sources.openalex, sources.crossref, sources.semantic]) {
    try {
      const works = await source(id, title);
      if (works.length) return works;
    } catch {
      // A malformed provider response falls through independently.
    }
  }
  return [];
}

function mergeEdition(work: Resolved, edition: Resolved): Resolved {
  const doi = publishedDoi(edition);
  const arxiv = paperIdentities(work).find((i) => i.scheme === "arxiv")?.value;
  const [merged] = dedupePapers([edition, { ...work, doi }], stableKeys);
  return {
    ...merged,
    ...edition,
    doi,
    arxiv: edition.arxiv ?? arxiv,
    s2Id: edition.s2Id ?? merged?.s2Id,
    access: edition.access ?? work.access,
    abstract: edition.abstract ?? work.abstract,
  };
}

async function resolve(
  env: AppEnv,
  query: string,
  input: Input,
  known = false,
) {
  const http = resolutionHttp();
  const sources = resolutionSources(env, http);
  let id = input.parsed;
  let platform = input.platform;
  let metadata: Resolved | undefined;
  if (
    platform?.scheme === "openreview" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(platform.value)
  ) {
    const params = new URLSearchParams({ id: platform.value });
    for (const host of ["api2.openreview.net", "api.openreview.net"]) {
      const response = await http.json<{
        notes?: {
          content?: Record<string, { value?: unknown } | unknown>;
          cdate?: number;
        }[];
      }>(new URL("https://" + host + "/notes?" + params));
      const note = response?.notes?.[0];
      const field = (key: string) => {
        const entry = note?.content?.[key];
        return entry && typeof entry === "object" && "value" in entry
          ? entry.value
          : entry;
      };
      const title = field("title"),
        authors = field("authors"),
        venue = field("venue");
      if (typeof title !== "string" || !title.trim()) continue;
      const doi = field("doi");
      if (typeof doi === "string") id = parsedId(doi);
      metadata = {
        id: platform.value,
        source: "openreview",
        title,
        authors: Array.isArray(authors)
          ? authors
              .filter((a): a is string => typeof a === "string")
              .map((name) => ({ name }))
          : [],
        year: Number.isFinite(note?.cdate)
          ? new Date(note!.cdate!).getUTCFullYear()
          : undefined,
        venue: typeof venue === "string" ? venue : undefined,
        landing: "https://openreview.net/forum?" + params,
      };
      break;
    }
  }
  if (!id && !metadata && input.url) {
    const page = await http.page(input.url);
    if (page) {
      const meta = citations(page.html);
      const key =
        meta.get("citation_doi")?.[0] ??
        (meta.get("citation_arxiv_id")?.[0]
          ? "arxiv:" + meta.get("citation_arxiv_id")![0]
          : "");
      const redirected = lookupInput(page.url.href);
      id = redirected.parsed ?? parsedId(key);
      platform ??= redirected.platform;
      metadata = citationWork(meta, page.url);
    }
  }
  const titleSearch = !id && !input.isUrl;
  let matches =
    id || titleSearch
      ? await ordered(sources, id, titleSearch ? query : undefined)
      : [];
  if (!matches.length && !known && id?.kind === "arxiv") {
    const page = await http.page(new URL("https://arxiv.org/abs/" + id.value));
    if (page) metadata ??= citationWork(citations(page.html), page.url);
  }
  if (!matches.length && metadata) matches = [metadata];
  if (!matches.length) return { entries: [], titleSearch };
  if (titleSearch) {
    const unique = dedupePapers(matches, stableKeys);
    matches = unique.map((p) => {
      const original = matches.find((m) =>
        stableKeys(m).some((key) => stableKeys(p).includes(key)),
      );
      return {
        ...p,
        access: original?.access,
        landing: original?.landing,
        venueKind: original?.venueKind,
      };
    });
  }
  const preprint =
    id?.kind === "arxiv" &&
    matches[0] &&
    matches[0].verified !== false &&
    !publishedDoi(matches[0])
      ? matches[0]
      : undefined;
  if (preprint) {
    const [publication, bridge] = await Promise.all([
      sources.openalex(undefined, preprint.title).catch(() => []),
      sources.semantic(id).catch(() => []),
    ]);
    const exact = bridge.find(
      (p) =>
        publishedDoi(p) &&
        (paperIdentities(p).some(
          (key) => key.scheme === "arxiv" && key.value === id!.value,
        ) ||
          samePaperEdition(preprint, p)),
    );
    const editions = publication.filter(
      (p) => publishedDoi(p) && samePaperEdition(preprint, p),
    );
    const edition = exact ?? (editions.length === 1 ? editions[0] : undefined);
    if (edition) matches[0] = mergeEdition(preprint, edition);
  }

  const entries = [];
  for (const [index, work] of matches.entries()) {
    const hinted = !titleSearch && id && identityFor(id);
    const ids: Identity[] = [
      ...paperIdentities(work),
      ...(hinted ? [hinted] : []),
      ...(!titleSearch && platform ? [platform] : []),
      ...(!titleSearch && input.url && !input.parsed
        ? [{ scheme: "url", value: input.url.href } as const]
        : []),
    ];
    const unique = [
      ...new Map(ids.map((i) => [i.scheme + ":" + i.value, i])).values(),
    ];
    const doi = unique.find((i) => i.scheme === "doi")?.value;
    const arxiv = unique.find((i) => i.scheme === "arxiv")?.value;
    const anchor = [
      "doi",
      "arxiv",
      "openalex",
      "s2",
      "openreview",
      "acl",
      "pmlr",
      "jmlr",
      "pmid",
      "dblp",
      "url",
    ]
      .map((scheme) => unique.find((i) => i.scheme === scheme))
      .find(Boolean);
    if (!anchor) continue;
    const access =
      work.access ??
      (!titleSearch && index === 0 && doi
        ? ((await sources.unpaywall(doi).catch(() => undefined)) ??
          (await sources.core(doi).catch(() => undefined)))
        : undefined);
    const oaStatus = access?.oaStatus;
    const landing =
      work.landing ?? metadata?.landing ?? work.url ?? input.url?.href;
    const links = [
      ...(access
        ? [
            {
              ...access,
              kind: "pdf_oa",
              oaStatus: [
                "gold",
                "green",
                "hybrid",
                "bronze",
                "closed",
              ].includes(oaStatus ?? "")
                ? oaStatus
                : "unknown",
            },
          ]
        : []),
      ...(arxiv
        ? [{ kind: "pdf_arxiv", url: "https://arxiv.org/pdf/" + arxiv }]
        : []),
      ...(doi ? [{ kind: "doi", url: doiUrl(doi) }] : []),
      ...(landing && (!doi || landing !== doiUrl(doi)) && publicHttpUrl(landing)
        ? [{ kind: "landing", url: landing }]
        : []),
    ];
    const candidate: SaveCandidate = {
      query:
        work.verified === false && input.url
          ? input.url.href
          : ["doi", "arxiv", "openalex", "url"].includes(anchor.scheme)
            ? anchor.value
            : anchor.scheme + ":" + anchor.value,
      verified: work.verified !== false,
      title: work.title.slice(0, 1000),
      authors: work.authors.slice(0, 50).map((a) => a.name.slice(0, 300)),
      year: Number.isInteger(work.year) ? work.year : undefined,
      venue: work.venue?.slice(0, 200),
      source: work.source,
      link: links[0] ?? null,
    };
    entries.push({
      candidate,
      record: {
        ...candidate,
        ...(work.published && /^\d{4}-\d{2}-\d{2}$/.test(work.published)
          ? { publishedOn: work.published }
          : {}),
        venueKind: work.venueKind ?? (arxiv && !doi ? "preprint" : undefined),
        authors: candidate.authors.map((name) => ({ name })),
        abstract: work.abstract?.slice(0, 20_000),
        identifiers: unique,
        links,
      },
    });
  }
  return { entries, titleSearch };
}

async function storedPaper(db: D1Database, query: string, input: Input) {
  if (query.startsWith("pap_"))
    return (
      (await getPaper(drizzle(db), query))?.id ??
      (await getCompactPaper(db, query))?.paperId
    );
  const id = (input.parsed && identityFor(input.parsed)) ?? input.platform;
  const result = id
    ? await db
        .prepare(
          "SELECT i.paper_id FROM paper_ids i JOIN papers p ON p.id=i.paper_id WHERE i.scheme=? AND i.value=? AND p.deleted_at IS NULL",
        )
        .bind(id.scheme, id.value)
        .first<string>("paper_id")
    : await db
        .prepare(
          "SELECT i.paper_id FROM paper_ids i JOIN papers p ON p.id=i.paper_id WHERE i.value=? AND p.deleted_at IS NULL ORDER BY i.scheme LIMIT 1",
        )
        .bind(input.url?.href ?? query)
        .first<string>("paper_id");
  return (
    result ??
    (await compactPaperId(db, id?.value ?? query, id?.scheme)) ??
    undefined
  );
}

export async function savePaper(
  env: AppEnv,
  query: string,
  dryRun: boolean,
  source: string,
  /** Asked for by the reader or an agent; see addLibraryItemQueries. */
  status?: "to_read" | "saved",
): Promise<SaveResult | null> {
  const db = drizzle(env.DB!);
  const input = lookupInput(query);
  if (isPrivateAlphaXiv(input.url)) return null;
  let paperId = await storedPaper(env.DB!, query, input);
  const compact = paperId ? await getCompactPaper(env.DB!, paperId) : null;
  if (compact && !dryRun) await restoreCompactPaper(env, compact.paperId);
  const { entries, titleSearch } =
    compact ||
    query.startsWith("pap_") ||
    (paperId && !input.parsed && !input.isUrl)
      ? { entries: [], titleSearch: false }
      : await resolve(env, query, input, Boolean(paperId));
  if (titleSearch)
    return { status: "confirm", candidates: entries.map((e) => e.candidate) };
  const entry = entries[0];
  if (dryRun) {
    const paperwork = !entry && paperId ? await getPaper(db, paperId) : null;
    const candidate =
      entry?.candidate ??
      (paperwork
        ? {
            query: paperwork.id,
            title: paperwork.title,
            authors: paperwork.authors.map((a) => a.name),
            venue: paperwork.venue ?? undefined,
            year: paperwork.year ?? undefined,
            source: paperwork.source,
            verified: paperwork.verified,
            link: await preferredReadingLink(db, paperwork.id),
          }
        : compact
          ? {
              query: compact.paperId,
              title: compact.title,
              authors: [],
              venue: compact.venue ?? undefined,
              source: "archive",
              verified: false,
              link: null,
            }
          : undefined);
    return { status: "confirm", candidates: candidate ? [candidate] : [] };
  }
  if (entry) {
    const result = await upsertResolvedPaper(db, entry.record);
    if (!result.ok) throw new Error("IDENTITY_CONFLICT");
    paperId = result.value.id;
  }
  if (!paperId) return null;
  const now = new Date();
  const item = await addLibraryItem(
    db,
    paperId,
    source,
    userDay(env, now),
    now.toISOString(),
    status,
  );
  return item ? { status: "saved", item, paperId } : null;
}

export async function paperDetails(env: AppEnv, query: string, full: boolean) {
  const input = lookupInput(query);
  if (isPrivateAlphaXiv(input.url)) return null;
  const id = await storedPaper(env.DB!, query, input);
  if (id) {
    const [paper, notes] = await Promise.all([
      readPaper(env.DB!, id),
      listNotes(drizzle(env.DB!), id),
    ]);
    if (paper) {
      const { links, summaries, ...record } = paper;
      return {
        record: full
          ? record
          : {
              ...record,
              abstract: record.abstract?.slice(0, 500),
              authors: record.authors.slice(0, 8),
            },
        ...(paper.compact
          ? {
              detailsStored: false,
              message: "Details are not stored for this archived paper.",
            }
          : {}),
        links,
        summary: full
          ? summaries
          : summaries.map(({ lang, content }) => ({
              lang,
              tldr: content.tldr,
            })),
        notes: notes
          .slice(0, 50)
          .map((note) =>
            full ? note : { ...note, bodyMd: note.bodyMd.slice(0, 280) },
          ),
        notesNextCursor: notes.length > 50 ? notes[49]!.id : null,
      };
    }
  }
  if (!input.parsed && !input.url && !input.platform) return null;
  const { entries } = await resolve(env, query, input);
  const record = entries[0]?.record;
  if (!record) return null;
  const { links, ...metadata } = record;
  return {
    record: full
      ? metadata
      : {
          ...metadata,
          abstract: metadata.abstract?.slice(0, 500),
          authors: metadata.authors.slice(0, 8),
        },
    summary: [],
    links,
    notes: [],
  };
}
