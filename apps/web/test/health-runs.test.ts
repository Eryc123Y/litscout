import { expect, it } from "vitest";
import { runSummary } from "../src/health-runs";

const done = { status: "done" as const };
const skipped = { status: "skipped" as const };
const base = {
  id: "run_1",
  startedAt: "2026-11-20T13:20:20.000Z",
  targetDay: "2026-11-20",
  finishedAt: "2026-11-20T13:36:00.000Z",
  rowsWritten: 117,
};

it("says in one line how a run went", () => {
  // Everything done.
  expect(
    runSummary({
      ...base,
      steps: {
        fetch: done,
        summaries: done,
        digest: done,
        sync: done,
        legacy: skipped,
      },
    }),
  ).toEqual({ tone: "ok", text: "Fetch, summaries, digest and sync done" });
  // A failure leads, with its reason.
  expect(
    runSummary({
      ...base,
      steps: {
        fetch: done,
        summaries: done,
        digest: { status: "failed", error: "operation-failed" },
        sync: done,
        legacy: skipped,
      },
    }),
  ).toEqual({ tone: "error", text: "Digest failed: operation failed" });
  // A pause is a warning, not a failure.
  expect(
    runSummary({
      ...base,
      steps: {
        fetch: done,
        summaries: skipped,
        digest: skipped,
        sync: done,
        legacy: { status: "paused", error: "budget" },
      },
    }),
  ).toEqual({
    tone: "warn",
    text: "Legacy import paused: write budget reached",
  });
  // No report from the run.
  expect(runSummary({ ...base, finishedAt: null, steps: null })).toEqual({
    tone: "warn",
    text: "No completion report",
  });
  // Nothing ran (all skipped).
  expect(
    runSummary({
      ...base,
      steps: {
        fetch: skipped,
        summaries: skipped,
        digest: skipped,
        sync: skipped,
        legacy: skipped,
      },
    }),
  ).toEqual({ tone: "ok", text: "Nothing to do" });
});
