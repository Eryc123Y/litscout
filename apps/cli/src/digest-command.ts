import { loadFullFeed } from "@litscout/pipeline/read-client";
import { writeDigest } from "./digest-writer";
import { hasReadingBatch, putDigest, summaryCompletion } from "./digest-put";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { schemas, missedSchema } from "@litscout/pipeline/contracts/index";
import { digestContext, noBatchNote } from "@litscout/pipeline/digest";
import {
  lastReportedListing,
  readDays,
  readingDay,
  shiftDay,
} from "@litscout/pipeline/daily";
import { BudgetStop, type FeedApi } from "@litscout/pipeline/api";
import { refresh as refreshTrends } from "./trends-command";
import { localDay, nowFor, type FlowDeps } from "./flow-runtime";
import { flowOptions } from "./flow-options";
import { recordStep } from "./summary-command";
import { fetchRadarText } from "./fulltext";
import {
  localDigestResearch,
  readDigestBriefs,
  remoteDigestResearch,
} from "./digest-research";
import { apiHost } from "./agent-api";
const operationsSchema = z.object({
  ratings: z.array(z.unknown()),
  radar: z.array(z.object({ paperId: z.string(), day: z.string() })),
  missed: z.array(missedSchema),
  runs: z.array(z.unknown()),
});
async function context(
  day: string,
  api: FeedApi,
  config: LitScoutConfig,
  deps: FlowDeps,
  feed?: Awaited<ReturnType<typeof loadFullFeed>>,
) {
  const briefs = readDigestBriefs(
    config.digest.briefFiles,
    deps.configDir ?? deps.cwd,
  );
  const [loaded, inputs, ops] = await Promise.all([
    feed ?? loadFullFeed(api, day),
    briefs,
    api
      .get(
        `/operations?from=${shiftDay(day, -config.digest.ratingsLookbackDays)}&to=${day}`,
      )
      .then((data) => operationsSchema.parse(data)),
  ]);
  const known = ops.radar.filter((r) => r.day !== day).map((r) => r.paperId);
  const local = config.digest.suggestionsPerDay
    ? await localDigestResearch(
        config.vault,
        deps.configDir ?? deps.cwd,
        config.research.contextBodies,
      )
    : undefined;
  // Without the vault on this machine, the instance's vault index if allowed.
  const research =
    local ??
    (config.digest.suggestionsPerDay && config.research.vaultIndex
      ? await remoteDigestResearch((path) => api.get(path))
      : undefined);
  const input = schemas.context.parse({
    ...digestContext(
      day,
      loaded.items,
      inputs,
      ops.ratings,
      config.instance.language,
      known,
      config.topics,
    ),
    ...research?.fields,
  });
  return { input, research };
}
async function run(
  command: "run" | "final",
  values: Record<string, string>,
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const startedAt = nowFor(deps);
  const today = localDay(deps, config, startedAt);
  const final = command === "final" || Boolean(values.final);
  const dryRun = values["dry-run"] === "true";
  const days = values.day ? [] : await readDays(api);
  const target = values.day
    ? z.iso.date().parse(values.day)
    : readingDay(days, today);
  const day = target ?? today;
  const lang = config.instance.language;
  const getDigest = (date: string) => api.get(`/digests/${date}?lang=${lang}`);
  // A dry run writes nothing, so it may check a day that has its digest.
  if (!dryRun && (await getDigest(day))) return { status: "exists", day };
  const previous = !target && lastReportedListing(days, today);
  if (previous && previous !== today) {
    const report = z
      .object({ createdAt: z.iso.datetime() })
      .safeParse(await getDigest(previous));
    if (
      report.success &&
      localDay(deps, config, new Date(report.data.createdAt)) === today
    )
      return { status: "exists", day: previous };
  }
  const feed = target ? await loadFullFeed(api, day) : undefined;
  if (!feed || !hasReadingBatch(feed, values.day !== undefined)) {
    if (final && new Date(day).getUTCDay() === 0)
      return { status: "sunday-stop", day };
    if (final && canCloseDay(day, today, startedAt, config))
      return dryRun
        ? {
            status: "dry-run",
            day,
            message: "A no-batch note needs no agent calls.",
          }
        : finalNote(day, api, deps, config);
    return { status: "no-new-batch", day };
  }
  const completion = summaryCompletion(feed.items, lang);
  if (!final && completion.done < 0.95 * completion.total)
    return { status: "summaries-pending", day, ...completion };
  const { input, research } = await context(day, api, config, deps, feed);
  return command === "final"
    ? { status: "needs-digest", day, final: true, context: input }
    : writeDigest(input, values, api, deps, config, research, final);
}

function canCloseDay(
  day: string,
  today: string,
  startedAt: Date,
  config: LitScoutConfig,
) {
  const hour = new Intl.DateTimeFormat("en", {
    timeZone: config.instance.timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(startedAt);
  return day <= today && Number(hour) >= 18;
}
export function digestArguments(args: readonly string[]) {
  const [command, ...rest] = args,
    { values: v, positional } = flowOptions(rest, [
      ...(command === "put" ? [] : ["day"]),
      ...(command === "context" ? ["fulltext"] : []),
      ...(command === "run"
        ? ["client", "model", "command", "final", "dry-run"]
        : []),
    ]);
  z.iso.date().optional().parse(v.day);
  if (
    (command === "put" && positional.length === 1) ||
    ((command === "run" || command === "final" || command === "context") &&
      !positional.length)
  )
    return { command, v, file: positional[0] };
  throw new Error("Use digest context|run|put FILE|final");
}
/** A written digest refreshes its month's trends, so Trends no longer
 * depends on a separate step the scheduled run can skip (2026-11-19/20). A
 * refresh that stops or fails is reported beside the digest result. */
export async function withTrends<T>(
  result: T,
  api: FeedApi,
  config: LitScoutConfig,
  refreshMonth: typeof refreshTrends = refreshTrends,
) {
  const written = result as { status?: unknown; day?: unknown };
  if (
    (written.status !== "written" && written.status !== "written-no-batch") ||
    typeof written.day !== "string" ||
    !config.topics.length
  )
    return result;
  const month = written.day.slice(0, 7);
  try {
    const { rowsWritten } = await refreshMonth(api, config, month);
    return { ...result, trends: { status: "refreshed", month, rowsWritten } };
  } catch (error) {
    return {
      ...result,
      trends: {
        status: error instanceof BudgetStop ? "budget-stop" : "failed",
        month,
        ...(error instanceof BudgetStop
          ? {}
          : {
              error: String((error as Error)?.message ?? error).slice(0, 200),
            }),
      },
    };
  }
}

export async function digestCommand(
  args: readonly string[],
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const { command, v, file } = digestArguments(args);
  if (command === "put")
    return withTrends(await putDigest(file!, api, deps, config), api, config);
  if (command === "run" || command === "final") {
    const result = await run(command, v, api, deps, config);
    return v["dry-run"]
      ? { ...result, ...apiHost(config.agent.api) }
      : withTrends(result, api, config);
  }
  const today = localDay(deps, config);
  const day = v.day
    ? z.iso.date().parse(v.day)
    : readingDay(await readDays(api), today);
  if (!day) return { status: "no-new-batch", day: today };
  const { input: result } = await context(day, api, config, deps);
  return v.fulltext
    ? schemas.context.parse({
        ...result,
        fulltext: await fetchRadarText(
          day,
          v.fulltext,
          result.radar,
          api,
          deps.fetch,
          config.digest.radarFullTextPerDay,
        ),
      })
    : result;
}

async function finalNote(
  day: string,
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const bodyMd = noBatchNote(day, config.instance.language);
  await api.write(
    `/digests/${day}`,
    { day, lang: config.instance.language, bodyMd, final: true },
    20,
    "PUT",
  );
  await recordStep(api, deps, "digest", day, "done", { noBatch: true });
  return { status: "written-no-batch", day, bodyMd };
}
