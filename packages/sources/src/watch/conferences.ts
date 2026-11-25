/**
 * Conferences: OpenAlex works of the venue published since a year before `since` and first
 * listed by OpenAlex (created_date) in the window. Proceedings arrive in yearly batches, so a
 * run can return hundreds of papers; the pipeline caps what it publishes.
 *
 * OpenAlex filters and sorts by created_date only on paid plans, so the window is applied
 * here. The scan over a year of works asks for two fields (about 90 bytes a work instead of
 * 12 KB: 12 conferences took 106 requests and 170 MB a run), and full records are fetched
 * by id for the works in the window only.
 */

import { normalizeDoi } from "@litscout/core/normalize";
import { reason, inWindow, type WatchContext } from "./context";
import { enrichment, type OpenAlexWork } from "./enrich";
import { dayOrNull, doiUrl, isNonArticleTitle, type FeedLine } from "./line";
import type { Outcome } from "./journals";
import { allows, skipLine, type Venue } from "./watchlist";

export const PER_PAGE = 200;
export const MAX_PAGES = 50;
const SCAN_SELECT = "id,created_date";
/** Ids per detail request: OpenAlex takes up to 100 values in one OR filter. */
export const DETAIL_BATCH = 50;
const SELECT =
  "id,doi,display_name,publication_date,created_date,type,authorships,abstract_inverted_index,open_access,locations";
/** OpenAlex work types that are not papers. */
export const SKIPPED_TYPES = new Set([
  "paratext",
  "erratum",
  "editorial",
  "retraction",
  "peer-review",
  "supplementary-materials",
]);

interface ConferenceWork extends OpenAlexWork {
  readonly display_name?: string | null;
  readonly publication_date?: string | null;
  readonly created_date?: string | null;
  readonly type?: string | null;
  readonly authorships?: ReadonlyArray<{
    author?: { display_name?: string | null } | null;
  }> | null;
}

export function yearBefore(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

export function conferenceLine(
  work: ConferenceWork,
  venue: string,
): FeedLine | null {
  const title = (work.display_name ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const published = dayOrNull(work.publication_date);
  if (!title || !published || isNonArticleTitle(title)) return null;
  if (SKIPPED_TYPES.has(work.type ?? "")) return null;
  const doi = normalizeDoi(work.doi) ?? null;
  const url = doi ? doiUrl(doi) : work.id;
  if (!url || !/^https?:\/\//.test(url)) return null;
  const extra = enrichment(work);
  return {
    source: "openalex",
    title,
    authors: (work.authorships ?? [])
      .map((a) => a.author?.display_name?.trim() ?? "")
      .filter(Boolean),
    venue,
    published,
    doi,
    arxiv_id: extra.arxivId,
    openreview_id: null,
    abstract: extra.abstract,
    oa_url: extra.oaUrl,
    url,
  };
}

/** "https://openalex.org/W123" → "W123"; anything else is not usable in a filter. */
function workId(id: string | null | undefined): string | null {
  const short = id?.split("/").at(-1);
  return short && /^W\d+$/.test(short) ? short : null;
}

interface Listed {
  readonly id?: string | null;
  readonly created_date?: string | null;
}

/** The venue's works first listed in the window, in OpenAlex's order, and how many were not. */
async function venueWorks(
  ctx: WatchContext,
  source: string,
): Promise<{ works: ConferenceWork[]; outside: number }> {
  const filter = `primary_location.source.id:${source.replace(/[,|]/g, "")},from_publication_date:${yearBefore(ctx.window.since)}`;
  const listed: string[] = [];
  let outside = 0;
  let cursor: string | undefined = "*";
  for (let n = 0; cursor && n < MAX_PAGES; n += 1) {
    const page: { results: Listed[]; nextCursor?: string } =
      await ctx.openalex.worksPage<Listed>({
        filter,
        select: SCAN_SELECT,
        perPage: PER_PAGE,
        cursor,
      });
    for (const work of page.results) {
      const id = workId(work.id);
      if (id && inWindow(dayOrNull(work.created_date), ctx.window))
        listed.push(id);
      else outside += 1;
    }
    cursor = page.results.length === PER_PAGE ? page.nextCursor : undefined;
  }
  const ids = [...new Set(listed)];
  const works: ConferenceWork[] = [];
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const batch = ids.slice(i, i + DETAIL_BATCH);
    const page = await ctx.openalex.worksPage<ConferenceWork>({
      filter: `openalex:${batch.join("|")}`,
      select: SELECT,
      perPage: DETAIL_BATCH,
    });
    const byId = new Map(page.results.map((work) => [workId(work.id), work]));
    works.push(...batch.flatMap((id) => byId.get(id) ?? []));
  }
  return { works, outside };
}

export async function conferenceLines(
  ctx: WatchContext,
  venues: readonly Venue[],
): Promise<Outcome> {
  const lines: FeedLine[] = [];
  const seen = new Set<string>();
  let attempted = 0;
  let failed = 0;
  let skipped = 0;
  for (const venue of venues) {
    if (!venue.openalexSource || !allows(venue, "openalex")) {
      ctx.warn(
        skipLine(venue, "no OpenAlex source, or its sources exclude OpenAlex"),
      );
      continue;
    }
    attempted += 1;
    try {
      const { works, outside } = await venueWorks(ctx, venue.openalexSource);
      skipped += outside;
      for (const work of works) {
        const kept = inWindow(dayOrNull(work.created_date), ctx.window)
          ? conferenceLine(work, venue.name)
          : null;
        const key = kept?.doi ?? kept?.url;
        if (!kept || !key) {
          skipped += 1;
        } else if (!seen.has(key)) {
          seen.add(key);
          lines.push(kept);
        }
      }
    } catch (error) {
      failed += 1;
      ctx.warn(`${venue.name}: OpenAlex failed (${reason(error)})`, error);
    }
  }
  return { lines, attempted, failed, skipped };
}
