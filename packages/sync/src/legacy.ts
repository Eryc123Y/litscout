import { legacyMetadata, qualityDays } from "./legacy-metadata";
import { legacySteps } from "./legacy-upload";
import { ulid } from "ulid";
import { z } from "zod";
import {
  schemas,
  daySchema,
  fivePartSchema,
  type PaperInput,
} from "@litscout/pipeline/contracts/index";
import { type FeedApi } from "@litscout/pipeline/api";
import { type InvalidRecord } from "@litscout/pipeline/records";
import { legacyDays } from "./legacy-days";
import { importTrace } from "./import-trace";
import { shiftDay } from "@litscout/pipeline/daily";
import { parseRadarTable, parseLedger } from "./legacy-records";
import { importLegacyDates } from "./legacy-budgeted";
import { legacyCursorSchema } from "@litscout/pipeline/contracts/limits";
export { parseRadarTable } from "./legacy-records";
export function legacyWindow(
  today: string,
  from = shiftDay(today, -29),
  to = today,
) {
  daySchema.parse(from);
  daySchema.parse(to);
  if (from > to) throw new Error("Legacy --from must not follow --to");
  return { from, to };
}
type Window = ReturnType<typeof legacyWindow>;
const inWindow = (day: string, w: Window) => day >= w.from && day <= w.to;
type LegacySummary = {
  key: string;
  lang: "en" | "zh";
  content: z.output<typeof fivePartSchema>;
};
export type LegacyPlan = {
  ledger: { day: string; key: string }[];
  days: {
    day: string;
    papers: PaperInput[];
    summaries: LegacySummary[];
    totalRecords: number;
    skipped: number;
  }[];
  invalid: InvalidRecord[];
  digests: { day: string; bodyMd: string }[];
  radar: ReturnType<typeof parseRadarTable>["rows"];
  missed: ReturnType<typeof parseRadarTable>["rows"];
  ratings: {
    day: string;
    key: string;
    kind: "rate_up" | "rate_down" | "rate_clear";
  }[];
  cursors: { name: string; value: string }[];
  runs: z.output<typeof schemas.legacy>["runs"];
  warnings: string[];
};
export const importCheckpointSchema = legacyCursorSchema;
export type ImportCheckpoint = {
  state: z.output<typeof importCheckpointSchema> | null;
  save: (state: z.output<typeof importCheckpointSchema>) => Promise<void>;
};
function legacyRatings(text: string, window: Window): LegacyPlan["ratings"] {
  return text.split(/\r?\n/).flatMap((line) => {
    const day = line.match(/\d{4}-\d{2}-\d{2}/)?.[0],
      key = line.match(
        /\b\d{4}\.\d{4,5}\b|(?:doi|openreview|url):[^\s|]+/,
      )?.[0];
    if (!day || !key || !inWindow(day, window)) return [];
    const kind = /\bdown\b|👎|不喜欢/i.test(line)
      ? "rate_down"
      : /\bup\b|👍|喜欢/i.test(line)
        ? "rate_up"
        : /\bclear\b/i.test(line)
          ? "rate_clear"
          : null;
    return kind ? [{ day, key, kind }] : [];
  });
}
export function planLegacy(
  files: Record<string, string>,
  folder: Record<string, string>,
  window: Window,
): LegacyPlan {
  const records = legacyDays(files, window);
  const metadata = legacyMetadata(files, folder, window);
  const invalid = [...records.invalid, ...metadata.invalid];
  const days = qualityDays(records.days, metadata, invalid, window.to);
  const ledger = parseLedger(
    folder["ledger.json"] ?? "",
    window.from,
    window.to,
  );
  const radar = parseRadarTable(
      folder["project-radar.md"] ?? "",
      window.from,
      window.to,
    ),
    missed = parseRadarTable(folder["missed.md"] ?? "", window.from, window.to);
  const cursors = venueCursor(files["assets/feed-cursor.json"]);
  return {
    days,
    invalid,
    ledger: ledger.rows,
    digests: metadata.digests,
    radar: radar.rows,
    missed: missed.rows,
    ratings: legacyRatings(folder["feedback.md"] ?? "", window),
    cursors,
    runs: metadata.runs,
    warnings: [...radar.warnings, ...missed.warnings, ...ledger.warnings],
  };
}
export async function importLegacy(
  plan: LegacyPlan,
  api: FeedApi,
  name: string,
  dryRun: boolean,
  checkpoint?: ImportCheckpoint,
  maxRows?: number,
  now = new Date(),
  /** Rows of the live balance to leave for the rest of the day. */
  keepRows?: number,
) {
  const { counts, estimatedRows } = legacyPreview(plan);
  if (dryRun)
    return {
      status: "dry-run",
      counts,
      estimatedRows,
      operations: 0,
      warnings: plan.warnings,
      invalid: plan.invalid,
      chunks: [],
    };
  const state = await importCursor(api, name, checkpoint?.state);
  const trace = importTrace(plan, api);
  const finish = () => ({
    warnings: plan.warnings,
    invalid: [
      ...plan.invalid,
      ...trace.chunks.flatMap((chunk) => chunk.invalid),
    ],
    chunks: trace.chunks,
  });
  if (maxRows !== undefined || keepRows !== undefined || state.version === 2) {
    const progress = await importLegacyDates(
      plan,
      api,
      trace.api,
      name,
      state,
      { stats: { counts, estimatedRows } },
      now,
      maxRows,
      checkpoint,
      keepRows,
    );
    return { ...progress, counts, estimatedRows, ...finish() };
  }
  const steps = [
    ...legacySteps(plan, trace.api),
    reportStep(api, state.runId, counts, estimatedRows),
  ];
  const completedOperations = await runImport(
    steps,
    state.offset,
    state.runId,
    name,
    api,
    checkpoint,
  );
  return {
    status: "done",
    counts,
    estimatedRows,
    operations: steps.length,
    completedOperations,
    ...finish(),
  };
}

function legacyPreview(plan: LegacyPlan) {
  const counts = plan.days.map((d) => ({
    day: d.day,
    papers: d.papers.length,
    summaries: d.summaries.length,
    skipped: d.skipped,
  }));
  const estimatedRows =
    counts.reduce((n, d) => n + d.papers * 30 + d.summaries * 10 + 1, 0) +
    plan.digests.length +
    plan.radar.length +
    plan.runs.length;
  return { counts, estimatedRows };
}

async function importCursor(
  api: FeedApi,
  name: string,
  local?: ImportCheckpoint["state"],
) {
  const stored = z
    .object({ value: z.string() })
    .nullable()
    .parse(await api.get(`/sync/cursors?name=${encodeURIComponent(name)}`));
  const state = stored
    ? importCheckpointSchema.parse(JSON.parse(stored.value))
    : { offset: 0 };
  const selected =
    local &&
    ((local.version ?? 1) > (state.version ?? 1) ||
      (local.version === state.version && local.offset >= state.offset))
      ? local
      : state;
  return { ...selected, runId: selected.runId ?? `run_${ulid()}` };
}

async function runImport(
  steps: (() => Promise<void>)[],
  offset: number,
  runId: string,
  name: string,
  api: FeedApi,
  checkpoint?: ImportCheckpoint,
) {
  const save = async (next: number) => {
    const state = { offset: next, runId };
    await checkpoint?.save(state);
    await api.write(
      "/ingest/legacy",
      { cursors: [{ name, value: JSON.stringify(state) }] },
      10,
    );
  };
  if (offset < steps.length) await save(offset);
  for (let i = offset; i < steps.length; i++) {
    await steps[i]!();
    await save(i + 1);
  }
  return steps.length;
}

function reportStep(
  api: FeedApi,
  runId: string,
  counts: ReturnType<typeof legacyPreview>["counts"],
  estimatedRows: number,
) {
  return async () => {
    const now = new Date().toISOString();
    await api.write(
      "/ingest/legacy",
      {
        runs: [
          {
            id: runId,
            kind: "legacy_import",
            day: now.slice(0, 10),
            status: "done",
            startedAt: now,
            finishedAt: now,
            stats: { counts, estimatedRows },
          },
        ],
      },
      50,
    );
  };
}

function venueCursor(text: string | undefined) {
  if (!text) return [];
  try {
    const value = z.object({ since: daySchema }).parse(JSON.parse(text));
    return [{ name: "venue-feed", value: JSON.stringify(value) }];
  } catch {
    return [];
  }
}
