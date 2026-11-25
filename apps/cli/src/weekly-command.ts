import { loadFullFeed, loadHistory } from "@litscout/pipeline/read-client";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { radarSchema, missedSchema } from "@litscout/pipeline/contracts/index";
import { weeklyReview } from "@litscout/pipeline/digest";
import {
  findMisses,
  weekHealth,
  weeklyCounts,
} from "@litscout/pipeline/weekly";
import { shiftDay, daysSchema } from "@litscout/pipeline/daily";
import { chunks, type FeedApi } from "@litscout/pipeline/api";
import { localDay, type FlowDeps } from "./flow-runtime";
import { flowOptions } from "./flow-options";
import { recordStep } from "./summary-command";
const reportSchema = z.object({
  day: z.string(),
  bodyMd: z.string(),
  picks: z.array(z.string()),
  radar: z.array(z.unknown()),
});
const opsSchema = z.object({
  radar: z.array(radarSchema.strip()),
  missed: z.array(missedSchema),
  runs: z.array(z.unknown()),
});
async function loadWeek(day: string, api: FeedApi, config: LitScoutConfig) {
  const days = daysSchema.parse(await api.get("/feed/days?limit=100")),
    reports = [],
    papers = [];
  const listed = new Map<string, string>();
  for (const entry of await loadHistory(api, shiftDay(day, -60), day))
    for (const p of entry.items) {
      papers.push(p);
      if (!listed.has(p.paperId) || listed.get(p.paperId)! > entry.day)
        listed.set(p.paperId, entry.day);
    }
  for (const d of days.filter(
    (d) => d.day >= shiftDay(day, -6) && d.day <= day,
  )) {
    const report = await api.get(
      `/digests/${d.day}?lang=${config.instance.language}`,
    );
    if (report) reports.push(reportSchema.parse(report));
  }
  return { days, reports, papers, listed };
}
async function review(day: string, api: FeedApi, config: LitScoutConfig) {
  const data = await loadWeek(day, api, config);
  const ops = opsSchema.parse(
    await api.get(`/operations?from=${shiftDay(day, -60)}&to=${day}`),
  );
  const misses = findMisses(
    ops.radar,
    data.listed,
    ops.missed.map((m) => m.paperId),
  );
  for (const slice of chunks(misses))
    await api.write("/ingest/legacy", { missed: slice }, slice.length * 10);
  const recentMisses = [...ops.missed, ...misses].filter(
    (m) => m.foundOn > shiftDay(day, -30),
  );
  const picked = new Set(data.reports.flatMap((r) => r.picks));
  const candidates = data.papers
      .filter((p) => !picked.has(p.paperId))
      .slice(0, 3),
    full = [];
  for (const date of new Set(candidates.map((p) => p.day))) {
    const entries = candidates.filter((p) => p.day === date);
    const feed = await loadFullFeed(
      api,
      date,
      entries.map((p) => p.paperId),
    );
    full.push(
      ...entries.flatMap((p) =>
        feed.items.filter(
          (r) => r.paperId === p.paperId && r.source === p.source,
        ),
      ),
    );
  }
  const result = weeklyReview(
    day,
    data.reports,
    full,
    recentMisses,
    config.instance.language,
  );
  const days = data.days
    .filter((d) => d.day >= shiftDay(day, -6) && d.day <= day)
    .map((d) => d.day)
    .sort();
  const papers = data.papers.filter(
    (p) => data.listed.get(p.paperId)! >= shiftDay(day, -6),
  );
  result.bodyMd += `\n${weeklyCounts(day, data.reports, papers, config.topics, config.instance.language)}\n\n${weekHealth(ops.runs, days, config.instance.timezone, config.instance.language)}\n`;
  return { result, reports: data.reports.length, misses: misses.length };
}
export function weeklyDay(args: readonly string[]) {
  const { values: v, positional } = flowOptions(args, ["day"]);
  if (positional.length) throw new Error("Use weekly [--day DAY]");
  return z.iso.date().optional().parse(v.day);
}
export async function weeklyCommand(
  args: readonly string[],
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const day = weeklyDay(args) ?? localDay(deps, config);
  const { result, reports, misses } = await review(day, api, config);
  const existing = await api.get(
    `/digests/${day}?lang=${config.instance.language}&kind=weekly`,
  );
  if (reports && !existing) {
    await api.write(
      `/digests/${day}`,
      {
        day,
        lang: config.instance.language,
        kind: "weekly",
        bodyMd: result.bodyMd,
      },
      20,
      "PUT",
    );
    await recordStep(api, deps, "weekly", day, "done", {
      reports,
      missed: misses,
    });
  }
  return result;
}
