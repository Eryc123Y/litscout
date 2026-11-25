import { z } from "zod";
import { schemas, feedItemSchema } from "./contracts/index";
import { historyPageSchema } from "./read-contracts";
import type { FeedApi } from "./api";
const pageSchema = z.object({
  day: z.string(),
  status: schemas.feedDay.shape.status,
  counts: z.record(z.string(), z.unknown()),
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable().optional(),
});
function sourceCounts(counts: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(
      counts.sources && typeof counts.sources === "object"
        ? counts.sources
        : counts,
    ).filter(([, v]) => typeof v === "number"),
  ) as Record<string, number>;
}
/** One bounded request per full page, preserving (paper, source) rows. */
export async function loadFullFeed(
  api: Pick<FeedApi, "get">,
  day: string,
  ids?: string[],
) {
  const items = [],
    seen = new Set<string>();
  let cursor: string | null | undefined, header;
  do {
    const q = new URLSearchParams();
    if (cursor) q.set("cursor", cursor);
    if (ids) q.set("ids", ids.join(","));
    const page = pageSchema.parse(
      await api.get(`/feed/days/${day}/full${q.size ? `?${q}` : ""}`),
    );
    header ??= page;
    items.push(...z.array(feedItemSchema).max(50).parse(page.items));
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Repeated feed cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return schemas.feed.parse({
    day,
    status: header.status,
    counts: sourceCounts(header.counts),
    items,
  });
}
export async function loadDayInfo(api: Pick<FeedApi, "get">, day: string) {
  const page = pageSchema.parse(await api.get(`/feed/days/${day}?limit=1`)),
    counts = sourceCounts(page.counts);
  return {
    day,
    status: page.status,
    counts,
    total:
      typeof page.counts.total === "number"
        ? page.counts.total
        : Math.max(
            page.items.length,
            Object.values(counts).reduce((n, v) => n + v, 0),
          ),
  };
}
export async function loadHistory(
  api: Pick<FeedApi, "get">,
  from: string,
  to: string,
) {
  const items = [],
    seen = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const q = new URLSearchParams({ from, to });
    if (cursor) q.set("cursor", cursor);
    const page = historyPageSchema.parse(await api.get(`/feed/history?${q}`));
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Repeated history cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  const days = new Map<string, typeof items>();
  for (const item of items) {
    const list = days.get(item.day) ?? [];
    list.push(item);
    days.set(item.day, list);
  }
  return [...days]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, items]) => ({
      day,
      items: items.sort(
        (a, b) =>
          (a.rankInSource ?? -1) - (b.rankInSource ?? -1) ||
          a.paperId.localeCompare(b.paperId) ||
          a.source.localeCompare(b.source),
      ),
    }));
}
