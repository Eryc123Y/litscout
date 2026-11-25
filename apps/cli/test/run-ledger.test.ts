import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { dailyRunFinishSchema } from "@litscout/pipeline/health-contracts";
import {
  buildRunReport,
  combineOutcomes,
  recordStep,
  startRun,
  stepFor,
  stepOutcome,
} from "../src/run-ledger";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs.length = 0;
});
async function stateDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-run-ledger-"));
  dirs.push(dir);
  return dir;
}
const start = {
  id: "43d91359-fbdc-4047-a843-30e90031a4df",
  startedAt: "2026-11-19T02:20:00.000Z",
  targetDay: "2026-11-19",
};
const at = (iso: string) => () => new Date(iso);

it("names the report step for each daily command, and none for other commands", () => {
  expect(stepFor(["daily", "fetch"])).toBe("fetch");
  expect(stepFor(["summaries", "run", "--client", "codex"])).toBe("summaries");
  expect(stepFor(["digest", "run"])).toBe("digest");
  // The runbook's manual path: a draft written by hand and uploaded.
  expect(stepFor(["digest", "put", "digest.json"])).toBe("digest");
  expect(
    stepFor(["summaries", "put", "summaries.json", "--day", "2026-11-19"]),
  ).toBe("summaries");
  expect(stepFor(["legacy", "import", "--keep-rows", "2000"])).toBe("legacy");
  expect(stepFor(["migrate", "legacy", "--repo", "."])).toBe("legacy");
  expect(stepFor(["sync", "--dry-run"])).toBe("sync");
  expect(stepFor(["daily", "status"])).toBeNull();
  expect(stepFor(["daily", "start"])).toBe("start");
  expect(stepFor(["budget"])).toBeNull();
  // Previews of the import steps are not work done in the run.
  expect(stepFor(["legacy", "import", "--dry-run"])).toBeNull();
  expect(stepFor(["digest", "run", "--dry-run"])).toBeNull();
  // A preview after a real run must not overwrite its outcome.
  expect(stepFor(["summaries", "run", "--dry-run"])).toBeNull();
});

it("maps each command result to the report's step status, error, client and fallback", () => {
  const ok = (data: object) => ({ data });
  expect(stepOutcome("fetch", ok({ status: "crawled" }))).toEqual({
    status: "done",
  });
  // `pending` is the day's state (its listing is still due), not the step's:
  // the fetch did its work (2026-11-19 run, 15,316 rows). The digest step
  // shows whether the day is ready.
  expect(stepOutcome("fetch", ok({ status: "pending" }))).toEqual({
    status: "done",
  });
  expect(stepOutcome("fetch", ok({ status: "exists" }))).toEqual({
    status: "done",
  });
  expect(stepOutcome("fetch", ok({ status: "budget-short" }))).toEqual({
    status: "paused",
    error: "budget",
  });
  expect(stepOutcome("fetch", ok({ status: "budget-stop" }))).toEqual({
    status: "paused",
    error: "budget",
  });
  expect(
    stepOutcome("fetch", { failed: true, data: { status: "invalid-records" } }),
  ).toEqual({ status: "failed", error: "invalid-output" });
  expect(
    stepOutcome(
      "summaries",
      ok({
        status: "done",
        clientsUsed: ["claude", "codex"],
        fallback: [{ from: "claude", to: "codex", reason: "not logged in" }],
      }),
    ),
  ).toEqual({ status: "done", client: "codex", fallback: true });
  expect(stepOutcome("summaries", ok({ status: "no-new-batch" }))).toEqual({
    status: "skipped",
  });
  expect(
    stepOutcome(
      "digest",
      ok({ status: "written", clientsUsed: ["claude"], fallback: [] }),
    ),
  ).toEqual({ status: "done", client: "claude" });
  // An existing digest was not written by this run (cutover evidence).
  expect(stepOutcome("digest", ok({ status: "exists" }))).toEqual({
    status: "skipped",
  });
  expect(stepOutcome("digest", ok({ status: "summaries-pending" }))).toEqual({
    status: "pending",
  });
  expect(stepOutcome("legacy", ok({ status: "max-rows" }))).toEqual({
    status: "paused",
    error: "budget",
  });
  expect(
    stepOutcome("legacy", { failed: true, data: { status: "budget-unread" } }),
  ).toEqual({ status: "failed", error: "operation-failed" });
  expect(stepOutcome("sync", ok({ index: "uploaded" }))).toEqual({
    status: "done",
  });
  expect(stepOutcome("sync", { failed: true, data: {} })).toEqual({
    status: "failed",
    error: "operation-failed",
  });
  // An unknown client name is left out rather than failing the report.
  expect(
    stepOutcome("summaries", ok({ status: "done", clientsUsed: ["mystery"] })),
  ).toEqual({ status: "done" });
});

it("keeps the latest outcome that did something when a step runs more than once", () => {
  // Nothing new on a later run does not undo earlier work.
  expect(combineOutcomes([{ status: "done" }, { status: "skipped" }])).toEqual({
    status: "done",
  });
  expect(
    combineOutcomes([
      { status: "done", client: "codex" },
      { status: "failed", error: "operation-failed" },
    ]),
  ).toEqual({ status: "failed", error: "operation-failed" });
  // A retry that finished the work replaces the earlier partial or failed run
  // (seen on 2026-11-19: summaries returned partial, then could be rerun).
  expect(
    combineOutcomes([
      { status: "pending" },
      { status: "done", client: "claude" },
    ]),
  ).toEqual({ status: "done", client: "claude" });
  expect(
    combineOutcomes([
      { status: "failed", error: "operation-failed" },
      { status: "done" },
      { status: "skipped" },
    ]),
  ).toEqual({ status: "done" });
  expect(combineOutcomes([])).toEqual({ status: "skipped" });
});

it("maps the summaries statuses seen in a real run", () => {
  // 2026-11-19: some chunks failed or were left over; the next run picks them up.
  expect(
    stepOutcome("summaries", {
      data: { status: "partial", clientsUsed: ["claude"], fallback: [] },
    }),
  ).toEqual({ status: "pending", client: "claude" });
  // The client's usage gate stopped the run.
  expect(stepOutcome("summaries", { data: { status: "paused" } })).toEqual({
    status: "paused",
    error: "client-unavailable",
  });
});

it("says why summaries are still pending", () => {
  const partial = (failures: string[]) =>
    stepOutcome("summaries", {
      data: {
        status: "partial",
        clientsUsed: ["claude"],
        fallback: [],
        failures,
      },
    });
  // 2026-11-19 10:20: five chunks came back incomplete after a retry.
  expect(
    partial([
      "chunk 0: 21 of 40 complete after a retry",
      "chunk 4: 8 of 40 complete after a retry",
    ]),
  ).toEqual({ status: "pending", client: "claude", error: "invalid-output" });
  expect(partial(["chunk 2: invalid summary JSON after a retry"])).toEqual({
    status: "pending",
    client: "claude",
    error: "invalid-output",
  });
  expect(partial(["chunk 3: quarantined output"])).toMatchObject({
    error: "invalid-output",
  });
  // A client that timed out or exited is the likelier cause to look at first.
  for (const failure of [
    "chunk 1: agent timed out",
    "chunk 1: client exited 1",
  ])
    expect(
      partial(["chunk 0: 39 of 40 complete after a retry", failure]),
    ).toMatchObject({ error: "client-unavailable" });
  // Without failures (papers not uploaded for another reason), no reason.
  expect(partial([])).toEqual({ status: "pending", client: "claude" });
  // Other steps keep their mapping.
  expect(
    stepOutcome("digest", {
      data: { status: "pending", failures: ["chunk 0: agent timed out"] },
    }),
  ).toEqual({ status: "pending" });
});

it("builds a valid report from the steps recorded since daily start", async () => {
  const dir = await stateDir();
  const deps = { dir, flow: { now: at("2026-11-19T02:20:00.000Z") } };
  await startRun(deps, "https://local", start);
  const later = { dir, flow: { now: at("2026-11-19T02:35:00.000Z") } };
  // daily start's own rows count towards the total, as the runbook asks.
  await recordStep(deps, "https://local", ["daily", "start"], {
    data: { ...start, ingest: { rowsWritten: 3 } },
  });
  await recordStep(later, "https://local", ["daily", "fetch"], {
    data: { status: "crawled", ingest: { rowsWritten: 30_000 } },
  });
  await recordStep(later, "https://local", ["summaries", "run"], {
    data: {
      status: "done",
      clientsUsed: ["codex"],
      fallback: [],
      ingest: { rowsWritten: 4_000 },
    },
  });
  await recordStep(later, "https://local", ["sync", "--dry-run"], {
    data: { index: "planned", rowsWritten: 0 },
  });
  // A command outside the report's steps records nothing.
  await recordStep(later, "https://local", ["budget"], { data: {} });

  const report = await buildRunReport(later, "https://local");
  expect(dailyRunFinishSchema.parse(report)).toEqual(report);
  expect(report).toMatchObject({
    ...start,
    finishedAt: "2026-11-19T02:35:00.000Z",
    rowsWritten: 34_003,
    steps: {
      fetch: { status: "done" },
      summaries: { status: "done", client: "codex" },
      digest: { status: "skipped" },
      sync: { status: "done" },
      legacy: { status: "skipped" },
    },
  });
});

it("reports rows as unknown when a recorded step has no confirmed count", async () => {
  const dir = await stateDir();
  const deps = { dir, flow: { now: at("2026-11-19T02:20:00.000Z") } };
  await startRun(deps, "https://local", start);
  await recordStep(deps, "https://local", ["daily", "fetch"], {
    data: { status: "crawled", ingest: { rowsWritten: 10 } },
  });
  await recordStep(deps, "https://local", ["digest", "run"], {
    data: { status: "written" },
  });
  expect(await buildRunReport(deps, "https://local")).toMatchObject({
    rowsWritten: null,
  });
});

it("records nothing without a run, after six hours, or for another instance", async () => {
  const dir = await stateDir();
  const deps = { dir, flow: { now: at("2026-11-19T02:20:00.000Z") } };
  await recordStep(deps, "https://local", ["daily", "fetch"], {
    data: { status: "crawled" },
  });
  await expect(buildRunReport(deps, "https://local")).rejects.toThrow(
    /daily start/,
  );
  await startRun(deps, "https://local", start);
  const stale = { dir, flow: { now: at("2026-11-19T08:21:00.000Z") } };
  await recordStep(stale, "https://local", ["daily", "fetch"], {
    data: { status: "crawled", ingest: { rowsWritten: 5 } },
  });
  await recordStep(deps, "https://other", ["daily", "fetch"], {
    data: { status: "crawled", ingest: { rowsWritten: 5 } },
  });
  expect(await buildRunReport(deps, "https://local")).toMatchObject({
    steps: { fetch: { status: "skipped" } },
    rowsWritten: 0,
  });
  // Ledger files stay private to the user.
  const files = await readdir(path.join(dir, "resume"), { recursive: true });
  expect(files.some((f) => String(f).endsWith("run-current.json"))).toBe(true);
});

it("ignores a damaged ledger line instead of failing the report", async () => {
  const dir = await stateDir();
  const deps = { dir, flow: { now: at("2026-11-19T02:20:00.000Z") } };
  const folder = await startRun(deps, "https://local", start);
  await recordStep(deps, "https://local", ["daily", "fetch"], {
    data: { status: "crawled", ingest: { rowsWritten: 7 } },
  });
  await writeFile(path.join(folder, `run-${start.id}.jsonl`), "{not json\n", {
    flag: "a",
  });
  expect(await buildRunReport(deps, "https://local")).toMatchObject({
    steps: { fetch: { status: "done" } },
    rowsWritten: 7,
  });
});

it("reports the reading day the digest or summaries actually used", async () => {
  const dir = await stateDir();
  const deps = { dir, flow: { now: at("2026-11-19T02:20:00.000Z") } };
  await startRun(deps, "https://local", start);
  await recordStep(deps, "https://local", ["summaries", "run"], {
    data: { status: "done", day: "2026-11-18", ingest: { rowsWritten: 1 } },
  });
  expect(await buildRunReport(deps, "https://local")).toMatchObject({
    targetDay: "2026-11-18",
  });
  await recordStep(deps, "https://local", ["digest", "run"], {
    data: { status: "written", day: "2026-11-17", ingest: { rowsWritten: 1 } },
  });
  expect(await buildRunReport(deps, "https://local")).toMatchObject({
    targetDay: "2026-11-17",
  });
});

it("refuses to report a run older than six hours, and a failed start leaves the run alone", async () => {
  const dir = await stateDir();
  const deps = { dir, flow: { now: at("2026-11-19T02:20:00.000Z") } };
  await startRun(deps, "https://local", start);
  await recordStep(deps, "https://local", ["daily", "fetch"], {
    data: { status: "crawled", ingest: { rowsWritten: 9 } },
  });
  // A failed daily start (the server refused it) adds nothing to the open run.
  await recordStep(deps, "https://local", ["daily", "start"], {
    failed: true,
    data: {},
  });
  expect(await buildRunReport(deps, "https://local")).toMatchObject({
    rowsWritten: 9,
  });
  // A crashed run's pointer must not become tomorrow's report.
  const nextDay = { dir, flow: { now: at("2026-11-20T02:20:00.000Z") } };
  await expect(buildRunReport(nextDay, "https://local")).rejects.toThrow(
    /more than six hours ago.*daily start/,
  );
});

it("counts a hand-uploaded digest after the automatic one failed", () => {
  // 20 Nov on staging: every client failed to start, the run recovered with
  // `digest put`, and Health still said the digest failed.
  const failedRun = stepOutcome("digest", { failed: true });
  const rejectedPut = stepOutcome("digest", { failed: true });
  const acceptedPut = stepOutcome("digest", {
    data: { status: "written", day: "2026-11-20" },
  });
  expect(combineOutcomes([failedRun, rejectedPut, acceptedPut])).toEqual({
    status: "done",
  });
  // A put that finds the digest already there changes nothing.
  expect(
    combineOutcomes([
      stepOutcome("digest", { data: { status: "written" } }),
      stepOutcome("digest", { data: { status: "exists" } }),
    ]),
  ).toEqual({ status: "done" });
});
