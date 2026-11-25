import type { HistoryPaper } from "./read-contracts";
import {
  behindDays,
  hasListing,
  latestListing,
  readingDay,
  shiftDay,
} from "./day-gaps";
export { readingDay, shiftDay } from "./day-gaps";
import { loadHistory, loadDayInfo } from "./read-client";
import { batchResponse, type InvalidRecord } from "./records";
import { z } from "zod";
import {
  schemas,
  paperSchema,
  type PaperInput,
  type FeedItem,
} from "./contracts/index";
import type { FeedApi } from "./api";
import { chunks } from "./api";
import { topicsFor, type Topic } from "./topics";
import { dedupe, type LegacyRecord } from "./dedupe";
import { nextStatus } from "./status";
import { listingCursorSchema } from "./contracts/limits";
import { plannedWriteRows, writeOverhead } from "./ingest-batching";
import { paperReservation } from "./write-reservation";
export type ListingCursor = z.output<typeof listingCursorSchema>;
export const daysSchema = z.array(
  z.object({
    day: z.iso.date(),
    status: schemas.feedDay.shape.status,
    counts: z
      .object({
        arxiv: z.number().optional(),
        sources: z.object({ arxiv: z.number().optional() }).optional(),
      })
      .optional(),
  }),
);
type DayRow = z.output<typeof daysSchema>[number];
export const readDays = async (api: FeedApi) =>
  daysSchema.parse(await api.get("/feed/days?limit=100"));
export function lastReportedListing(days: DayRow[], through: string) {
  return latestListing(
    days,
    (row) => ["digested", "final"].includes(row.status),
    through,
  );
}
export function externalId(
  p: Pick<FeedItem, "paperId" | "identifiers">,
): string {
  const i = p.identifiers.find((v) => v.scheme === "arxiv") ?? p.identifiers[0];
  return i
    ? i.scheme === "arxiv"
      ? i.value
      : i.scheme + ":" + i.value
    : p.paperId;
}
export function legacyRecord(
  p: Pick<FeedItem, "paperId" | "identifiers" | "title" | "authors">,
): LegacyRecord {
  return {
    id: externalId(p),
    title: p.title,
    authors: p.authors.map((a) => a.name),
    doi: p.identifiers.find((i) => i.scheme === "doi")?.value,
  };
}
export function fromFeedItem(p: FeedItem | HistoryPaper): PaperInput {
  return paperSchema.parse({
    key: externalId(p),
    title: p.title,
    abstract: "abstract" in p ? p.abstract : null,
    // History carries only the first four authors. An empty update preserves the stored list.
    authors: "abstract" in p ? p.authors.map((a) => a.name) : [],
    source: p.source,
    venue: p.venue,
    venueKind: p.venueKind,
    year: p.year,
    publishedOn: p.publishedOn,
    categories: p.categories,
    identifiers: p.identifiers,
    links: ("links" in p ? p.links : []).map(
      ({ kind, url, licence, oaStatus }) => ({
        kind,
        url,
        licence,
        oaStatus,
      }),
    ),
    topics: p.topics,
    shortlisted: p.shortlisted,
    rankInSource: p.rankInSource,
    hfUpvotes: p.hfUpvotes,
  });
}
export async function dailyStatus(api: FeedApi, through?: string) {
  const days = await readDays(api);
  const target = readingDay(days, through);
  // The same rule the web reader uses to call a day skipped.
  const skipped = behindDays(days, through);
  return schemas.status.parse(
    days.map((row) => {
      const crawled = hasListing(row);
      const final = row.status === "final";
      const closedEarly = final && !crawled;
      const digested = ["digested", "final"].includes(row.status);
      const behind = skipped.has(row.day);
      return {
        ...(row.day === target ? { target: true } : {}),
        ...(closedEarly
          ? { suggestion: `litscout day reopen ${row.day}` }
          : {}),
        ...(behind
          ? {
              behind: true,
              // Summaries done: only the digest is missing.
              suggestion:
                row.status === "summarised"
                  ? `litscout digest run --day ${row.day}`
                  : `litscout summaries run --day ${row.day}`,
            }
          : {}),
        day: row.day,
        status: closedEarly ? "closed-early" : row.status,
        crawled,
        summarised: ["summarised", "digested", "final"].includes(row.status),
        digested,
        final,
      };
    }),
  );
}
export type CrawlResult = {
  diagnostics?: {
    source: string;
    name: string;
    message: string;
    stack: string;
  }[];
  invalid?: import("./records").InvalidRecord[];
  days: Record<string, PaperInput[]>;
  gaps: string[];
  cursor: string | null;
  pending?: boolean;
  noAnnouncement?: string[];
  deferred?: number;
  signals?: Record<string, number>;
  warnings?: string[];
  complete?: () => Promise<void>;
  listing?: ListingCursor;
  message?: string;
};
export type Crawl = (
  day: string,
  existingDays: string[],
  cursor: string | null,
  history: HistoryDay[],
  lastListing?: ListingCursor | null,
  pendingDays?: string[],
) => Promise<CrawlResult>;
async function history(
  api: FeedApi,
  day: string,
  days: z.infer<typeof daysSchema>,
) {
  return days.length ? loadHistory(api, shiftDay(day, -60), day) : [];
}
export type HistoryItem = FeedItem | HistoryPaper;
export type HistoryDay = { day: string; items: HistoryItem[] };
type History = HistoryDay[];
export function hasPaperAbstract(p: HistoryItem) {
  return typeof p.hasAbstract === "boolean"
    ? p.hasAbstract
    : Boolean("abstract" in p && p.abstract);
}
function preparePapers(
  papers: PaperInput[],
  prior: History,
  topics: readonly Topic[],
) {
  const existing = prior.flatMap((d) => d.items),
    lacking = existing
      .filter((p) => p.compact !== true && !hasPaperAbstract(p))
      .map(externalId);
  const tagged = papers.map((p) => {
    const names = topicsFor(
      { title: p.title, summary: p.abstract ?? "" },
      topics,
    );
    return { ...p, topics: names, shortlisted: Boolean(names.length) };
  });
  const records = tagged.map((p) => ({
    record: {
      id: p.key,
      title: p.title,
      authors: p.authors,
      doi: p.identifiers.find((i) => i.scheme === "doi")?.value,
      key: p.key,
    },
    abstract: p.abstract ?? "",
  }));
  const sorted = dedupe(existing.map(legacyRecord), records, lacking);
  const allFresh = sorted.fresh.map((p) => {
    const original = tagged.find((t) => t.key === p.record.key)!;
    return { ...original, abstract: p.abstract || null };
  });
  const venues = allFresh.filter((p) => p.source !== "arxiv"),
    selected = new Set(venues.slice(0, 150).map((p) => p.key));
  const fresh = allFresh.filter(
    (p) => p.source === "arxiv" || selected.has(p.key),
  );
  return {
    fresh,
    gained: sorted.gained,
    deferred: Math.max(0, venues.length - 150),
  };
}
type ChunkReport = {
  day: string;
  kind: string;
  accepted: number;
  skipped: number;
  invalid: InvalidRecord[];
};
export class DailyPaperRejectionLimit extends Error {}

async function uploadRecords(
  api: FeedApi,
  day: string,
  papers: PaperInput[],
  onChunk?: (report: ChunkReport) => void,
) {
  const reports: ChunkReport[] = [];
  for (const slice of chunks(papers)) {
    const value = await api.write(
      "/ingest/papers",
      { day, papers: slice },
      200 * slice.length,
    );
    const stats = batchResponse(value, slice.length);
    const report = {
      day,
      kind: "papers",
      ...stats,
      invalid: stats.invalid.map((row) => ({ ...row, day: row.day ?? day })),
    };
    onChunk?.(report);
    reports.push(report);
  }
  return reports;
}
async function uploadGained(
  api: FeedApi,
  prior: History,
  gained: Record<string, string>,
) {
  const reports: ChunkReport[] = [];
  for (const [id, abstract] of Object.entries(gained)) {
    const owner = prior.find((d) => d.items.some((p) => externalId(p) === id))!,
      paper = owner.items.find((p) => externalId(p) === id)!;
    reports.push(
      ...(await uploadRecords(api, owner.day, [
        { ...fromFeedItem(paper), abstract },
      ])),
    );
  }
  return reports;
}
async function uploadDay(
  api: FeedApi,
  day: string,
  papers: PaperInput[],
  prior: History,
  topics: readonly Topic[],
) {
  const chosen = preparePapers(papers, prior, topics);
  // Count matching papers already stored for this day when resuming an upload.
  const stored = new Set(
    prior.find((d) => d.day === day)?.items.map(externalId),
  );
  let total = chosen.fresh.length;
  for (const paper of papers) if (stored.delete(paper.key)) total++;
  const limit = Math.max(20, total * 0.1);
  let rejected = 0;
  const checkRejections = ({ invalid }: ChunkReport) => {
    if (!invalid.length) return;
    rejected += invalid.length;
    if (rejected === total || rejected > limit)
      throw new DailyPaperRejectionLimit(
        `${day} upload blocked. ${rejected} of ${total} papers rejected (${invalid[0]!.reason}).`,
      );
  };
  const gains = await uploadGained(api, prior, chosen.gained);
  const arxiv = await uploadRecords(
    api,
    day,
    chosen.fresh.filter((p) => p.source === "arxiv"),
    checkRejections,
  );
  const venues = await uploadRecords(
    api,
    day,
    chosen.fresh.filter((p) => p.source !== "arxiv"),
    checkRejections,
  );
  const reports = [...gains, ...arxiv, ...venues];
  const arxivAdded = arxiv.reduce((n, r) => n + r.accepted, 0);
  const venuesAdded = venues.reduce((n, r) => n + r.accepted, 0);
  return {
    added: arxivAdded + venuesAdded,
    arxivAdded,
    venuesAdded,
    gained: gains.reduce((n, r) => n + r.accepted, 0),
    deferred: chosen.deferred,
    skipped: reports.reduce((n, r) => n + r.skipped, 0),
    invalid: reports.flatMap((r) => r.invalid),
    chunks: reports,
  };
}
function signalUpdates(entry: HistoryDay, signals: Record<string, number>) {
  return entry.items
    .filter(
      (p) =>
        p.compact !== true &&
        signals[externalId(p)] !== undefined &&
        signals[externalId(p)] !== p.hfUpvotes,
    )
    .map((p) => ({ ...fromFeedItem(p), hfUpvotes: signals[externalId(p)]! }));
}
async function refreshSignals(
  api: FeedApi,
  prior: History,
  signals: Record<string, number> = {},
) {
  const reports: ChunkReport[] = [];
  for (const entry of prior) {
    const updates = signalUpdates(entry, signals);
    reports.push(...(await uploadRecords(api, entry.day, updates)));
  }
  return reports;
}
async function finishDays(
  day: string,
  result: CrawlResult,
  api: FeedApi,
  existing: Set<string>,
) {
  const venueOnlyDays: string[] = [];
  for (const date of Object.keys(result.days).sort()) {
    const feed = await loadDayInfo(api, date),
      counts = feed.counts;
    const requested =
      (result.pending && date === day) || (feed.total > 0 && !counts.arxiv)
        ? "pending"
        : feed.total
          ? "crawled"
          : "empty";
    const status = nextStatus(feed.status, requested);
    if (feed.total && !counts.arxiv) venueOnlyDays.push(date);
    if (existing.has(date) && feed.status === status) continue;
    await api.write("/ingest/feed-day", { day: date, status, counts }, 10);
  }
  return venueOnlyDays;
}
function crawlRows(
  day: string,
  result: CrawlResult,
  api: FeedApi,
  prior: History,
  topics: readonly Topic[],
  existing: DayRow[],
  cursor: string | undefined,
) {
  const plan = (path: string, body: unknown) =>
    // What the crawl will most likely write, not the per-request estimate.
    api.planRows?.(path, body, "crawl") ??
    plannedWriteRows(path, body, undefined, "crawl");
  let paperRows = 0,
    headroom = 0,
    feedDays = 0;
  const addPapers = (date: string, papers: PaperInput[]) => {
    for (const slice of chunks(papers)) {
      paperRows += plan("/ingest/papers", { day: date, papers: slice });
      for (const paper of slice)
        headroom = Math.max(headroom, paperReservation(paper) + writeOverhead);
    }
  };
  for (const [date, papers] of Object.entries(result.days)) {
    const { fresh, gained } = preparePapers(papers, prior, topics);
    addPapers(
      date,
      fresh.filter((p) => p.source === "arxiv"),
    );
    addPapers(
      date,
      fresh.filter((p) => p.source !== "arxiv"),
    );
    for (const entry of prior) {
      for (const item of entry.items) {
        const abstract = gained[externalId(item)];
        if (abstract)
          addPapers(entry.day, [{ ...fromFeedItem(item), abstract }]);
      }
    }
    const stored = existing.find((row) => row.day === date);
    if (
      !stored ||
      fresh.length ||
      (stored.status === "pending" && !(result.pending && date === day))
    )
      feedDays++;
  }
  if (result.signals)
    for (const entry of prior)
      addPapers(entry.day, signalUpdates(entry, result.signals));
  const cursors =
    Number(Boolean(result.listing)) +
    Number(Boolean(result.cursor && result.cursor !== cursor));
  if (!paperRows && !feedDays && !cursors) return 0;
  const metadataRows = (feedDays + cursors + 1) * (10 + writeOverhead);
  return paperRows + metadataRows + headroom;
}

async function budgetShort(
  day: string,
  result: CrawlResult,
  api: FeedApi,
  prior: History,
  topics: readonly Topic[],
  existing: DayRow[],
  cursor: string | undefined,
) {
  if (!api.readBudget) return;
  const requiredRows = crawlRows(
    day,
    result,
    api,
    prior,
    topics,
    existing,
    cursor,
  );
  if (!requiredRows) return;
  const budget = await api.readBudget();
  const availableRows = Math.max(
    0,
    budget.limit - budget.used - budget.reserved,
  );
  if (requiredRows <= availableRows) return;
  const shortfall = requiredRows - availableRows;
  return {
    status: "budget-short" as const,
    day,
    added: 0,
    gaps: result.gaps,
    requiredRows,
    availableRows,
    shortfall,
    resumeAt: budget.resetAt,
    message: `Crawl needs an estimated ${requiredRows} rows; ${availableRows} available (${shortfall} short)`,
  };
}
export async function dailyFetch(
  day: string,
  api: FeedApi,
  crawl: Crawl,
  topics: readonly Topic[],
) {
  z.iso.date().parse(day);
  const days = await readDays(api);
  if (days.some((d) => d.day === day && d.status === "final"))
    return { status: "exists" as const, day, added: 0, gaps: [] };
  const prior = await history(api, day, days);
  const cursor = z
    .object({ value: z.string() })
    .nullable()
    .parse(await api.get("/sync/cursors?name=venue-feed"));
  const storedListing = z
    .object({ value: z.string() })
    .nullable()
    .parse(await api.get("/sync/cursors?name=arxiv-listing"));
  const lastListing = storedListing
    ? listingCursorSchema.parse(JSON.parse(storedListing.value))
    : null;
  const result = await crawl(
    day,
    days.filter((d) => d.status !== "pending").map((d) => d.day),
    cursor?.value ?? null,
    prior,
    lastListing,
    days.filter((d) => d.status === "pending").map((d) => d.day),
  );
  const short = await budgetShort(
    day,
    result,
    api,
    prior,
    topics,
    days,
    cursor?.value,
  );
  if (short) return short;
  const uploaded = await uploadDays(result, api, prior, topics);
  const { deferred } = uploaded;
  const signals = await refreshSignals(api, prior, result.signals);
  if (result.cursor && !deferred && result.cursor !== cursor?.value)
    await api.write(
      "/ingest/legacy",
      { cursors: [{ name: "venue-feed", value: result.cursor }] },
      5,
    );
  const venueOnlyDays = await finishDays(
    day,
    result,
    api,
    new Set(days.map((d) => d.day)),
  );
  await storeListing(api, result.listing);
  if (!deferred) await result.complete?.();
  return fetchReport(day, days, result, {
    ...uploaded,
    signalsUpdated: signals.reduce((n, report) => n + report.accepted, 0),
    skipped:
      uploaded.skipped + signals.reduce((n, report) => n + report.skipped, 0),
    invalid: [
      ...uploaded.invalid,
      ...signals.flatMap((report) => report.invalid),
    ],
    venueOnlyDays,
  });
}

async function uploadDays(
  result: CrawlResult,
  api: FeedApi,
  prior: History,
  topics: readonly Topic[],
) {
  let added = 0,
    arxivAdded = 0,
    venuesAdded = 0,
    gained = 0,
    deferred = result.deferred ?? 0,
    staged = prior;
  const invalid: InvalidRecord[] = [],
    reports: ChunkReport[] = [];
  let skipped = 0;
  for (const [date, papers] of Object.entries(result.days).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const stats = await uploadDay(api, date, papers, staged, topics);
    added += stats.added;
    arxivAdded += stats.arxivAdded;
    venuesAdded += stats.venuesAdded;
    gained += stats.gained;
    deferred += stats.deferred;
    skipped += stats.skipped;
    invalid.push(...stats.invalid);
    reports.push(...stats.chunks);
    const updated = await loadHistory(api, date, date);
    staged = [...staged.filter((d) => d.day !== date), ...updated];
  }
  return {
    added,
    arxivAdded,
    venuesAdded,
    gained,
    deferred,
    skipped,
    invalid,
    chunks: reports,
  };
}

function fetchReport(
  day: string,
  days: z.infer<typeof daysSchema>,
  result: CrawlResult,
  stats: Awaited<ReturnType<typeof uploadDays>> & {
    signalsUpdated: number;
    venueOnlyDays: string[];
  },
) {
  const { added, gained, deferred, signalsUpdated } = stats;
  const existed = days.some(
    (d) => d.day === day && !["pending", "empty"].includes(d.status),
  );
  const status: "pending" | "exists" | "crawled" =
    result.pending || stats.venueOnlyDays.includes(day)
      ? "pending"
      : existed &&
          !added &&
          !gained &&
          !signalsUpdated &&
          !deferred &&
          !stats.invalid.length &&
          !result.invalid?.length
        ? "exists"
        : "crawled";
  return {
    status,
    day,
    added,
    arxivAdded: stats.arxivAdded,
    venuesAdded: stats.venuesAdded,
    venueOnlyDays: stats.venueOnlyDays,
    gaps: result.gaps,
    noAnnouncement: result.noAnnouncement ?? [],
    deferred,
    deferredExplanation:
      "New, deduplicated non-arXiv venue papers deferred by the 150-paper limit per feed day. arXiv papers, duplicates and invalid records are excluded. Venue progress is retained so the next fetch can retry these papers.",
    gained,
    signalsUpdated,
    warnings: result.warnings ?? [],
    diagnostics: result.diagnostics ?? [],
    invalid: [...(result.invalid ?? []), ...stats.invalid],
    skipped: (result.invalid?.length ?? 0) + stats.skipped,
    chunks: stats.chunks,
    ...(result.message ? { message: result.message } : {}),
  };
}

async function storeListing(api: FeedApi, listing: ListingCursor | undefined) {
  if (listing)
    await api.write(
      "/ingest/legacy",
      {
        cursors: [{ name: "arxiv-listing", value: JSON.stringify(listing) }],
      },
      5,
    );
}
