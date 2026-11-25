import { z } from "zod";
import { schemas } from "@litscout/pipeline/contracts/index";
import { legacyRunPrefix } from "@litscout/pipeline/health-contracts";
import {
  validateJsonl,
  validateRecords,
  InvalidRecordLimit,
  type InvalidRecord,
} from "@litscout/pipeline/records";
import type { LegacyPlan } from "./legacy";
type Window = { from: string; to: string };
const selected = (day: string, window: Window) =>
  day >= window.from && day <= window.to;
const runShape = z
  .object({
    date: z.iso.date(),
    path: z.string(),
    at: z.iso.datetime({ offset: true }),
  })
  .passthrough();
function runRecord(value: unknown, index: number) {
  const r = runShape.parse(value),
    at = new Date(r.at).toISOString();
  return schemas.run.parse({
    id: `${legacyRunPrefix}${r.date}_${index}`,
    day: r.date,
    kind:
      r.path === "crawl"
        ? "crawl"
        : r.path === "report"
          ? "digest"
          : "summaries",
    status: r.path.startsWith("paused")
      ? "paused"
      : Number(r.pending ?? 0) > 0
        ? "partial"
        : "done",
    startedAt: at,
    finishedAt: at,
    stats: r,
    error: null,
  });
}
export function legacyMetadata(
  files: Record<string, string>,
  folder: Record<string, string>,
  window: Window,
) {
  let index = 0;
  const source = validateJsonl(
    null,
    files["logs/summary-runs.jsonl"] ?? "",
    (value) => runRecord(value, index++),
  );
  const runs = source.accepted.filter((r) => selected(r.day, window)),
    invalid = source.invalid.filter(
      (issue) => !issue.day || selected(issue.day, window),
    );
  const entries = Object.entries(folder).flatMap(([key, bodyMd]) => {
    const day = key.match(/^digests\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
    return day && selected(day, window) ? [{ key, day, bodyMd }] : [];
  });
  const digests = validateRecords(null, entries, (value) => {
    const v = value as (typeof entries)[number];
    return schemas.digest.parse({ day: v.day, bodyMd: v.bodyMd });
  });
  return {
    runs,
    digests: digests.accepted.map(({ day, bodyMd }) => ({ day, bodyMd })),
    invalid: [...invalid, ...digests.invalid],
  };
}
export function qualityDays(
  days: LegacyPlan["days"],
  metadata: ReturnType<typeof legacyMetadata>,
  invalid: InvalidRecord[],
  fallbackDay: string,
) {
  const totals = new Map(days.map((d) => [d.day, d.totalRecords]));
  for (const r of [
    ...metadata.runs,
    ...metadata.digests,
    ...metadata.invalid,
  ]) {
    const day = r.day ?? fallbackDay;
    totals.set(day, (totals.get(day) ?? 0) + 1);
  }
  for (const [day, total] of totals) {
    const errors = invalid.filter(
      (issue) => (issue.day ?? fallbackDay) === day,
    );
    if (errors.length * 100 > total)
      throw new InvalidRecordLimit(day, total, errors.length, errors);
  }
  return days.map((day) => ({
    ...day,
    totalRecords: totals.get(day.day)!,
    skipped: invalid.filter((issue) => (issue.day ?? fallbackDay) === day.day)
      .length,
  }));
}
