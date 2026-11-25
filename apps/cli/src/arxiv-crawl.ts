import type { LitScoutConfig } from "@litscout/core";
import {
  arxivClient,
  parseListing,
  mergeNewListings,
  fetchAbstracts,
  backfill,
  type ListingPaper,
} from "@litscout/sources/listings";
import { type PaperInput } from "@litscout/pipeline/contracts/index";
import { shiftDay, type ListingCursor } from "@litscout/pipeline/daily";
import { listingInput } from "@litscout/pipeline/arxiv-listing-input";
import { fetchWithRetry } from "@litscout/sources/http/fetch-retry";
import { validateRecords } from "@litscout/pipeline/records";
import type { CrawlDeps } from "./source-crawl";
const pageSize = 2000;
const maxNewPages = 5;
export { listingInput };

async function recent(
  request: ListingRequest,
  categories: string[],
  day: string,
) {
  const papers: ListingPaper[] = [];
  for (const category of categories) {
    for (let skip = 0; ; skip += pageSize) {
      const page = await request(
        `https://arxiv.org/list/${category}/recent?skip=${skip}&show=${pageSize}`,
        category,
        "recent",
        day,
      );
      if (!page.complete) throw new Error("arXiv recent listing is incomplete");
      papers.push(...page.papers);
      if (skip + pageSize >= page.total) break;
    }
  }
  return papers;
}

function listingRequest(fetch: typeof globalThis.fetch, deps: CrawlDeps) {
  return async (
    url: string,
    category: string,
    kind: "new" | "recent",
    day: string,
  ) => {
    const response = await fetchWithRetry(
      url,
      {},
      {
        retries: 2,
        baseDelayMs: 3000,
        maxDelayMs: 60_000,
        timeoutMs: 60_000,
        fetchImpl: fetch,
        sleep: deps.sleep,
        now: () => deps.now().getTime(),
      },
    );
    if (!response.ok) throw new Error(`arXiv ${kind} HTTP ${response.status}`);
    return parseListing(await response.text(), category, kind, day);
  };
}
type ListingRequest = ReturnType<typeof listingRequest>;

function listingInputs(papers: ListingPaper[], day: string, deps: CrawlDeps) {
  const seen = new Set<string>();
  const unique = papers.filter((paper) => {
    if (seen.has(paper.id)) return false;
    seen.add(paper.id);
    return true;
  });
  const batch = validateRecords(day, unique, (row) =>
    listingInput(row as ListingPaper),
  );
  for (const row of batch.invalid) deps.onInvalid?.(row);
  return batch.accepted;
}

const isWeekday = (day: string) => ![0, 6].includes(new Date(day).getUTCDay());

export async function arxivDays(
  config: LitScoutConfig,
  deps: CrawlDeps,
  day: string,
  existing: string[],
  lastListing: ListingCursor | null = null,
  pendingDays: string[] = [],
) {
  const request = arxivClient(deps.fetch, deps.sleep),
    today = deps.now().toISOString().slice(0, 10);
  const listingPage = listingRequest(request, deps);
  const current = await newestDay(
    listingPage,
    config,
    day,
    today,
    existing,
    lastListing,
    deps,
  ).catch((error: unknown): CurrentListing => {
    if (!deps.signal?.aborted)
      deps.report?.("arxiv", error, "Current listing pending");
    return {
      days: {},
      pending: true,
      message: `arXiv ${day} listing unavailable; retry later`,
    };
  });
  const missing = missingDays(
    day,
    today,
    existing,
    lastListing,
    pendingDays,
  ).filter((date) => !current.days[date]);
  const recovered = await recoverDays(
    listingPage,
    request,
    config,
    day,
    missing,
    deps,
  );
  const listing = updatedListing(
    current.listing,
    lastListing,
    recovered.noAnnouncement,
    recovered.pending,
    day,
  );
  return {
    ...current,
    ...(recovered.pending.includes(day) && !current.pending
      ? {
          pending: true,
          message: `arXiv ${day} is still missing from recent listings; retry later`,
        }
      : {}),
    days: { ...recovered.days, ...current.days },
    gaps: recovered.gaps,
    noAnnouncement: [
      ...new Set([
        ...recovered.noAnnouncement,
        ...(lastListing?.noAnnouncement?.filter((date) => date === day) ?? []),
      ]),
    ],
    ...(listing ? { listing } : {}),
  };
}

function missingDays(
  day: string,
  today: string,
  existing: string[],
  last: ListingCursor | null,
  pendingDays: string[],
) {
  const latest = [...existing, ...(last ? [last.listingDate] : [])]
    .filter((d) => d < day)
    .sort()
    .at(-1);
  const missing = new Set(
    (last?.pendingDays ?? []).filter(
      (date) => date <= day && !existing.includes(date),
    ),
  );
  for (const date of pendingDays)
    if (
      date < day &&
      isWeekday(date) &&
      !existing.includes(date) &&
      (!last || date > last.listingDate) &&
      !last?.noAnnouncement?.includes(date)
    )
      missing.add(date);
  if (latest)
    for (let date = shiftDay(latest, 1); date < day; date = shiftDay(date, 1))
      if (
        isWeekday(date) &&
        !existing.includes(date) &&
        !last?.noAnnouncement?.includes(date)
      )
        missing.add(date);
  if (
    day < today &&
    isWeekday(day) &&
    !existing.includes(day) &&
    !last?.noAnnouncement?.includes(day)
  )
    missing.add(day);
  return [...missing].sort();
}

function updatedListing(
  current: ListingCursor | undefined,
  last: ListingCursor | null,
  absent: string[],
  deferred: string[],
  day: string,
) {
  const base = current ?? last;
  if (!base) return undefined;
  const noAnnouncement = [
    ...new Set([...(last?.noAnnouncement ?? []), ...absent]),
  ]
    .filter((date) => date >= shiftDay(base.listingDate, -60))
    .sort()
    .slice(-60);
  const pendingDays = [
    ...new Set([
      ...(last?.pendingDays ?? []).filter((date) => date > day),
      ...deferred,
    ]),
  ]
    .sort()
    .slice(-60);
  const { listingDate, runDay } = base;
  const listing = {
    listingDate,
    runDay,
    ...(noAnnouncement.length ? { noAnnouncement } : {}),
    ...(pendingDays.length ? { pendingDays } : {}),
  };
  return JSON.stringify(listing) === JSON.stringify(last) ? undefined : listing;
}

async function recoverDays(
  listingPage: ListingRequest,
  request: typeof fetch,
  config: LitScoutConfig,
  day: string,
  missing: string[],
  deps: CrawlDeps,
) {
  if (!missing.length || !config.sources.arxiv.categories.length)
    return { days: {}, gaps: [], noAnnouncement: [], pending: [] };
  let rows: ListingPaper[];
  try {
    deps.signal?.throwIfAborted();
    rows = await recent(listingPage, config.sources.arxiv.categories, day);
  } catch (error) {
    if (!deps.signal?.aborted)
      deps.report?.("arxiv", error, "Recent listing recovery pending");
    return { days: {}, gaps: [], noAnnouncement: [], pending: missing };
  }
  const ids = [
    ...new Set(
      rows
        .filter((p) => p.announced && missing.includes(p.announced))
        .map((p) => p.id),
    ),
  ];
  const unavailable = new Set<string>();
  const abstracts = await fetchAbstracts(
    ids,
    {
      fetch: request,
      sleep: deps.sleep,
      signal: deps.signal,
      now: () => deps.now().getTime(),
      onUnavailable: (ids, error) => {
        for (const id of ids) unavailable.add(id);
        if (!deps.signal?.aborted)
          deps.report?.("arxiv", error, "Abstract recovery pending");
      },
    },
    true,
  );
  const deferred = new Set(
    rows.flatMap((row) =>
      row.announced && unavailable.has(row.id) ? [row.announced] : [],
    ),
  );
  const found = backfill(
    rows,
    missing.filter((date) => !deferred.has(date)),
    abstracts,
  );
  if (found.gaps.length) {
    const omitted = ids.filter(
      (id) => !Object.hasOwn(abstracts, id) && !unavailable.has(id),
    );
    deps.report?.(
      "arxiv",
      new Error(`Missing abstracts for ${omitted.length} papers`),
      `Affected dates: ${found.gaps.join(", ")}. Paper IDs: ${omitted.slice(0, 20).join(", ")}`,
    );
  }
  const days = Object.fromEntries(
    Object.entries(found.days).map(([date, papers]) => [
      date,
      listingInputs(papers, date, deps),
    ]),
  );
  const dates = missingAnnouncements(missing, found.covered, Object.keys(days));
  return {
    days,
    noAnnouncement: dates.noAnnouncement,
    gaps: [
      ...new Set([
        ...dates.gaps.filter((date) => !deferred.has(date)),
        ...found.gaps,
      ]),
    ].sort(),
    pending: [...new Set([...dates.pending, ...deferred])].sort(),
  };
}

function missingAnnouncements(
  missing: string[],
  covered: string[],
  recovered: string[],
) {
  const oldest = covered[0],
    newest = covered.at(-1);
  return {
    noAnnouncement: missing.filter(
      (date) =>
        oldest &&
        newest &&
        date >= oldest &&
        date < newest &&
        !covered.includes(date),
    ),
    gaps: missing.filter(
      (date) => !recovered.includes(date) && (!oldest || date < oldest),
    ),
    pending: missing.filter((date) => newest && date > newest),
  };
}

type CurrentListing = {
  days: Record<string, PaperInput[]>;
  pending: boolean;
  listing?: ListingCursor;
  message?: string;
};

async function newestDay(
  request: ListingRequest,
  config: LitScoutConfig,
  day: string,
  today: string,
  existing: string[],
  last: ListingCursor | null,
  deps: CrawlDeps,
): Promise<CurrentListing> {
  const days: Record<string, PaperInput[]> = {};
  if (
    day !== today ||
    !isWeekday(day) ||
    !config.sources.arxiv.categories.length
  )
    return { days, pending: false };
  const pages = await newPages(request, config, day);
  if (pages.some((page) => !page.complete))
    return {
      days,
      pending: true,
      message: "arXiv listing is incomplete; retry later",
    };
  const labels = [...new Set(pages.map((p) => Date.parse(p.day + " UTC")))];
  if (labels.length !== 1 || !Number.isFinite(labels[0]))
    return {
      days,
      pending: true,
      message:
        "arXiv listing dates are missing or differ between categories; retry later",
    };
  const listingDate = new Date(labels[0]!).toISOString().slice(0, 10);
  const state = listingState(listingDate, day, existing, last);
  if (!state.ingested && listingDate <= day)
    days[listingDate] = listingInputs(
      pages.flatMap((p) => p.papers),
      listingDate,
      deps,
    );
  return {
    days,
    pending: state.pending,
    message: state.message,
    ...(!state.ingested && listingDate <= day
      ? { listing: { listingDate, runDay: day } }
      : {}),
  };
}

async function newPages(
  request: ListingRequest,
  config: LitScoutConfig,
  day: string,
) {
  const pages = [];
  for (const category of config.sources.arxiv.categories) {
    const url = `https://arxiv.org/list/${category}/new?show=${pageSize}`;
    const categoryPages = [await request(url, category, "new", day)];
    let combined = categoryPages[0]!;
    for (
      let index = 1;
      combined.core && !combined.complete && index < maxNewPages;
      index++
    ) {
      categoryPages.push(
        await request(`${url}&skip=${index * pageSize}`, category, "new", day),
      );
      combined = mergeNewListings(categoryPages, day);
    }
    pages.push(combined);
    if (!combined.complete) break;
  }
  return pages;
}

function listingState(
  listingDate: string,
  day: string,
  existing: string[],
  last: ListingCursor | null,
) {
  const ingested =
    existing.includes(listingDate) ||
    Boolean(last && listingDate <= last.listingDate);
  const pending = listingDate !== day;
  const message = pending
    ? `arXiv ${day} pending; latest available listing is ${listingDate}${ingested ? " (already ingested)" : ""}; retry later`
    : ingested
      ? `arXiv listing ${listingDate} already ingested`
      : undefined;
  return { ingested, pending, message };
}
