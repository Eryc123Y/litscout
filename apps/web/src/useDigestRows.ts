import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  digestRowsSchema,
  type DigestReference,
  type DigestRow,
  type WebFeed,
} from "@litscout/pipeline/web-contracts";
import { apiGet } from "./api";
export const referenceKey = (ref: DigestReference) =>
  JSON.stringify([ref.paperId, ref.source, ref.day]);
export function useDigestRows(
  day: string,
  refs: DigestReference[],
  feed: WebFeed,
) {
  const client = useQueryClient();
  const rows = new Map<
    string,
    Pick<DigestRow, "paperId" | "source" | "title" | "topics">
  >(
    feed.items.map((paper) => [
      referenceKey({ ...paper, day: feed.day }),
      paper,
    ]),
  );
  // Reuse metadata from other filters/pages already read for this private day.
  for (const [, cached] of client.getQueriesData<{ pages: WebFeed[] }>({
    queryKey: ["feed", false, day],
  }))
    for (const page of cached?.pages ?? [])
      for (const paper of page.items)
        rows.set(referenceKey({ ...paper, day: page.day }), paper);
  // Retain already resolved rows when more radar hits expand the current batch.
  for (const [, cached] of client.getQueriesData<{ items: DigestRow[] }>({
    queryKey: ["digest-rows", day],
  }))
    for (const row of cached?.items ?? []) rows.set(referenceKey(row), row);
  for (const paper of feed.items)
    rows.set(referenceKey({ ...paper, day: feed.day }), paper);
  // The digest names its own papers: a reference that came with its title
  // needs no lookup. Only older responses fall through to /references.
  for (const ref of refs)
    if (ref.title && ref.source && !rows.has(referenceKey(ref)))
      rows.set(referenceKey(ref), {
        paperId: ref.paperId,
        source: ref.source,
        title: ref.title,
        topics: ref.topics ?? [],
      });
  const missing = [
    ...new Map(
      refs
        .filter((ref) => ref.source && !rows.has(referenceKey(ref)))
        .map(({ paperId, source, day }) => [
          referenceKey({ paperId, source, day }),
          { paperId, source, day },
        ]),
    ).values(),
  ];
  const groups = Array.from(
    { length: Math.ceil(missing.length / 50) },
    (_, i) => missing.slice(i * 50, (i + 1) * 50),
  );
  const queries = useQueries({
    queries: groups.map((group) => ({
      queryKey: ["digest-rows", day, JSON.stringify(group)],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiGet(
          `/feed/days/${day}/references?${new URLSearchParams({ ids: JSON.stringify(group) })}`,
          digestRowsSchema,
          signal,
        ),
    })),
  });
  for (const query of queries)
    for (const row of query.data?.items ?? []) rows.set(referenceKey(row), row);
  return { rows, pending: queries.some((query) => query.isPending) };
}
export type DigestRows = ReturnType<typeof useDigestRows>["rows"];
