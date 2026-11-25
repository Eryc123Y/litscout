import type { ListPaper } from "@litscout/pipeline/read-contracts";
import { behindDays, type DayLike } from "@litscout/pipeline/day-gaps";
import type { WebPaper } from "@litscout/pipeline/web-contracts";
import { daySchema } from "@litscout/pipeline/contracts/index";
/** The old site's hash keys (LitScout Daily, js/app.js writeHash). */
const legacyKeys = [
  "day",
  "from",
  "topic",
  "paper",
  "venue",
  "type",
  "area",
  "code",
  "free",
  "stream",
  "week",
];
/** Its venue type filter as the new reader's kind and top-venue filters. */
const legacyTypes: Record<string, Record<string, string>> = {
  arxiv: { kind: "preprint" },
  conference: { kind: "conference", top: "true" },
  journal: { kind: "journal", top: "true" },
};
/**
 * The new page for a link of the old LitScout Daily site, or null when the
 * hash is not one. A topic the instance no longer has is left out
 * rather than shown as an empty filter.
 */
export function legacyRoute(
  hash: string,
  isPublic: boolean,
  topics?: readonly string[],
) {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  if (!legacyKeys.some((k) => p.has(k))) return null;
  const prefix = isPublic ? "/public" : "/app";
  if (p.get("stream") === "venues") {
    // The new reader has no week view: the day list from that week's end.
    const week = daySchema.safeParse(p.get("week"));
    return week.success
      ? `${prefix}/days?before=${shiftIsoDay(week.data, 7)}`
      : `${prefix}/days`;
  }
  const day = daySchema.safeParse(p.get("day"));
  const query = new URLSearchParams();
  const topic = p.get("topic");
  // An empty list says nothing about the instance's topics: keep the topic.
  if (topic && (!topics?.length || topics.includes(topic)))
    query.set("topic", topic);
  if (p.get("paper")) query.set("paper", p.get("paper")!);
  if (p.get("venue")) query.set("venue", p.get("venue")!);
  for (const [key, value] of Object.entries(
    legacyTypes[p.get("type") ?? ""] ?? {},
  ))
    query.set(key, value);
  return `${prefix}/${day.success ? `days/${day.data}` : "today"}${query.size ? `?${query}` : ""}`;
}
function shiftIsoDay(day: string, days: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export type Filters = {
  q?: string;
  topic?: string;
  source?: string;
  venue?: string;
  /** Venue type: preprint, conference or journal. */
  kind?: string;
  /** Only the instance's top venues. */
  top?: boolean;
  shortlisted?: boolean;
  unread?: boolean;
  /** Only papers that link public code. */
  code?: boolean;
  /** The reader's decision: to_read, saved or skipped. */
  decision?: string;
};
export function filterPapers<T extends WebPaper | ListPaper>(
  papers: T[],
  filters: Filters,
) {
  const q = filters.q?.trim().toLowerCase();
  return papers.filter(
    (p) =>
      (!filters.topic || p.topics.includes(filters.topic)) &&
      (!filters.source || p.source === filters.source) &&
      (!filters.venue || p.venue === filters.venue) &&
      (!filters.shortlisted || p.shortlisted) &&
      (!q ||
        [p.title, ...p.authors.map((a) => a.name)]
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
}
export function dayLabel(status: string, keywordOnly = false) {
  return (
    (
      {
        pending: "Pending announcement",
        empty: "No announcement",
        crawled: keywordOnly ? "Keyword list" : "Summaries in progress",
        summarised: "Summaries ready",
        digested: "Digest ready",
        final: "Final digest",
      } as Record<string, string>
    )[status] ?? status
  );
}
/**
 * Labels for a page of days. On the recent page, a crawled day the runs
 * skipped (a later listing was read instead) says so rather than "in
 * progress". Older pages lack the target, so they use the plain labels.
 */
export function dayLabels(
  days: readonly DayLike[],
  keywordOnly = false,
  recent = true,
) {
  const skipped = recent ? behindDays(days) : new Set<string>();
  return new Map(
    days.map((day) => [
      day.day,
      skipped.has(day.day)
        ? "Skipped: no digest"
        : dayLabel(day.status, keywordOnly),
    ]),
  );
}
export function monthDays(month: string) {
  const date = new Date(`${month}-01T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return [];
  return Array.from(
    {
      length: new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
      ).getUTCDate(),
    },
    (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
  );
}
export function today(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function matchesPaper(
  p: Pick<WebPaper, "paperId" | "identifiers">,
  id: string,
) {
  return (
    p.paperId === id ||
    p.identifiers.some((i) => i.value === id || `${i.scheme}:${i.value}` === id)
  );
}
export function safeUrl(url: string | undefined) {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return ["http:", "https:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function calendarOffset(month: string) {
  return (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
}
