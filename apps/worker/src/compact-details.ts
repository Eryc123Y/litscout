import { getCompactPaper, type CompactPaper } from "@litscout/db/compact-paper";
import { normalizeDoi } from "@litscout/core/normalize";
import { PaperMergeConflict } from "@litscout/db/ingest-papers";
import { upsertResolvedPaper } from "@litscout/db/papers";
import {
  reserveWriteBudget,
  settleWriteBudget,
  writeLimit,
} from "@litscout/db/write-budget";
import { createArxivClient } from "@litscout/sources/sources/arxiv";
import { acquireSource } from "@litscout/sources/limiter/source-limiter";
import { drizzle } from "drizzle-orm/d1";
import { doiUrl, parsedId, paperIdentities } from "./paper-lookup";
import { boundedText, resolutionHttp } from "./resolution-http";
import { resolutionSources, type Resolved } from "./resolution-sources";
import type { AppEnv } from "./env";
import { WriteQuotaError } from "./write-quota";

export async function compactDetails(env: AppEnv, paper: CompactPaper) {
  const arxiv = paper.arxivId ? parsedId("arxiv:" + paper.arxivId) : undefined;
  const doi = normalizeDoi(paper.doi);
  const doiIdentity =
    doi && !doi.split("/").some((part) => part === "." || part === "..")
      ? parsedId(doi)
      : undefined;
  const arxivId = arxiv?.value;
  const lookupArxiv =
    arxivId ?? (doiIdentity?.kind === "arxiv" ? doiIdentity.value : undefined);
  const identifiers = [
    ...(arxivId ? [{ scheme: "arxiv" as const, value: arxivId }] : []),
    ...(doi && doiIdentity ? [{ scheme: "doi" as const, value: doi }] : []),
  ];
  const sources = resolutionSources(env, resolutionHttp(1));
  const identity = doiIdentity ?? arxiv;
  const matches = (work: Resolved) =>
    paperIdentities(work).some((i) =>
      [arxiv, doiIdentity].some(
        (retained) => retained?.kind === i.scheme && retained.value === i.value,
      ),
    );
  const found = identity
    ? (await sources.openalex(identity, undefined, true).catch(() => [])).find(
        matches,
      )
    : undefined;
  let fallback: Resolved | undefined;
  if ((!found?.abstract && lookupArxiv) || (!found && doiIdentity)) {
    const arxiv = createArxivClient({
      acquire: () => acquireSource(env, "arxiv"),
      fetchImpl: async (input, init) => {
        const reply = await fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(4500),
        });
        if (!reply.ok) return reply;
        return new Response(await boundedText(reply, 192 * 1024), {
          status: reply.status,
          headers: reply.headers,
        });
      },
    });
    const candidates = await (
      lookupArxiv ? arxiv.byIds([lookupArxiv]) : arxiv.byTitle(paper.title, 3)
    ).catch(() => []);
    fallback = candidates.find(matches);
  }
  const work = found ?? fallback;
  const links = [
    ...(arxivId
      ? [
          {
            kind: "pdf_arxiv" as const,
            url: "https://arxiv.org/pdf/" + arxivId,
          },
        ]
      : []),
    ...(doi && doiIdentity ? [{ kind: "doi" as const, url: doiUrl(doi) }] : []),
  ];
  return {
    title: paper.title,
    venue: paper.venue ?? work?.venue?.slice(0, 200) ?? null,
    source: work?.source ?? "archive",
    abstract: (work?.abstract ?? fallback?.abstract)?.slice(0, 20_000) ?? null,
    authors: (work?.authors.length ? work.authors : (fallback?.authors ?? []))
      .slice(0, 50)
      .map(({ name }) => ({ name: name.slice(0, 300) })),
    year: Number.isInteger(work?.year) ? work!.year : undefined,
    publishedOn: work?.published?.match(/^\d{4}-\d{2}-\d{2}/)?.[0],
    identifiers,
    links,
    available: Boolean(work),
  };
}

export async function restoreCompactPaper(env: AppEnv, id: string) {
  const db = env.DB!;
  const compact = await getCompactPaper(db, id);
  if (!compact) return;
  const maxFeedDays = (await db
    .prepare("SELECT count(DISTINCT day) AS n FROM feed_items WHERE paper_id=?")
    .bind(id)
    .first<number>("n"))!;
  const bound = 32 + 3 * maxFeedDays;
  const lease =
    bound <= writeLimit() ? await reserveWriteBudget(db, bound) : null;
  if (!lease) throw new WriteQuotaError(bound);
  let restored: Awaited<ReturnType<typeof upsertResolvedPaper>>;
  try {
    const details = await compactDetails(env, compact);
    restored = await upsertResolvedPaper(
      drizzle(db),
      {
        ...details,
        venue: details.venue ?? undefined,
        verified: details.available,
      },
      { ...compact, maxFeedDays, utcDay: lease.day },
    );
  } catch (error) {
    await settleWriteBudget(db, lease, 0, true);
    throw error;
  }
  const written = restored.rowsWritten ?? 0;
  await settleWriteBudget(db, lease, written, false, {
    rowsBeforeMidnight: written,
  });
  if (!restored.ok)
    throw new PaperMergeConflict(
      "The archived paper changed while restoring it. Retry the action.",
    );
}
