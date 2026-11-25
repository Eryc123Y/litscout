import type { z } from "zod";
import type { dailyRunViewSchema } from "@litscout/pipeline/health-contracts";

type Run = z.output<typeof dailyRunViewSchema>;
type Step = NonNullable<Run["steps"]>[keyof NonNullable<Run["steps"]>];

/** The steps in run order, with the names a run summary uses. */
export const runSteps = {
  fetch: "Fetch",
  summaries: "Summaries",
  digest: "Digest",
  sync: "Sync",
  legacy: "Legacy import",
} as const;

const reasons: Record<NonNullable<Step["error"]>, string> = {
  budget: "write budget reached",
  "client-unavailable": "client unavailable",
  "source-unavailable": "source unavailable",
  "invalid-output": "invalid output",
  "operation-failed": "operation failed",
};

const list = (items: string[]) =>
  items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** How a run went, in one line: a failure first, then a pause, else what
 * it did. The step-by-step detail stays one click away. */
export function runSummary(run: Run): {
  tone: "ok" | "warn" | "error";
  text: string;
} {
  if (!run.steps) return { tone: "warn", text: "No completion report" };
  const steps = (Object.keys(runSteps) as (keyof typeof runSteps)[]).map(
    (name) => ({ name: runSteps[name], step: run.steps![name] }),
  );
  const why = (step: Step) => (step.error ? `: ${reasons[step.error]}` : "");
  const failed = steps.find(({ step }) => step.status === "failed");
  if (failed)
    return { tone: "error", text: `${failed.name} failed${why(failed.step)}` };
  const paused = steps.find(({ step }) => step.status === "paused");
  if (paused)
    return { tone: "warn", text: `${paused.name} paused${why(paused.step)}` };
  if (!run.finishedAt) return { tone: "warn", text: "No completion report" };
  const done = steps
    .filter(({ step }) => step.status === "done")
    .map(({ name }, index) => (index ? name.toLowerCase() : name));
  return {
    tone: "ok",
    text: done.length ? `${list(done)} done` : "Nothing to do",
  };
}
