import { readdir, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import {
  dailyFetch,
  DailyPaperRejectionLimit,
  type Crawl,
} from "@litscout/pipeline/daily";
import type { FeedApi } from "@litscout/pipeline/api";
import { isRejectedPaper } from "@litscout/pipeline/ingest-batching";
import {
  paperSchema,
  schemas,
  daySchema,
} from "@litscout/pipeline/contracts/index";
import { listingCursorSchema } from "@litscout/pipeline/contracts/limits";
import { sourceCrawl } from "./source-crawl";
import { commitState } from "./venue-crawl";
import { nowFor, type FlowDeps } from "./flow-runtime";
import {
  readCheckpoint,
  resumeDirectory,
  writeCheckpoint,
} from "./checkpoint-store";
import { recordStep } from "./summary-command";
const snapshotSchema = z.object({
  day: daySchema,
  venueState: z
    .record(z.string().regex(/^watch-[a-z0-9-]+\.json$/), z.string())
    .optional(),
  result: z.object({
    ...schemas.fetchReport.pick({
      gaps: true,
      noAnnouncement: true,
      warnings: true,
      diagnostics: true,
      invalid: true,
      message: true,
    }).shape,
    days: z.record(daySchema, z.array(paperSchema).max(100000)),
    cursor: z.string().max(2048).nullable(),
    listing: listingCursorSchema.optional(),
    pending: z.boolean().optional(),
    deferred: z.number().int().nonnegative().optional(),
    signals: z
      .record(z.string().max(128), z.number().int().nonnegative())
      .optional(),
  }),
});
async function selection(deps: FlowDeps, endpoint: string, requested?: string) {
  if (requested) daySchema.parse(requested);
  const dir = await resumeDirectory(deps.dir, endpoint);
  const saved = (await readdir(dir))
    .filter((name) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  const day =
    requested ??
    saved[0]?.slice(6, 16) ??
    nowFor(deps).toISOString().slice(0, 10);
  return { day, file: path.join(dir, `daily-${day}.json`) };
}
function crawler(deps: FlowDeps, config: LitScoutConfig) {
  return (
    deps.flow?.crawl ??
    sourceCrawl(config, {
      ...deps,
      cwd: deps.configDir ?? deps.cwd,
      env: deps.env ?? {},
      now: () => nowFor(deps),
      sleep:
        deps.flow?.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal })),
      warn: () => {},
    })
  );
}

class IncompleteDailyWrite extends Error {}

export async function dailyFetchResuming(
  requested: string | undefined,
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const { day, file } = await selection(
    deps,
    config.instance.publicUrl!,
    requested,
  );
  const saved = await readCheckpoint(file, snapshotSchema);
  if (saved && saved.day !== day)
    throw new Error("Resume checkpoint day mismatch");
  const original = crawler(deps, config);
  const crawl: Crawl = async (...args) => {
    if (saved)
      return {
        ...saved.result,
        complete: () =>
          commitState(deps.dir, Object.entries(saved.venueState ?? {})),
      };
    const result = await original(...args);
    const venueState = "venueState" in result ? result.venueState : undefined;
    await writeCheckpoint(
      file,
      snapshotSchema.parse({ day, result, venueState }),
    );
    return result;
  };
  const checkedApi: FeedApi = {
    ...api,
    async write(...args) {
      const failures = api.batching?.failures.length ?? 0;
      const response = await api.write(...args);
      if (
        api.batching?.failures
          .slice(failures)
          .some((failure) => !isRejectedPaper(failure))
      )
        throw new IncompleteDailyWrite("Daily upload incomplete.");
      return response;
    },
  };
  const result = await dailyFetch(day, checkedApi, crawl, config.topics).catch(
    (error: unknown) => {
      if (
        !(error instanceof IncompleteDailyWrite) &&
        !(error instanceof DailyPaperRejectionLimit)
      )
        throw error;
      return {
        status: "error" as const,
        day,
        message: `${error.message} Retry with the saved checkpoint.`,
      };
    },
  );
  if (result.status === "error") return result;
  if (result.status === "budget-short") return result;
  if (result.status !== "exists")
    await recordStep(api, deps, "crawl", day, "done", result);
  await rm(file, { force: true });
  return result;
}
