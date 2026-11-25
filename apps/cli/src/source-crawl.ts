import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { readHuggingFace, hfUpvotes } from "@litscout/sources/huggingface";
import {
  shiftDay,
  fromFeedItem,
  hasPaperAbstract,
  type HistoryDay,
  type Crawl,
} from "@litscout/pipeline/daily";
import type { PaperInput } from "@litscout/pipeline/contracts/index";
import { runAbstracts } from "./abstracts/run";
import {
  ATTEMPTS_FILE,
  isDue,
  nextAttempts,
  readAttempts,
  type Outcome,
} from "./abstract-attempts";
import { arxivDays } from "./arxiv-crawl";
import { venuePapers, commitState } from "./venue-crawl";
import { crawlLog } from "./crawl-log";
import { withCrawlDeadline } from "./crawl-deadline";
import type { InvalidRecord } from "@litscout/pipeline/records";
export type CrawlDeps = {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  cwd: string;
  dir: string;
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  warn: (text: string) => void;
  report?: (source: string, error: unknown, context?: string) => void;
  onInvalid?: (issue: InvalidRecord) => void;
};
type Missing = { day: string; paper: PaperInput };
function abstractRequest(p: PaperInput) {
  return JSON.stringify({
    id: p.key,
    title: p.title,
    doi: p.identifiers.find((i) => i.scheme === "doi")?.value,
    arxiv: p.identifiers.find((i) => i.scheme === "arxiv")?.value,
  });
}
async function requestMissing(missing: Missing[], deps: CrawlDeps) {
  const lines: string[] = [];
  let unchecked: ReadonlySet<string> = new Set();
  const code = await runAbstracts([], {
    onUnchecked: (items) => {
      unchecked = new Set(items.keys());
    },
    fetch: deps.fetch,
    env: deps.env,
    readStdin: async () =>
      missing.map((m) => abstractRequest(m.paper)).join("\n"),
    stdout: (s) => lines.push(s),
    stderr: deps.warn,
    sleep: deps.sleep,
  });
  const schema = z.object({
    id: z.string(),
    abstract: z.string().nullable(),
    source: z.string().nullable(),
  });
  const replies = lines
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((s) => schema.parse(JSON.parse(s)));
  if (
    code ||
    replies.length !== missing.length ||
    replies.some((r, i) => r.id !== missing[i]!.paper.key)
  )
    throw new Error("Malformed abstract reply; no abstracts saved");
  return replies.map((reply) => ({
    ...reply,
    outcome: (reply.abstract
      ? "found"
      : unchecked.has(reply.id)
        ? "unchecked"
        : "missed") as Outcome,
  }));
}
/**
 * Venue papers in the history still without an abstract, newest first, that are
 * due for another lookup. The ledger of misses goes into `ledgerState`,
 * written once the run's uploads are done (`settled`), even while venue papers
 * are deferred and the venue progress waits.
 */
async function missingAbstracts(
  history: HistoryDay[],
  deps: CrawlDeps,
  ledgerState: Map<string, string>,
) {
  const lacking = [...history]
    .sort((a, b) => b.day.localeCompare(a.day))
    .flatMap((d) =>
      d.items
        .filter(
          (p) =>
            p.compact !== true && p.source !== "arxiv" && !hasPaperAbstract(p),
        )
        .map((p) => ({ day: d.day, paper: fromFeedItem(p) })),
    );
  const attempts = await readAttempts(deps.dir);
  const now = deps.now();
  // A paper listed on several days is looked up once, under its newest day.
  const newest = new Map(
    lacking.map((m) => [m.paper.key, m] as const).reverse(),
  );
  const missing = [...new Set(lacking.map((m) => m.paper.key))]
    .map((key) => newest.get(key)!)
    .filter((m) => isDue(attempts, m.paper.key, now))
    .slice(0, 200);
  const replies = missing.length ? await requestMissing(missing, deps) : [];
  const ledger = nextAttempts(
    attempts,
    new Set(lacking.map((m) => m.paper.key)),
    missing.map((m, i) => ({ key: m.paper.key, outcome: replies[i]!.outcome })),
    now,
  );
  if (JSON.stringify(ledger) !== JSON.stringify(attempts))
    ledgerState.set(ATTEMPTS_FILE, JSON.stringify(ledger));
  return missing.flatMap((m, i) =>
    replies[i]!.abstract
      ? [{ day: m.day, paper: { ...m.paper, abstract: replies[i]!.abstract! } }]
      : [],
  );
}
async function signals(config: LitScoutConfig, deps: CrawlDeps) {
  const lists = [],
    warnings: string[] = [];
  if (config.sources.huggingface.dailyPapers)
    for (
      let offset = 0;
      offset < config.sources.huggingface.upvotesDays && !deps.signal?.aborted;
      offset++
    ) {
      try {
        lists.push(
          await readHuggingFace(
            shiftDay(deps.now().toISOString().slice(0, 10), -offset),
            deps.fetch,
            deps.now,
          ),
        );
      } catch (error) {
        deps.report?.("huggingface", error, "Keeping previous signals");
      }
    }
  return { votes: hfUpvotes(lists), warnings };
}
/**
 * The day whose arXiv listing will carry venue papers found without one.
 * arXiv lists nothing on Saturday or Sunday, so papers found then go to the
 * next Monday: left on the weekend day they would never get summaries or a
 * digest, which both need a listing.
 */
export function nextListingDay(day: string) {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday === 6
    ? shiftDay(day, 2)
    : weekday === 0
      ? shiftDay(day, 1)
      : day;
}
async function enrich(
  day: string,
  config: LitScoutConfig,
  deps: CrawlDeps,
  cursor: string | null,
  history: HistoryDay[],
  days: Record<string, PaperInput[]>,
  state: Map<string, string>,
  ledgerState: Map<string, string>,
) {
  if (deps.signal?.aborted) {
    days[day] ??= [];
    return null;
  }
  const venues =
    day === deps.now().toISOString().slice(0, 10)
      ? await venuePapers(config, deps, day, cursor, state).catch((error) => {
          deps.report?.(
            "venues",
            error,
            "Venue watch failed; cursor unchanged",
          );
          return null;
        })
      : [];
  const venueDay =
    Object.keys(days)
      .filter((date) => days[date]!.some((paper) => paper.source === "arxiv"))
      .sort()
      .at(-1) ?? nextListingDay(day);
  days[day] ??= [];
  days[venueDay] = [...(days[venueDay] ?? []), ...(venues ?? [])];
  try {
    for (const filled of deps.signal?.aborted
      ? []
      : await missingAbstracts(history, deps, ledgerState))
      (days[filled.day] ??= []).push(filled.paper);
  } catch (error) {
    deps.report?.(
      "abstracts",
      error,
      "Abstract retry failed; existing records unchanged",
    );
  }
  return venues;
}
/** The sources' environment: the config's contact address unless the environment sets one. */
function crawlEnv(config: LitScoutConfig, env: CrawlDeps["env"]) {
  const email = config.library.unpaywallEmail;
  return email && !env.UNPAYWALL_EMAIL?.trim()
    ? { ...env, UNPAYWALL_EMAIL: email }
    : env;
}
export function sourceCrawl(config: LitScoutConfig, given: CrawlDeps) {
  const deps = { ...given, env: crawlEnv(config, given.env) };
  return (
    ...[
      day,
      _existing,
      cursor,
      history,
      lastListing = null,
      pendingDays = [],
    ]: Parameters<Crawl>
  ) =>
    withCrawlDeadline(
      deps,
      config.sources.crawlTimeoutSeconds,
      async (timed) => {
        const log = crawlLog(deps.env, deps.warn),
          invalid: InvalidRecord[] = [];
        const active = loggedDeps(timed, log.report, invalid);
        const state = new Map<string, string>();
        const ledgerState = new Map<string, string>();
        const arxivHistory = history
          .filter((d) => d.items.some((p) => p.source === "arxiv"))
          .map((d) => d.day);
        const found = await arxivDays(
          config,
          active,
          day,
          arxivHistory,
          lastListing,
          pendingDays,
        );
        const { votes } = await signals(config, active);
        const venues = await enrich(
          day,
          config,
          active,
          cursor,
          history,
          found.days,
          state,
          ledgerState,
        );
        if (timed.signal?.aborted)
          log.report(
            "crawl",
            timed.signal.reason,
            found.pending || found.listing?.pendingDays?.length
              ? `Deferred arXiv dates: ${[...new Set([...(found.pending ? [day] : []), ...(found.listing?.pendingDays ?? [])])].join(", ")}`
              : "Keeping completed input and skipping remaining source requests",
          );
        const days = Object.fromEntries(
          Object.entries(found.days).map(([date, papers]) => [
            date,
            papers.map((p, rankInSource) => ({
              ...p,
              rankInSource,
              hfUpvotes: votes[p.key] ?? null,
            })),
          ]),
        );
        return {
          ...found,
          days,
          cursor:
            venues && !timed.signal?.aborted
              ? JSON.stringify({ since: day })
              : null,
          signals: votes,
          warnings: log.warnings,
          diagnostics: log.diagnostics,
          invalid,
          venueState: Object.fromEntries([...state, ...ledgerState]),
          complete: () => commitState(deps.dir, state),
          settled: () => commitState(deps.dir, ledgerState),
        };
      },
    );
}

function loggedDeps(
  deps: CrawlDeps,
  report: CrawlDeps["report"],
  invalid: InvalidRecord[],
) {
  return {
    ...deps,
    report,
    onInvalid: (issue: InvalidRecord) => {
      invalid.push(issue);
      deps.onInvalid?.(issue);
    },
  };
}
