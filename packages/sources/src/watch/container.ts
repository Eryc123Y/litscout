/**
 * Crossref container titles (`Computer Vision – ECCV {year}`): proceedings published as volumes of
 * a book series, such as ECCV in Springer's LNCS, have no ISSN, DOI prefix or OpenAlex source of
 * their own, but every chapter carries the proceedings' title. Crossref matches the title exactly
 * (case and the en dash count); `{year}` runs from the year before --since to the year after the
 * window. As for journals, only DOIs registered in the window are asked for, so a venue's first
 * read reports that window and never a whole proceedings already out. OpenAlex then enriches by DOI.
 */

import {
  MAX_PAGES,
  ROWS,
  createdDay,
  publishedDay,
  type CrossrefItem,
} from "../sources/crossref";
import { inWindow, withYears, type WatchContext } from "./context";
import { enrichDois } from "./enrich";
import { crossrefLine, keep, type Found } from "./journals";
import type { FeedLine } from "./line";
import type { Venue } from "./watchlist";

/** Crossref types of a paper in proceedings; whole books and volumes are not papers. */
const PAPER_TYPES: ReadonlySet<string> = new Set([
  "book-chapter",
  "proceedings-article",
]);

function found(
  venue: Venue,
  title: string,
  item: CrossrefItem,
  window: WatchContext["window"],
): Found | null {
  const kept = keep(item, PAPER_TYPES);
  if (
    !kept ||
    !item["container-title"]?.includes(title) ||
    !inWindow(createdDay(item), window) ||
    !publishedDay(item)
  )
    return null;
  return { venue: venue.name, item, ...kept };
}

export async function containerLines(
  ctx: WatchContext,
  venue: Venue,
  template: string,
): Promise<FeedLine[]> {
  const papers = new Map<string, Found>();
  for (const title of withYears(template, ctx.window, ctx.today)) {
    const items = await ctx.crossref.worksByContainer(title, ctx.window);
    if (items.length >= MAX_PAGES * ROWS)
      ctx.warn(
        `${venue.name}: Crossref listed at least ${MAX_PAGES * ROWS} works of "${title}" in the window; some may be missing`,
      );
    for (const item of items) {
      const paper = found(venue, title, item, ctx.window);
      if (paper && !papers.has(paper.doi)) papers.set(paper.doi, paper);
    }
  }
  const extra = await enrichDois(ctx, [...papers.keys()]);
  return [...papers.values()].map((p) =>
    crossrefLine(p, extra.get(p.doi) ?? {}),
  );
}
