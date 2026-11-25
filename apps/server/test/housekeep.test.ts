import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  ftruncateSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// The server housekeeper (ADR 0004, decision 6): releases, logs, agent
// transcripts and npm's cache stay within their limits, and the run log
// says how big the LitScout user's home is against the 4 GB warning and
// the 5 GB cap. Sizes are apparent file sizes, so sparse files stand in
// for big ones.
const script = path.resolve("apps/server/scripts/housekeep.py");
const MB = 1024 ** 2;
const day = 86_400_000;

function home() {
  const dir = mkdtempSync(path.join(tmpdir(), "litscout-housekeep-"));
  mkdirSync(path.join(dir, "litscout", "logs"), { recursive: true });
  return dir;
}
function file(root: string, rel: string, { bytes = 10, ageDays = 0 } = {}) {
  const target = path.join(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "");
  const fd = openSync(target, "r+");
  ftruncateSync(fd, bytes);
  closeSync(fd);
  const at = new Date(Date.now() - ageDays * day);
  utimesSync(target, at, at);
  return target;
}
function folder(root: string, rel: string, ageDays = 0) {
  const target = path.join(root, rel);
  file(root, path.join(rel, "content"), { ageDays });
  const at = new Date(Date.now() - ageDays * day);
  utimesSync(target, at, at);
  return target;
}
type Result = {
  success: boolean;
  data: {
    dryRun: boolean;
    footprint: number;
    footprintBefore: number;
    freed: number;
    overWarning: boolean;
    overCap: boolean;
    removed: { path: string; bytes: number; reason: string }[];
  };
};
function housekeep(dir: string, ...args: string[]): Result {
  return JSON.parse(
    execFileSync(
      "python3",
      ["-I", script, path.join(dir, "litscout"), "--home", dir, ...args],
      { encoding: "utf8" },
    ),
  ) as Result;
}
const removedPaths = (result: Result) =>
  result.data.removed.map((item) => item.path).sort();

it("keeps the live release and the two newest others", () => {
  const dir = home();
  for (const name of [
    "20261120-0900-aaaaaaa",
    "20261121-0900-bbbbbbb",
    "20261122-0900-ccccccc",
    "20261122-1200-ddddddd",
    "20261122-1500-eeeeeee",
  ])
    folder(dir, `litscout/releases/${name}`);
  // A rollback: the live release is not the newest.
  symlinkSync(
    path.join(dir, "litscout/releases/20261121-0900-bbbbbbb"),
    path.join(dir, "litscout/current"),
  );
  const result = housekeep(dir);
  expect(result.success).toBe(true);
  expect(removedPaths(result)).toEqual([
    "litscout/releases/20261120-0900-aaaaaaa",
    "litscout/releases/20261122-0900-ccccccc",
  ]);
  expect(
    existsSync(path.join(dir, "litscout/releases/20261121-0900-bbbbbbb")),
  ).toBe(true);
  expect(
    existsSync(path.join(dir, "litscout/releases/20261122-1500-eeeeeee")),
  ).toBe(true);
});

it("removes no release when it cannot tell which one is live", () => {
  const dir = home();
  for (const name of ["r1", "r2", "r3", "r4"])
    folder(dir, `litscout/releases/${name}`);
  expect(housekeep(dir).data.removed).toEqual([]);
  symlinkSync(path.join(dir, "elsewhere"), path.join(dir, "litscout/current"));
  expect(housekeep(dir).data.removed).toEqual([]);
});

it("keeps run logs for 30 days and under 200 MB, never the newest", () => {
  const dir = home();
  file(dir, "litscout/logs/run-20261001T014500Z-main.jsonl", { ageDays: 40 });
  file(dir, "litscout/logs/notified-2026-10-01", { ageDays: 40 });
  file(dir, "litscout/logs/run-20261110T014500Z-main.jsonl", {
    bytes: 150 * MB,
    ageDays: 12,
  });
  file(dir, "litscout/logs/run-20261111T014500Z-main.jsonl", {
    bytes: 60 * MB,
    ageDays: 11,
  });
  file(dir, "litscout/logs/notified-2026-11-11", { ageDays: 11 });
  // The run that is writing now; it stays even when alone over the limit.
  file(dir, "litscout/logs/run-20261122T014500Z-main.jsonl", {
    bytes: 250 * MB,
  });
  const result = housekeep(dir);
  expect(removedPaths(result)).toEqual([
    "litscout/logs/notified-2026-10-01",
    "litscout/logs/run-20261001T014500Z-main.jsonl",
    "litscout/logs/run-20261110T014500Z-main.jsonl",
    "litscout/logs/run-20261111T014500Z-main.jsonl",
  ]);
  expect(
    existsSync(path.join(dir, "litscout/logs/run-20261122T014500Z-main.jsonl")),
  ).toBe(true);
  expect(existsSync(path.join(dir, "litscout/logs/notified-2026-11-11"))).toBe(
    true,
  );
});

it("removes agent transcripts after 14 days and leaves the clients' own files", () => {
  const dir = home();
  file(dir, ".gemini/antigravity-cli/conversations/old.db", { ageDays: 20 });
  file(dir, ".gemini/antigravity-cli/conversations/new.db", { ageDays: 2 });
  folder(dir, ".gemini/antigravity-cli/brain/old", 20);
  folder(dir, ".gemini/antigravity-cli/brain/new", 2);
  file(dir, ".gemini/antigravity-cli/conversation_summaries.db", {
    ageDays: 20,
  });
  file(dir, ".codex/sessions/2026/10/01/rollout-1.jsonl", { ageDays: 50 });
  file(dir, ".codex/auth.json", { ageDays: 50 });
  file(dir, ".claude/projects/-tmp/old.jsonl", { ageDays: 30 });
  file(dir, ".claude/projects/-tmp/new.jsonl", { ageDays: 1 });
  file(dir, ".claude/.credentials.json", { ageDays: 50 });
  expect(removedPaths(housekeep(dir))).toEqual([
    ".claude/projects/-tmp/old.jsonl",
    ".codex/sessions/2026/10/01/rollout-1.jsonl",
    ".gemini/antigravity-cli/brain/old",
    ".gemini/antigravity-cli/conversations/old.db",
  ]);
  for (const kept of [
    ".gemini/antigravity-cli/conversations/new.db",
    ".gemini/antigravity-cli/brain/new",
    ".gemini/antigravity-cli/conversation_summaries.db",
    ".codex/auth.json",
    ".claude/.credentials.json",
    ".claude/projects/-tmp/new.jsonl",
  ])
    expect(existsSync(path.join(dir, kept))).toBe(true);
});

it("empties npm's download cache over 200 MB only", () => {
  const small = home();
  file(small, ".npm/_cacache/content-v2/a", { bytes: 100 * MB });
  expect(housekeep(small).data.removed).toEqual([]);
  const big = home();
  file(big, ".npm/_cacache/content-v2/a", { bytes: 201 * MB });
  file(big, ".npm/_logs/debug.log");
  expect(removedPaths(housekeep(big))).toEqual([".npm/_cacache"]);
  expect(existsSync(path.join(big, ".npm/_logs/debug.log"))).toBe(true);
});

it("measures the home against the warning and the cap; a dry run removes nothing", () => {
  const dir = home();
  file(dir, "litscout/state/d1/db.sqlite", { bytes: 4.5 * 1024 * MB });
  file(dir, ".npm/_cacache/content-v2/a", { bytes: 300 * MB });
  const dry = housekeep(dir, "--dry-run");
  expect(dry.data).toMatchObject({
    dryRun: true,
    freed: 300 * MB,
    overWarning: true,
    overCap: false,
  });
  expect(dry.data.footprintBefore - dry.data.footprint).toBe(300 * MB);
  expect(existsSync(path.join(dir, ".npm/_cacache"))).toBe(true);
  file(dir, "litscout/state/d1/more.sqlite", { bytes: 1024 * MB });
  const real = housekeep(dir);
  expect(real.data).toMatchObject({
    dryRun: false,
    overWarning: true,
    overCap: true,
  });
  expect(existsSync(path.join(dir, ".npm/_cacache"))).toBe(false);
});

it("refuses a folder that is not a LitScout folder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "litscout-housekeep-"));
  expect(() =>
    execFileSync("python3", ["-I", script, dir, "--home", dir], {
      encoding: "utf8",
      stdio: "pipe",
    }),
  ).toThrow();
});

it("writes the server's facts for Health: footprint, newest snapshot, newest run per timer", () => {
  const dir = home();
  file(dir, "litscout/backups/litscout-state-20261121-043000.tar.xz", {
    bytes: 6 * MB,
  });
  file(dir, "litscout/backups/litscout-state-20261122-043012.tar.xz", {
    bytes: 7 * MB,
  });
  const run = (name: string, lines: { step: string; exit: number }[]) =>
    writeFileSync(
      path.join(dir, "litscout/logs", name),
      lines
        .map((line) => JSON.stringify({ ...line, started: "", output: "" }))
        .join("\n") + "\n",
    );
  run("run-20261121T014500Z-main.jsonl", [{ step: "fetch", exit: 1 }]);
  run("run-20261122T014500Z-main.jsonl", [
    { step: "fetch", exit: 0 },
    { step: "summaries", exit: 2 },
  ]);
  run("run-20261122T134500Z-final.jsonl", [
    { step: "fetch", exit: 0 },
    { step: "digest", exit: 1 },
  ]);
  const status = path.join(dir, "status.json");
  const result = housekeep(dir, "--dry-run", "--status-file", status);
  const facts = JSON.parse(readFileSync(status, "utf8"));
  expect(facts).toEqual({
    checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    footprintBytes: result.data.footprintBefore,
    warningBytes: 4 * 1024 ** 3,
    capBytes: 5 * 1024 ** 3,
    snapshot: { at: "2026-11-22T04:30:12Z", bytes: 7 * MB },
    runs: [
      { mode: "main", startedAt: "2026-11-22T01:45:00Z", failed: false },
      { mode: "final", startedAt: "2026-11-22T13:45:00Z", failed: true },
    ],
  });
});

it("reports no snapshot and no runs on a fresh server", () => {
  const dir = home();
  const status = path.join(dir, "status.json");
  housekeep(dir, "--dry-run", "--status-file", status);
  expect(JSON.parse(readFileSync(status, "utf8"))).toMatchObject({
    snapshot: null,
    runs: [],
  });
});
