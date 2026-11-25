/**
 * `litscout shadow report`: the weekday comparison of the old pipeline's
 * digest with LitScout's, written where `cutover check` reads it. It replaces
 * the JSON the scheduled agent used to write by hand.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { clientSchema } from "@litscout/core/agent-config";
import type { FeedApi } from "@litscout/pipeline/api";
import { serverBudgetSchema } from "@litscout/pipeline/budget";
import { lastReportedListing, readDays } from "@litscout/pipeline/daily";
import { loadFullFeed } from "@litscout/pipeline/read-client";
import { oldDigestFacts, pickOverlap } from "@litscout/pipeline/shadow-compare";
import { UsageError, type CommandResult } from "./command-types";
import { shadowReport, shadowReportsDir } from "./cutover-command";
import { flowOptions } from "./flow-options";
import { localDay, nowFor, type FlowDeps } from "./flow-runtime";
import { privateJson, secureDir } from "./state";

const usage =
  "Use shadow report (--old-digest FILE | --old-digests DIR) [--old-completed-at ISO] [--new-day YYYY-MM-DD] [--client NAME] [--reports-dir DIR]";
type Report = z.output<typeof shadowReport>;

export function shadowReportOptions(args: readonly string[]) {
  const [command, ...rest] = args;
  if (command !== "report") throw new UsageError(usage);
  const { values, positional } = flowOptions(rest, [
    "old-digest",
    "old-digests",
    "old-completed-at",
    "new-day",
    "client",
    "reports-dir",
  ]);
  // Exactly one source: a file, or the folder the old pipeline writes to.
  if (positional.length || !values["old-digest"] === !values["old-digests"])
    throw new UsageError(usage);
  const parsed = z
    .object({
      oldCompletedAt: z.iso.datetime().optional(),
      newDay: z.iso.date().optional(),
      client: clientSchema.optional(),
    })
    .safeParse({
      oldCompletedAt: values["old-completed-at"],
      newDay: values["new-day"],
      client: values.client,
    });
  if (!parsed.success) throw new UsageError(usage);
  return {
    oldDigest: values["old-digest"],
    oldDigests: values["old-digests"],
    reportsDir: values["reports-dir"],
    ...parsed.data,
  };
}

/** The canonical forms a feed paper can be matched by. */
function identifiersOf(paper: {
  identifiers: { scheme: string; value: string }[];
}) {
  return paper.identifiers.map(({ scheme, value }) =>
    scheme === "arxiv" ? value : `${scheme}:${value}`,
  );
}

async function readBudgetState(api: Pick<FeedApi, "get">) {
  try {
    const budget = serverBudgetSchema.parse(await api.get("/budget"));
    return budget.used + budget.reserved < budget.limit ? "ok" : "stopped";
  } catch {
    return "unknown";
  }
}

/**
 * A later run with less evidence keeps what an earlier run recorded, as a
 * whole and only for the same old digest: the picks belong with the reading
 * days and completion times they were computed from.
 */
function keepEvidence(previous: Report | null, next: Report): Report {
  if (!previous || previous.oldReadingDay !== next.oldReadingDay) return next;
  const comparison = next.picks
    ? {}
    : {
        newReadingDay: previous.newReadingDay,
        newDigestAt: previous.newDigestAt,
        picks: previous.picks,
      };
  return {
    ...next,
    ...comparison,
    client: next.client ?? previous.client,
    budget: next.budget === "unknown" ? previous.budget : next.budget,
  };
}

const datedDigest = /^\d{4}-\d{2}-\d{2}\.md$/;
const datedReport = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * The old digest to compare from the old pipeline's folder: today's file when
 * it exists (a reading-day mismatch is evidence too); otherwise, on a
 * catch-up day, the recent file whose header names LitScout's reading day.
 * Old files are named by the old run's date, not always the reading day.
 */
async function chooseOldDigest(
  dir: string,
  today: string,
  newDay: string | null,
  reportsDir: string,
): Promise<{ file: string } | { skip: "already-compared" | "no-old-digest" }> {
  const todayFile = path.join(dir, `${today}.md`);
  if (
    await stat(todayFile).then(
      () => true,
      () => false,
    )
  )
    return { file: todayFile };
  if (!newDay) return { skip: "no-old-digest" };
  // A run with nothing new must not save the same pair again (a later slot,
  // a weekend day).
  if (await alreadyCompared(reportsDir, newDay))
    return { skip: "already-compared" };
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => datedDigest.test(name))
    .sort()
    .reverse()
    .slice(0, 7);
  for (const name of names) {
    const file = path.join(dir, name);
    const text = await readFile(file, "utf8").catch(() => null);
    if (text && oldDigestFacts(text).readingDay === newDay) return { file };
  }
  return { skip: "no-old-digest" };
}

/** Whether a saved report already compares both digests of this listing. */
async function alreadyCompared(reportsDir: string, day: string) {
  const names = (await readdir(reportsDir).catch(() => [] as string[])).filter(
    (name) => datedReport.test(name),
  );
  for (const name of names) {
    const report = await readFile(path.join(reportsDir, name), "utf8")
      .then((text) => shadowReport.parse(JSON.parse(text)))
      .catch(() => null);
    if (
      report?.oldReadingDay === day &&
      report.newReadingDay === day &&
      report.picks !== null
    )
      return true;
  }
  return false;
}

export async function shadowReportCommand(
  options: ReturnType<typeof shadowReportOptions>,
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  const now = nowFor(deps);
  const today = localDay(deps, config, now);
  const newDay =
    options.newDay ??
    (await readDays(api)
      .then((days) => lastReportedListing(days, today) ?? null)
      .catch(() => null));
  const choice = options.oldDigest
    ? { file: path.resolve(deps.cwd, options.oldDigest) }
    : await chooseOldDigest(
        path.resolve(deps.cwd, options.oldDigests!),
        today,
        newDay,
        shadowReportsDir(deps, options.reportsDir),
      );
  if ("skip" in choice)
    return { data: { status: "skipped", reason: choice.skip, newDay } };
  const oldFile = choice.file;
  const [markdown, info] = await Promise.all([
    readFile(oldFile, "utf8"),
    stat(oldFile),
  ]).catch(() => {
    throw new UsageError("Cannot read the old digest file " + oldFile);
  });
  const old = oldDigestFacts(markdown);
  const digest = newDay
    ? await api
        .get(`/digests/${newDay}?lang=${config.instance.language}`)
        .then((value) =>
          z
            .object({ picks: z.array(z.string()), createdAt: z.iso.datetime() })
            .nullable()
            .parse(value),
        )
        .catch(() => null)
    : null;
  const feed =
    digest && newDay ? await loadFullFeed(api, newDay).catch(() => null) : null;
  const missing =
    digest && feed
      ? digest.picks.filter((id) => !feed.items.some((p) => p.paperId === id))
          .length
      : 0;
  const picks =
    digest && feed
      ? pickOverlap(
          old.ids,
          digest.picks.map((id) => {
            const paper = feed.items.find((item) => item.paperId === id);
            return { identifiers: paper ? identifiersOf(paper) : [] };
          }),
        )
      : null;
  const warnings = missing
    ? [
        `${missing} LitScout pick${missing === 1 ? " is" : "s are"} not in the day's feed; ${missing === 1 ? "it counts" : "they count"} as unmatched`,
      ]
    : [];
  const report = shadowReport.parse({
    version: 1,
    reportedAt: now.toISOString(),
    oldReadingDay: old.readingDay,
    newReadingDay: digest ? newDay : null,
    // Filled below: the flag, else the earlier report, else the file's time.
    oldDigestAt: options.oldCompletedAt ?? null,
    newDigestAt: digest?.createdAt ?? null,
    picks,
    client: options.client ?? null,
    budget: await readBudgetState(api),
  });
  const dir = shadowReportsDir(deps, options.reportsDir);
  // Only a folder made here gets mode 700; an existing one keeps its mode.
  if (
    !(await stat(dir).then(
      () => true,
      () => false,
    ))
  )
    await secureDir(dir);
  const file = path.join(dir, `${today}.json`);
  const previous = await readFile(file, "utf8")
    .then((text) => shadowReport.parse(JSON.parse(text)))
    .catch(() => null);
  const merged = keepEvidence(previous, report);
  const sameOld = previous?.oldReadingDay === merged.oldReadingDay;
  const saved = {
    ...merged,
    oldDigestAt:
      options.oldCompletedAt ??
      (sameOld ? previous?.oldDigestAt : null) ??
      info.mtime.toISOString(),
  };
  await privateJson(file, shadowReport.parse(saved));
  return { data: { file, ...saved, ...(warnings.length ? { warnings } : {}) } };
}
