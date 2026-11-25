import type {
  WebFeed,
  WebPaper,
  WebDay,
} from "@litscout/pipeline/web-contracts";
/** Explicit nested allowlists; trusted stored rows need projection, not output validation. */
function common(p: WebPaper | WebFeed["items"][number]) {
  return {
    paperId: p.paperId,
    title: p.title,
    authors: p.authors.map((a) => ({ name: a.name })),
    source: p.source,
    topics: p.topics,
    shortlisted: p.shortlisted,
    identifiers: p.identifiers.map((i) => ({
      scheme: i.scheme,
      value: i.value,
    })),
    venue: p.venue ?? null,
    venueKind: p.venueKind ?? "preprint",
    year: p.year ?? null,
    publishedOn: p.publishedOn ?? null,
    categories: p.categories ?? [],
    hfUpvotes: p.hfUpvotes ?? null,
  };
}
export function publicPaper(value: unknown): WebPaper {
  const p = value as WebPaper;
  return {
    ...common(p),
    abstract: p.abstract,
    links: p.links.map((l) => ({
      kind: l.kind,
      url: l.url,
      checkedAt: l.checkedAt,
      httpStatus: l.httpStatus,
      oaStatus: l.oaStatus,
    })),
    summaries: p.summaries.map((s) => ({
      lang: s.lang,
      content: {
        tldr: s.content.tldr,
        motivation: s.content.motivation,
        method: s.content.method,
        result: s.content.result,
        conclusion: s.content.conclusion,
      },
    })),
  };
}
export function publicFeed(value: unknown, keywordOnly = false): WebFeed {
  const f = value as WebFeed;
  return {
    day: f.day,
    status: f.status,
    nextCursor: f.nextCursor,
    counts: {
      total: f.counts.total,
      summarised: f.counts.summarised,
      shortlisted: f.counts.shortlisted,
      arxiv: f.counts.arxiv,
      venues: f.counts.venues,
      topics: { ...f.counts.topics },
      sources: { ...f.counts.sources },
      venueCounts: { ...f.counts.venueCounts },
    },
    items: f.items.map((p) => ({
      ...common(p),
      authorCount: p.authorCount,
      ...(keywordOnly ? { abstract: p.abstract ?? null } : {}),
      ...(p.hasAbstract === undefined ? {} : { hasAbstract: p.hasAbstract }),
      tldr: p.tldr.map((s) => ({ lang: s.lang, text: s.text })),
    })),
  };
}
export function publicDays(value: unknown): WebDay[] {
  return (value as WebDay[]).map((d) => ({
    day: d.day,
    status: d.status,
    counts: {
      total: d.counts.total ?? 0,
      sources: { ...d.counts.sources },
      // The topic count is public; how much was read is not.
      ...(d.counts.shortlisted === undefined
        ? {}
        : { shortlisted: d.counts.shortlisted }),
    },
  }));
}
