import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { clientSchema } from "@litscout/core/agent-config";
import {
  cutoverRunEvidenceSchema,
  cutoverWeekdays,
  healthPath,
  healthSchema,
  type CutoverRunEvidence,
} from "@litscout/pipeline/health-contracts";
import { VaultError } from "@litscout/sync/vault-note";
import { UsageError, type CommandResult } from "./command-types";
import { flowOptions } from "./flow-options";
import { credential, localDay, nowFor, type FlowDeps } from "./flow-runtime";
import { endpointConfig } from "./endpoint";
import { doctorCommand } from "./doctor-command";
import { checkBackup } from "./cutover-backup";
import { previewProblems, previewVault } from "./vault-enable";

const deadline = "11:30";
const minimumPickOverlap = 0.2;
const usage =
  "Use cutover check [--reports-dir DIR] [--backup FILE] [--accept-overlap] [--json]";
export const shadowReport = z.strictObject({
  version: z.literal(1),
  reportedAt: z.iso.datetime(),
  oldReadingDay: z.iso.date().nullable(),
  newReadingDay: z.iso.date().nullable(),
  oldDigestAt: z.iso.datetime().nullable(),
  newDigestAt: z.iso.datetime().nullable(),
  picks: z
    .strictObject({
      intersection: z.number().int().nonnegative(),
      union: z.number().int().nonnegative(),
    })
    .refine(({ intersection, union }) => intersection <= union)
    .nullable(),
  client: clientSchema.nullable(),
  budget: z.enum(["ok", "stopped", "unknown"]),
});

/** Where the weekday comparisons live; `shadow report` writes, `cutover check` reads. */
export function shadowReportsDir(
  deps: Pick<FlowDeps, "cwd" | "env">,
  override?: string,
) {
  return override
    ? path.resolve(deps.cwd, override)
    : path.join(
        deps.env?.HOME ?? homedir(),
        ".cache/litscout/run/shadow-reports",
      );
}

export function cutoverOptions(args: readonly string[]) {
  const [command, ...rest] = args;
  if (command !== "check") throw new UsageError(usage);
  const { values, positional } = flowOptions(rest, [
    "reports-dir",
    "backup",
    "accept-overlap",
  ]);
  if (positional.length) throw new UsageError(usage);
  return {
    reportsDir: values["reports-dir"],
    backup: values.backup,
    acceptOverlap: values["accept-overlap"] === "true",
  };
}

function weekdays(today: string, includeToday: boolean) {
  const date = new Date(today + "T00:00:00Z");
  if (!includeToday) date.setUTCDate(date.getUTCDate() - 1);
  const days: string[] = [];
  while (days.length < cutoverWeekdays) {
    if (date.getUTCDay() % 6 !== 0) days.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return days;
}

async function readShadowReport(
  day: string,
  dir: string,
  config: LitScoutConfig,
  deps: FlowDeps,
  now: Date,
) {
  const file = path.join(dir, day + ".json");
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 16_384)
      throw new Error("Invalid shadow report file");
    const report = shadowReport.parse(JSON.parse(await readFile(file, "utf8")));
    const reportedAt = new Date(report.reportedAt);
    if (reportedAt > now || localDay(deps, config, reportedAt) !== day)
      throw new Error("Invalid shadow report timestamp");
    return { file, report };
  } catch (error) {
    return {
      file,
      problem:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "No shadow report."
          : "Invalid shadow report. Check its fields and reporting timestamp.",
    };
  }
}

async function readCutoverRuns(
  deps: FlowDeps,
  config: LitScoutConfig,
  days: readonly string[],
) {
  const { config: resolved } = await endpointConfig(config, deps.dir);
  const base = resolved.instance.publicUrl;
  if (!base) throw new Error("Instance URL missing");
  const url = new URL("/api/v1" + healthPath, base);
  url.searchParams.set("cutoverDays", days.join(","));
  const token = await credential(deps, base);
  const reply = await deps.fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (reply.status === 404) return { hasRuns: false, runs: [] };
  if (!reply.ok) throw new Error("Health request failed");
  const { data } = z
    .object({ success: z.literal(true), data: z.unknown() })
    .parse(await reply.json());
  const evidence = cutoverRunEvidenceSchema.safeParse(data);
  if (evidence.success) return evidence.data;
  // Older Workers ignore cutoverDays. Fall back only if Health confirms no runs.
  if (healthSchema.parse(data).runs.length)
    throw new Error("Health does not support cutover dates");
  return { hasRuns: false, runs: [] };
}

function compareDay(
  day: string,
  shadow: Awaited<ReturnType<typeof readShadowReport>>,
  evidence: CutoverRunEvidence["runs"][number] | undefined,
  useRunRecords: boolean,
  onTime: (
    stamp: string | null,
    until: string | null,
    day: string,
  ) => boolean | null,
) {
  const { report, file, problem } = shadow;
  if (!useRunRecords && !report)
    return { day, file, pickOverlap: null, reasons: [problem] };

  const run = evidence?.run;
  const steps = run?.steps;
  const digestAt = evidence?.digestAt;
  const reportedAt = report?.reportedAt ?? null;
  const oldReadingDay = report?.oldReadingDay ?? null;
  const oldDigestAt = report?.oldDigestAt ?? null;
  const newReadingDay = useRunRecords
    ? (run?.targetDay ?? null)
    : (report?.newReadingDay ?? null);
  const newDigestAt = useRunRecords
    ? steps?.digest.status === "done" &&
      run &&
      digestAt &&
      digestAt >= run.startedAt
      ? digestAt
      : null
    : (report?.newDigestAt ?? null);
  const oldOnTime = onTime(oldDigestAt, reportedAt, day);
  const newOnTime = onTime(
    newDigestAt,
    useRunRecords ? (run?.finishedAt ?? null) : reportedAt,
    day,
  );
  const client = useRunRecords
    ? (steps?.digest.client ?? null)
    : (report?.client ?? null);
  const recordedSteps = Object.values(steps ?? {});
  const budget = useRunRecords
    ? recordedSteps.some((step) => step.error === "budget")
      ? "stopped"
      : !steps ||
          recordedSteps.some((step) => step.status === "paused" && !step.error)
        ? "unknown"
        : "ok"
    : (report?.budget ?? "unknown");
  const sameReadingDay = oldReadingDay === day && newReadingDay === day;
  const picks = report?.picks ?? null;
  const pickOverlap = picks?.union ? picks.intersection / picks.union : null;
  const reasons: string[] = [];
  if (useRunRecords && !run)
    reasons.push("No LitScout run record for this weekday.");
  if (!sameReadingDay)
    reasons.push("Both reading days must match the comparison day.");
  if (oldOnTime !== true || newOnTime !== true)
    reasons.push("Both digests need confirmed completion by 11:30 local time.");
  if (!picks)
    reasons.push(
      "Pick overlap is unknown. " +
        (problem ?? "The shadow report has no pick counts."),
    );
  if (!client) reasons.push("The LitScout client is unknown.");
  if (budget !== "ok")
    reasons.push("The write budget stopped the run or was unconfirmed.");
  return {
    ...report,
    day,
    file,
    reportedAt,
    oldReadingDay,
    newReadingDay,
    oldDigestAt,
    newDigestAt,
    oldOnTime,
    newOnTime,
    client,
    budget,
    picks,
    sameReadingDay,
    pickOverlap,
    reasons,
  };
}

export async function cutoverCheck(
  options: ReturnType<typeof cutoverOptions>,
  deps: FlowDeps,
  config: LitScoutConfig,
  name: string,
  configPath: string,
): Promise<CommandResult> {
  const now = nowFor(deps);
  const today = localDay(deps, config, now);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.instance.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format;
  const reportsDir = shadowReportsDir(deps, options.reportsDir);
  const comparisonDays = weekdays(today, time(now) >= deadline);
  const [evidence, reports, doctor, vault, backup] = await Promise.all([
    readCutoverRuns(deps, config, comparisonDays).catch(() => null),
    Promise.all(
      comparisonDays.map((day) =>
        readShadowReport(day, reportsDir, config, deps, now),
      ),
    ),
    doctorCommand(deps, config, name, configPath, { readOnly: true }).catch(
      () => null,
    ),
    previewVault(deps, config)
      .then((preview) => ({
        summary: preview.summary,
        problems: previewProblems(preview),
      }))
      .catch((error: unknown) => ({
        summary: "Vault preview could not complete.",
        problems: [
          error instanceof VaultError
            ? error.message
            : "Check the vault configuration, scheduler token and Worker availability.",
        ],
      })),
    checkBackup(deps.cwd, config.instance.name, now, options.backup),
  ]);
  const source = !evidence
    ? "unavailable"
    : evidence.hasRuns
      ? "run records"
      : "sidecar reports";
  const onTime = (stamp: string | null, until: string | null, day: string) => {
    if (!stamp || !until) return null;
    const completed = new Date(stamp);
    return (
      completed <= new Date(until) &&
      completed <= now &&
      localDay(deps, config, completed) === day &&
      time(completed) <= deadline
    );
  };
  const runs = !evidence
    ? []
    : comparisonDays.map((day, index) =>
        compareDay(
          day,
          reports[index]!,
          evidence.runs.find((row) => row.day === day),
          evidence.hasRuns,
          onTime,
        ),
      );
  const doctorProblems = doctor
    ? Object.entries(doctor.data.checks)
        .filter(([, status]) => !status.ok)
        .map(
          ([key, status]) =>
            key + ("hint" in status && status.hint ? " · " + status.hint : ""),
        )
    : ["Doctor could not complete."];
  const migrations = doctor?.data.checks.schema;
  const reasons = [
    ...(!evidence
      ? [
          "Could not read weekday run records. Check Health and use the CLI and Worker from the same build.",
        ]
      : []),
    ...runs.flatMap((run) =>
      run.reasons.map((reason) => run.day + " · " + reason),
    ),
    ...doctorProblems.map((problem) => "Doctor · " + problem),
    ...vault.problems.map((problem) => "Vault preview · " + problem),
    ...(!migrations?.ok
      ? [
          "Migrations · Could not confirm the current schema version is applied.",
        ]
      : []),
    ...(backup.reason ? ["Backup · " + backup.reason] : []),
  ];
  const overlapReviewDays = runs
    .filter(
      (run) => run.pickOverlap != null && run.pickOverlap < minimumPickOverlap,
    )
    .map((run) => run.day);
  const reviewRequired = overlapReviewDays.length > 0 && !options.acceptOverlap;
  const decision = reasons.length
    ? "no-go"
    : reviewRequired
      ? "go with review"
      : "go";
  const overlapMessages = overlapReviewDays.length
    ? [
        `Pick overlap below ${minimumPickOverlap} on ${overlapReviewDays.join(", ")}.`,
        options.acceptOverlap
          ? "Low overlap accepted with --accept-overlap."
          : "Review these runs with the owner, then pass --accept-overlap after sign-off.",
      ]
    : [];
  return {
    failed: decision !== "go",
    data: {
      decision,
      source,
      reportsDir,
      runs,
      reasons,
      overlapReviewDays,
      checks: {
        doctor: { ok: doctorProblems.length === 0, problems: doctorProblems },
        vault: { ok: vault.problems.length === 0, ...vault },
        migrations: {
          ok: migrations?.ok === true,
          actual: migrations?.actual ?? null,
          expected: migrations?.expected ?? null,
        },
        backup,
      },
      messages: [
        decision.toUpperCase(),
        source === "run records"
          ? "LitScout evidence from run records. Old digest and pick overlap from sidecar reports in " +
            reportsDir
          : source === "sidecar reports"
            ? "Shadow evidence from sidecar reports in " + reportsDir
            : "Shadow run evidence unavailable.",
        ...runs.map((run) => {
          if (!("reportedAt" in run)) return run.day + " · " + run.reasons[0];
          const picks = run.picks
            ? `${run.picks.intersection}/${run.picks.union} (${run.pickOverlap ?? "n/a"})`
            : "unknown";
          const onTime = (value: boolean | null) =>
            value === null ? "unknown" : value ? "yes" : "no";
          return `${run.day} · reading day old ${run.oldReadingDay ?? "unknown"}, new ${run.newReadingDay ?? "unknown"} · by 11:30 old ${onTime(run.oldOnTime)}, new ${onTime(run.newOnTime)} · picks ${picks} · client ${run.client ?? "unknown"} · budget ${run.budget}`;
        }),
        `Doctor ${doctorProblems.length ? "failed" : "passed"} · ${vault.summary} · schema ${migrations?.actual ?? "unknown"}/${migrations?.expected ?? "unknown"} · backup ${backup.createdAt ?? "unverified"}`,
        ...reasons,
        ...overlapMessages,
      ],
    },
  };
}
