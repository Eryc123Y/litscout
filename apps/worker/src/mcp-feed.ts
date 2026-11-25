import { readTriageQueue } from "@litscout/db/triage-read";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import { behindDays } from "@litscout/pipeline/day-gaps";
import { daySchema } from "@litscout/pipeline/contracts/index";
import { readWebDigest } from "@litscout/db/web-digest";
import { getVaultStatus } from "@litscout/db/vault-requests";
import { nextReset, writeBudgetUsage } from "@litscout/db/write-budget";
import type { buildServer } from "@litscout/mcp/server";
import type { AppEnv } from "./env";
import { viewFeedDay, viewFeedDays, viewFeedDaysPage } from "./feed-view";
import { instanceInfo } from "./public-feed";
import { userDay } from "./instance-day";

type Server = ReturnType<typeof buildServer>;
const readAnnotations = { readOnlyHint: true, openWorldHint: false };

const listDaysInput = z.object({
  before: daySchema.optional(),
  limit: z.number().int().min(1).max(60).default(14),
});
const getDayInput = z.object({
  day: daySchema.optional(),
  topic: z.string().min(1).max(200).optional(),
  shortlisted: z.boolean().optional(),
  q: z.string().trim().min(3).max(1000).optional(),
  language: z.enum(["en", "zh"]).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(64000).optional(),
  /** Only papers that link public code. */
  code: z.boolean().optional(),
  /** The reader's decision; "open" leaves out skipped papers. */
  decision: z.enum(["open", "to_read", "saved", "skipped"]).optional(),
  /** The day's triage queue in place of the page of papers. */
  queue: z.boolean().optional(),
});
const statusInput = z.object({
  days: z.number().int().min(1).max(14).default(3),
});

function reply(data: unknown, error?: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(error ? { error } : { result: data }),
      },
    ],
    ...(error ? { isError: true } : {}),
  };
}

const shiftDay = (day: string, offset: number) =>
  new Date(Date.parse(day) + offset * 86_400_000).toISOString().slice(0, 10);
/** Radar entries shown per call; the stored digest may hold thousands. */
const radarShown = 50;
/** Days read for behind marks: the CLI's two-week window and some margin. */
const recentDays = 30;
/** Windows of up to 100 feed rows one get_day call may scan. */
const maxScans = 5;

/** The newest day with a digest, else the newest crawled day, else today. */
async function latestDay(db: D1Database, today: string) {
  const newest = (statuses: string) =>
    db
      .prepare(
        `SELECT day FROM feed_days WHERE status IN (${statuses}) ORDER BY day DESC LIMIT 1`,
      )
      .first<string>("day");
  return (
    (await newest("'digested','final'")) ??
    (await newest("'crawled','summarised'")) ??
    today
  );
}

/** The morning brief as an agent should see it: research suggestions only
 * with research tools on, and a bounded radar. A brief that cannot be read
 * leaves the papers readable. */
async function readBrief(
  db: D1Database,
  day: string,
  lang: string,
  research: boolean,
) {
  const brief = (await readWebDigest(db, day, lang, "daily").catch(
    () => null,
  )) as ({ radar?: unknown[]; suggestions?: unknown } & object) | null;
  if (!brief) return null;
  const { suggestions, radar, ...rest } = brief;
  return {
    ...rest,
    ...(research && suggestions !== undefined ? { suggestions } : {}),
    ...(radar
      ? {
          radar: radar.slice(0, radarShown),
          ...(radar.length > radarShown ? { radarTotal: radar.length } : {}),
        }
      : {}),
  };
}

type RunRow = {
  id: string;
  kind: string;
  day: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};
function recentRuns(db: D1Database, from: string, to: string) {
  return db
    .prepare(
      `SELECT id,kind,day,status,started_at AS startedAt,finished_at AS finishedAt,
        substr(error,1,200) AS error
      FROM runs WHERE day>=? AND day<=? ORDER BY started_at DESC LIMIT 20`,
    )
    .bind(from, to)
    .all<RunRow>()
    .then((r) => r.results);
}

/** Daily reading over MCP: the same reads as the Today, Days and Health
 * pages, with read scope. Nothing here writes. */
export function registerFeedTools(
  server: Server,
  env: AppEnv,
  { read, write }: { read: boolean; write: boolean },
) {
  if (!read) return;
  const research = env.MCP_RESEARCH_TOOLS === "true";
  const run = async (body: (db: D1Database) => Promise<unknown>) => {
    if (!env.DB) return reply(null, "Feed unavailable");
    try {
      const result = await body(env.DB);
      return result == null ? reply(null, "Day not found") : reply(result);
    } catch {
      return reply(null, "The feed could not be read");
    }
  };

  server.registerTool(
    "list_days",
    {
      description:
        "List reading days, newest first: status (pending, crawled, summarised, digested, final, empty) and paper counts. On the first page, behind: true marks a crawled day that was skipped. Page with nextBefore.",
      inputSchema: listDaysInput,
      annotations: readAnnotations,
    },
    async ({ before, limit }) =>
      run(async (db) => {
        if (before) return viewFeedDaysPage(db, limit, before);
        // One read serves the page and the behind marks.
        const rows = await viewFeedDays(db, Math.max(limit + 1, recentDays));
        const behind = behindDays(rows);
        const items = rows.slice(0, limit);
        return {
          items: items.map((d) =>
            behind.has(d.day) ? { ...d, behind: true } : d,
          ),
          nextBefore: rows.length > limit ? items.at(-1)!.day : null,
        };
      }),
  );

  server.registerTool(
    "get_day",
    {
      description:
        "Read one reading day: the morning brief (radar, picks per topic, idea suggestions), counts by topic and source, and a page of papers on the reader's topics. Defaults to the newest day with a digest. A search over the whole day (q, 3+ characters) or shortlisted: false includes papers outside the topics. Filter by topic; page with cursor. code: true keeps papers with public code; decision filters by the reader's own decision (open leaves out skipped papers; to_read, saved, skipped). Each paper's readingState says whether it was read or skipped and its library status. queue: true returns the day's triage queue instead of a page: the brief's radar items and picks, then papers on the topics with public code, each with its reason, and toRead, the number of papers waiting in the Library's To read.",
      inputSchema: getDayInput,
      annotations: readAnnotations,
    },
    async ({ day, language, limit, cursor, shortlisted, queue, ...filters }) =>
      run(async (db) => {
        // Like the reader: papers outside the reader's topics only for a
        // search or when asked for.
        const onTopics = shortlisted ?? (filters.q ? undefined : true);
        const instance = instanceInfo(env);
        const target = day ?? (await latestDay(db, userDay(env, new Date())));
        const lang = language ?? instance.language;
        const read = (size: number, from?: string) =>
          viewFeedDay(
            db,
            target,
            { ...filters, shortlisted: onTopics, limit: size, cursor: from },
            false,
            instance.keywordOnly,
            instance.topVenues,
          );
        const [first, brief, triage] = await Promise.all([
          // The queue comes whole; the page read then only gives the counts.
          read(queue ? 1 : limit, queue ? undefined : cursor),
          readBrief(db, target, lang, research),
          queue ? readTriageQueue(db, target, lang) : undefined,
        ]);
        if (triage)
          return {
            day: first.day,
            status: first.status,
            language: lang,
            counts: first.counts,
            brief,
            papers: {
              items: triage.items,
              nextCursor: null,
              toRead: triage.toRead,
            },
          };
        // A filtered page scans a bounded window and can come back short
        // with a continuation; keep reading a few windows to fill it.
        let feed = first;
        let items = first.items;
        for (
          let scans = 1;
          items.length < limit && feed.nextCursor && scans < maxScans;
          scans++
        ) {
          feed = await read(limit - items.length, feed.nextCursor);
          items = [...items, ...feed.items];
        }
        return {
          day: first.day,
          status: first.status,
          language: lang,
          counts: first.counts,
          brief,
          papers: { items, nextCursor: feed.nextCursor },
        };
      }),
  );

  server.registerTool(
    "get_status",
    {
      description:
        "Check that LitScout is healthy: today's write budget (UTC day), the daily runs of the last few days (up to 20), and behind days. With research tools on and write access it adds the vault sync state (last sync, queued and rejected requests).",
      inputSchema: statusInput,
      annotations: readAnnotations,
    },
    async ({ days }) =>
      run(async (db) => {
        const now = new Date();
        const today = userDay(env, now);
        const utcDay = now.toISOString().slice(0, 10);
        const [usage, runs, recent, vault] = await Promise.all([
          writeBudgetUsage(db, utcDay),
          recentRuns(db, shiftDay(today, 1 - days), today),
          viewFeedDays(db, recentDays),
          research && write
            ? getVaultStatus(drizzle(db), now.toISOString())
            : null,
        ]);
        return {
          today,
          budget: {
            day: utcDay,
            ...usage,
            remaining: Math.max(0, usage.limit - usage.used - usage.reserved),
            resetAt: nextReset(utcDay),
          },
          runs,
          behind: [...behindDays(recent)].sort(),
          ...(vault ? { vault } : {}),
        };
      }),
  );
}
