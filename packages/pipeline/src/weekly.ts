import { z } from "zod";
import {
  radarSchema,
  missedSchema,
  runSchema,
  type FeedItem,
} from "./contracts/index";
import { shiftDay } from "./daily";
import { reportStrings } from "@litscout/i18n";
import { formatTimestamp } from "./display-time";
export type Radar = z.output<typeof radarSchema>;
export function findMisses(
  radar: Radar[],
  listedOn: ReadonlyMap<string, string>,
  known: readonly string[],
) {
  return radar
    .filter(
      (r) =>
        r.lookBack &&
        listedOn.has(r.paperId) &&
        listedOn.get(r.paperId)! < r.day &&
        !known.includes(r.paperId),
    )
    .map((r) =>
      missedSchema.parse({
        id: `miss_${r.day}_${r.paperId}`,
        paperId: r.paperId,
        foundOn: r.day,
        where: "Sunday look-back",
        note: `${r.level}: ${r.reason}`,
      }),
    );
}
function clock(at: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const value = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: `${value.year}-${value.month}-${value.day}`,
    time: `${value.hour}:${value.minute}`,
  };
}
export function weekHealth(
  input: unknown[],
  days: string[],
  timezone: string,
  lang: "en" | "zh",
) {
  // Only crawl, summary and digest runs count; retention, the Worker's cron
  // and other jobs record runs of their own kinds too.
  const runs = z
      .array(runSchema.strip().extend({ kind: z.string().max(64) }))
      .parse(input),
    lines = [`**${reportStrings[lang].health}**`];
  let hits = 0,
    eligible = 0;
  for (const day of days) {
    const entries = runs
      .filter((r) => r.day === day)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const landed = entries.find(
        (r) => r.kind === "crawl" && r.status === "done",
      ),
      done = entries.find((r) => r.kind === "summaries" && r.status === "done"),
      report = entries.find((r) => r.kind === "digest" && r.status === "done");
    const when = (r: typeof landed) =>
      r ? formatTimestamp(r.finishedAt ?? r.startedAt, timezone) : "—";
    lines.push(
      `- ${day}: ${when(landed)} → ${when(done)} → ${when(report)}; ${entries.filter((r) => r.status === "paused").length} ${lang === "zh" ? "次暂停" : "pauses"}`,
    );
    const early = landed
      ? clock(landed.finishedAt ?? landed.startedAt, timezone)
      : null;
    if (
      !early ||
      early.day !== day ||
      early.time > "10:00" ||
      [0, 6].includes(new Date(day).getUTCDay())
    )
      continue;
    eligible++;
    const written = report
      ? clock(report.finishedAt ?? report.startedAt, timezone)
      : null;
    if (written?.day === day && written.time <= "11:30") hits++;
  }
  lines.push(
    `- ${lang === "zh" ? "准时" : "On time"}: ${hits}/${eligible} (${lang === "zh" ? "日报 11:30 前；仅统计 10:00 前到达的工作日" : "report by 11:30; weekdays with data by 10:00 only"})`,
  );
  return lines.join("\n");
}
export function weeklyCounts(
  day: string,
  reports: { day: string; picks: string[] }[],
  papers: Pick<FeedItem, "paperId" | "topics" | "source" | "venue">[],
  topics: readonly { name: string }[],
  lang: "en" | "zh",
) {
  const selected = reports.filter(
      (r) => r.day >= shiftDay(day, -6) && r.day <= day,
    ),
    lines: string[] = [];
  for (const topic of topics) {
    const count = selected.reduce(
      (n, r) =>
        n +
        r.picks.filter((id) =>
          papers.some((p) => p.paperId === id && p.topics.includes(topic.name)),
        ).length,
      0,
    );
    lines.push(`- ${topic.name}: ${count}`);
  }
  const venues = new Map<string, number>();
  for (const p of papers.filter((p) => p.source !== "arxiv")) {
    const venue = String(p.venue ?? p.source);
    venues.set(venue, (venues.get(venue) ?? 0) + 1);
  }
  if (venues.size)
    lines.push(
      `**${lang === "zh" ? "本周期刊" : "This week's venues"}**: ${[...venues].map(([v, n]) => `${v} ${n}`).join(" · ")}`,
    );
  return lines.join("\n");
}
