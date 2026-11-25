import { readFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { clientSchema } from "@litscout/core/agent-config";
import { schemas } from "@litscout/pipeline/contracts/index";
import { todoPageSchema } from "@litscout/pipeline/read-contracts";
import { runSummaries, type AgentOptions } from "@litscout/pipeline/agents";
import { chunks, type FeedApi } from "@litscout/pipeline/api";
import { flowOptions, integerOption } from "./flow-options";
import {
  agentRunner,
  agentPreflight,
  localDay,
  nowFor,
  summaryPrompt,
  type FlowDeps,
} from "./flow-runtime";
import { batchResponse } from "@litscout/pipeline/records";
import { readDays, readingDay } from "@litscout/pipeline/daily";
import { apiHost, apiPreview, summaryOutputTokens } from "./agent-api";
export async function recordStep(
  api: FeedApi,
  deps: FlowDeps,
  kind: "crawl" | "summaries" | "digest" | "weekly" | "legacy_import",
  day: string,
  status: string,
  stats: Record<string, unknown>,
) {
  const at = nowFor(deps).toISOString();
  await api.write(
    "/ingest/legacy",
    {
      runs: [
        {
          id: `run_${ulid()}`,
          kind,
          day,
          status,
          startedAt: at,
          finishedAt: at,
          stats,
        },
      ],
    },
    50,
  );
}
export async function todoFor(
  api: FeedApi,
  day: string,
  lang: "en" | "zh",
  size: number,
) {
  const items = [],
    seen = new Set<string>();
  let cursor: string | null | undefined, feed;
  do {
    const page = todoPageSchema.parse(
      await api.get(
        `/feed/days/${day}/summary-todo?lang=${lang}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
    feed ??= page;
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Repeated summary cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return {
    feed,
    todo: schemas.todo.parse({
      day,
      lang,
      chunks: chunks(items, size),
      noAbstract: feed.noAbstract,
    }),
  };
}

async function markSummaryDay(
  api: FeedApi,
  day: string,
  lang: "en" | "zh",
  current?: Awaited<ReturnType<typeof todoFor>>,
) {
  const { feed, todo } = current ?? (await todoFor(api, day, lang, 100));
  if (!todo.chunks.length && feed.counts.total && feed.status === "crawled")
    await api.write(
      "/ingest/feed-day",
      {
        day,
        status: "summarised",
        counts: {
          ...feed.counts.sources,
          total: feed.counts.total,
          summarised: feed.counts.summarised,
          shortlisted: feed.counts.shortlisted,
        },
      },
      10,
    );
}
export async function runDaySummaries(
  day: string,
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
  options: AgentOptions,
  size: number,
  dryRun = false,
  namedDay = false,
) {
  const { feed, todo } = await todoFor(
    api,
    day,
    config.instance.language,
    size,
  );
  // A day without an arXiv listing (venue papers only) is summarised only
  // when the run names it with --day; the scheduled runs read listings.
  const venueOnly = !feed.counts.arxiv || feed.status === "pending";
  if (!feed.counts.total || feed.status === "empty" || (venueOnly && !namedDay))
    return {
      status: "no-new-batch",
      day,
      ...(dryRun && apiHost(config.agent.api)),
    };
  if (dryRun) {
    const selected =
      options.client === "api" || !!options.fallback?.includes("api");
    return apiPreview(
      day,
      config.agent.api,
      selected,
      config.agent.api && selected
        ? todo.chunks.slice(0, options.maxChunks).map((papers) => ({
            prompt: summaryPrompt(papers, options.lang, "api", options.math),
            outputTokens: summaryOutputTokens(papers.length),
          }))
        : [],
    );
  }
  if (!todo.chunks.length) {
    await markSummaryDay(api, day, options.lang, { feed, todo });
    return {
      status: "done",
      day,
      ran: 0,
      failures: [],
      stopped: null,
      quarantined: [],
    };
  }
  const usage = usageReader(config, deps);
  let uploaded = 0;
  const result = await runSummaries(
    todo.chunks,
    { ...options, apiModel: config.agent.api?.model },
    {
      run: agentRunner(deps, day, options, config.agent.api),
      preflight: agentPreflight(deps, config.agent.api),
      usage,
      upload: async (summaries) => {
        for (const slice of chunks(summaries)) {
          const reply = await api.write(
            "/ingest/summaries",
            schemas.summaries.parse({ summaries: slice }),
            100 * slice.length,
          );
          const batch = batchResponse(reply, slice.length);
          uploaded +=
            batch.accepted + Math.max(0, batch.skipped - batch.invalid.length);
        }
      },
    },
  );
  const paused = ["usage gate", "chunk budget", "quota exhausted"].some(
    (reason) => result.stopped === reason,
  );
  const failed =
    result.stopped ||
    result.failures.length ||
    result.quarantined.length ||
    uploaded < todo.chunks.flat().length;
  const status =
    result.stopped === "budget-short"
      ? "budget-short"
      : paused
        ? "paused"
        : failed
          ? uploaded
            ? "partial"
            : "error"
          : "done";
  if (uploaded) await markSummaryDay(api, day, options.lang);
  await recordStep(api, deps, "summaries", day, status, result);
  return { status, day, ...result };
}
export function summaryArguments(args: readonly string[]) {
  const [command, ...rest] = args,
    { values: v, positional } = flowOptions(rest, [
      "day",
      ...(command === "run"
        ? [
            "client",
            "parallel",
            "chunk-size",
            "max-chunks",
            "command",
            "model",
            "dry-run",
          ]
        : []),
    ]);
  z.iso.date().optional().parse(v.day);
  if (
    (command === "put" && positional.length === 1) ||
    ((command === "todo" || command === "run") && !positional.length)
  )
    return { command, v, file: positional[0] };
  throw new Error(
    "Use summaries todo|put FILE|run [--client CLIENT] [--dry-run]",
  );
}
export async function summaryCommand(
  args: readonly string[],
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const { command, v, file } = summaryArguments(args);
  const today = localDay(deps, config);
  const day =
    v.day !== undefined
      ? z.iso.date().parse(v.day)
      : command === "todo" || command === "run"
        ? readingDay(await readDays(api), today)
        : today;
  const lang = config.instance.language,
    defaults = config.agent.summaries;
  if (command === "todo")
    return day
      ? (await todoFor(api, day, lang, defaults.chunkSize)).todo
      : { status: "no-new-batch", day: today };
  if (command === "put") return putSummaries(file!, api, day!, lang);
  if (!day)
    return {
      status: "no-new-batch",
      day: today,
      ...(v["dry-run"] && apiHost(config.agent.api)),
    };
  return runDaySummaries(
    day,
    api,
    deps,
    config,
    summaryOptions(v, config),
    integerOption(v["chunk-size"], defaults.chunkSize),
    v["dry-run"] === "true",
    v.day !== undefined,
  );
}

function summaryOptions(
  v: Record<string, string>,
  config: LitScoutConfig,
): AgentOptions {
  const defaults = config.agent.summaries;
  const client = clientSchema.parse(v.client ?? defaults.client);
  if (client === "api" && (v.model || v.command))
    throw new Error("Configure the API model in agent.api.model");
  return {
    client,
    lang: config.instance.language,
    parallel: integerOption(v.parallel, defaults.parallel, 8),
    maxChunks: integerOption(v["max-chunks"], defaults.maxChunks, 10000),
    command: v.command
      ? z.array(z.string()).parse(JSON.parse(v.command))
      : v.client && v.client !== defaults.client
        ? undefined
        : defaults.command,
    model:
      v.model ??
      (v.client && v.client !== defaults.client ? undefined : defaults.model),
    fallback: defaults.fallback,
    timeout: defaults.timeout,
    math: defaults.math,
  };
}

export function usageReader(config: LitScoutConfig, deps: FlowDeps) {
  return async () =>
    config.agent.summaries.usageFile
      ? schemas.usage.parse(
          JSON.parse(
            await readFile(
              path.resolve(
                deps.configDir ?? deps.cwd,
                config.agent.summaries.usageFile,
              ),
              "utf8",
            ),
          ),
        )
      : null;
}

async function putSummaries(
  file: string,
  api: FeedApi,
  day: string,
  lang: "en" | "zh",
) {
  const value = schemas.summaryBatch.parse(
    JSON.parse(await readFile(file, "utf8")),
  );
  const result = batchResponse(
    await api.write(
      "/ingest/summaries",
      { ...value, day: value.day ?? day },
      100 * value.summaries.length,
    ),
    value.summaries.length,
  );
  await markSummaryDay(api, day, lang);
  return { status: "done", summaries: result.accepted, ...result };
}
