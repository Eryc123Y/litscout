import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { BudgetStop, chunks, type FeedApi } from "@litscout/pipeline/api";
import { fitBatch, jsonBytes } from "@litscout/pipeline/ingest-batching";
import {
  shiftMonth,
  trendDigest,
  trendEvent,
  trendMonth,
  trendPage,
  trendPaper,
  trendRadar,
  trendsBatchSize,
  trendsPath,
  trendsQuery,
  trendsResponse,
  trendsSourcePath,
  trendsUploadBytes,
  trendsUploadPath,
  trendWindow,
  type TrendSourceQuery,
} from "@litscout/pipeline/trends-contracts";
import { topicsFor } from "@litscout/pipeline/topics";
import { aggregateTrends } from "@litscout/pipeline/trends";
import { UsageError, type CommandResult } from "./command-types";
import { endpointConfig } from "./endpoint";
import { flowOptions } from "./flow-options";
import { flowApi, localDay, withFlowLock, type FlowDeps } from "./flow-runtime";
import { privateJson } from "./state";

export function trendsOptions(args: readonly string[]) {
  const action =
    args[0] === "refresh" || args[0] === "backfill" ? args[0] : "read";
  let options: ReturnType<typeof flowOptions>;
  try {
    options = flowOptions(
      action === "read" ? args : args.slice(1),
      action === "read" ? ["topic", "month"] : ["month"],
    );
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (options.positional.length)
    throw new UsageError(
      "Use trends [--topic T] [--month YYYY-MM], trends refresh [--month YYYY-MM], or trends backfill",
    );
  const query = trendsQuery.parse({
    topic: options.values.topic,
    month: options.values.month,
  });
  if (action === "backfill" && query.month)
    throw new UsageError(
      "Use trends refresh --month YYYY-MM to refresh a specific month",
    );
  return { action, query };
}

async function source<T extends z.ZodType>(
  api: FeedApi,
  month: string,
  kind: TrendSourceQuery["kind"],
  schema: T,
): Promise<z.output<T>[]> {
  const page = trendPage(schema);
  const query = new URLSearchParams({ month, kind });
  const items: z.output<T>[] = [];
  for (;;) {
    const data = page.parse(await api.get(trendsSourcePath + "?" + query));
    items.push(...data.items);
    if (!data.nextCursor) return items;
    if (data.nextCursor === query.get("cursor"))
      throw new UsageError("Trends source did not advance. Retry the month.");
    query.set("cursor", data.nextCursor);
  }
}

async function readMonth(api: FeedApi, month: string) {
  const papers = await source(api, month, "papers", trendPaper);
  const digests = await source(api, month, "digests", trendDigest);
  // Stored digest references include radar entries as well as picks.
  const picks = digests.flatMap((digest) => {
    const radar = new Set(digest.radar.map(({ paperId }) => paperId));
    return digest.picks.filter((paperId) => !radar.has(paperId));
  });
  // An older Worker sends papers without their day; then the count is unknown.
  const days = papers.every((paper) => paper.day)
    ? papers.map((paper) => paper.day!)
    : undefined;
  return {
    papers,
    picks,
    days,
    radar: digests.flatMap((digest) => digest.radar),
  };
}

/** Recompute and upload one month's trends for every configured topic. */
export async function refresh(
  api: FeedApi,
  config: LitScoutConfig,
  month: string,
) {
  // Stop before scanning history if there is no room for even one upload.
  const budget = await api.readBudget?.();
  if (budget && budget.used + budget.reserved + 5 >= budget.limit)
    throw new BudgetStop(budget.resetAt);
  const current = await readMonth(api, month);
  current.radar.push(...(await source(api, month, "radar", trendRadar)));
  const events = await source(
    api,
    month,
    "events",
    trendEvent.extend({ at: z.string() }),
  );
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const baseline = trendMonth.safeParse(shiftMonth(month, -1));
  const previous = baseline.success
    ? await readMonth(api, baseline.data)
    : { papers: [], picks: [], days: [] };
  const known = new Set(current.papers.map(({ paperId }) => paperId));
  const references: z.output<typeof trendPaper>[] = [];
  const missing = new Set(
    [
      ...current.picks,
      ...current.radar.map(({ paperId }) => paperId),
      ...events.map(({ paperId }) => paperId),
    ].filter((paperId) => !known.has(paperId)),
  );
  for (const ids of chunks([...missing], 20))
    references.push(
      ...z
        .array(trendPaper)
        .parse(
          await api.get(
            trendsSourcePath +
              "/references?" +
              new URLSearchParams({ ids: JSON.stringify(ids) }),
          ),
        ),
    );
  const topics = [
    ...new Map(config.topics.map((topic) => [topic.name, topic])).values(),
  ];
  for (const paper of references)
    if (!paper.topics.length)
      paper.topics = topicsFor(
        { title: paper.title, summary: paper.abstract ?? undefined },
        topics,
      );
  const rows = aggregateTrends(
    month,
    topics,
    { ...current, events, references },
    previous,
  );
  const maximumBytes = Math.min(
    trendsUploadBytes,
    config.instance.limits.ingest.bytes,
  );
  const bodies: { rows: typeof rows }[] = [];
  for (let offset = 0; offset < rows.length;) {
    const body = (size: number) => ({
      rows: rows.slice(offset, offset + size),
    });
    const size = fitBatch(
      Math.min(trendsBatchSize, rows.length - offset),
      maximumBytes,
      body,
    );
    const batch = body(size);
    if (jsonBytes(batch) > maximumBytes)
      throw new UsageError(
        "A monthly trends row exceeds the configured upload limit.",
      );
    bodies.push(batch);
    offset += size;
  }
  let rowsWritten = 0;
  for (const body of bodies) {
    const result = z
      .object({ rowsWritten: z.number().int().nonnegative() })
      .safeParse(
        await api.write(trendsUploadPath, body, body.rows.length, "PUT"),
      );
    if (!result.success)
      throw new UsageError(
        "Trends upload was interrupted. Retry the same month.",
      );
    rowsWritten += result.data.rowsWritten;
  }
  return { topics: rows.length, rowsWritten };
}

const checkpointSchema = z.object({ nextMonth: trendMonth.nullable() });
async function backfillCheckpoint(
  deps: FlowDeps,
  config: LitScoutConfig,
  currentMonth: string,
) {
  const url = (await endpointConfig(config, deps.dir)).config.instance
    .publicUrl;
  if (!url)
    throw new UsageError("Set instance.publicUrl before backfilling trends");
  const key = createHash("sha256")
    .update(new URL(url).origin)
    .digest("hex")
    .slice(0, 16);
  const file = path.join(deps.dir, `trends-backfill-${key}.json`);
  const saved = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    },
  );
  const nextMonth =
    saved === null
      ? shiftMonth(currentMonth, -1)
      : checkpointSchema.parse(JSON.parse(saved)).nextMonth;
  return { file, nextMonth };
}

export async function trendsCommand(
  args: readonly string[],
  deps: FlowDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  const { action, query } = trendsOptions(args);
  if (action === "read") {
    const api = await flowApi(deps, config, { cacheBudget: false });
    const params = new URLSearchParams();
    if (query.topic) params.set("topic", query.topic);
    if (query.month) params.set("month", query.month);
    const result = trendsResponse.parse(
      await api.get(trendsPath + "?" + params),
    );
    const { detail } = result;
    return {
      data: {
        ...result,
        messages: [
          `${result.topic ?? "No configured topic"} · ${result.month}`,
          ...(detail
            ? [
                `${detail.volume} papers · ${detail.shortlisted} shortlisted · ${detail.pickCount} picks`,
                `Radar: ${detail.radar.high} high · ${detail.radar.medium} medium · ${detail.radar.borrow} borrow`,
                `${detail.saveCount} saved · ${detail.ratingCount} rated`,
                `Recurring: ${detail.recurring.map(({ term }) => term).join(", ") || "—"}`,
                `Rising: ${detail.rising.map(({ term }) => term).join(", ") || "—"}`,
                ...detail.picks.map(
                  ({ title, paperId }) => `Pick: ${title ?? paperId}`,
                ),
                ...detail.activity.map(
                  ({ title, paperId, saved, rating }) =>
                    `${[saved ? "Saved" : "", rating === "up" ? "Rated up" : rating === "down" ? "Rated down" : ""].filter(Boolean).join(", ")}: ${title ?? paperId}`,
                ),
              ]
            : [
                "Trends will appear after the first refresh after a daily digest.",
              ]),
        ],
      },
    };
  }
  if (!config.topics.length)
    return {
      empty: true,
      data: { status: "no-topics", messages: ["No topics configured."] },
    };
  return withFlowLock(deps, async () => {
    const currentMonth = localDay(deps, config).slice(0, 7);
    const checkpoint =
      action === "backfill"
        ? await backfillCheckpoint(deps, config, currentMonth)
        : undefined;
    const month = checkpoint
      ? checkpoint.nextMonth
      : (query.month ?? currentMonth);
    const complete = {
      empty: true,
      data: {
        status: "complete",
        nextMonth: null,
        messages: ["Trends backfill is complete."],
      },
    };
    if (!month) return complete;
    if (month > currentMonth)
      throw new UsageError("Choose the current month or an earlier month");
    const api = await flowApi(deps, config);
    try {
      const oldest = checkpoint
        ? trendWindow.parse(await api.get(trendsSourcePath + "/window"))
            .oldestMonth
        : null;
      if (checkpoint && (!oldest || month < oldest)) {
        await privateJson(checkpoint.file, { nextMonth: null });
        return complete;
      }
      const done = await refresh(api, config, month);
      const nextMonth = oldest && month > oldest ? shiftMonth(month, -1) : null;
      if (checkpoint) await privateJson(checkpoint.file, { nextMonth });
      return {
        data: {
          status: "refreshed",
          month,
          nextMonth,
          ...done,
          messages: [
            `${month}: refreshed ${done.topics} topics (${done.rowsWritten} trend rows written).`,
            ...(nextMonth
              ? [`Run trends backfill again to resume at ${nextMonth}.`]
              : []),
          ],
        },
      };
    } catch (error) {
      if (error instanceof BudgetStop)
        return {
          failed: true,
          data: {
            status: "budget-stop",
            month,
            resumeAt: error.resumeAt,
            messages: [error.message],
          },
        };
      throw error;
    }
  });
}
