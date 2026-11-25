import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import {
  shadowReportCommand,
  shadowReportOptions,
} from "../src/shadow-command";
import { shadowReport } from "../src/cutover-command";
import type { FlowDeps } from "../src/flow-runtime";
import { UsageError } from "../src/command-types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs.length = 0;
});
const feedPaper = (
  paperId: string,
  identifiers: { scheme: string; value: string }[],
) => ({
  paperId,
  title: "T",
  abstract: "A",
  source: "arxiv",
  authors: [],
  topics: [],
  shortlisted: true,
  summaries: [],
  identifiers,
  links: [],
});

it("writes the weekday comparison cutover check reads, from both digests", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-shadow-"));
  dirs.push(dir);
  const oldDigest = path.join(dir, "2026-11-18.md");
  await writeFile(
    oldDigest,
    [
      "**1106 篇新论文**（arXiv 2026-11-17 批次）",
      "- [A](https://x/#day=2026-11-17&topic=T&paper=2611.20001)",
      "- [B](https://x/#day=2026-11-17&topic=T&paper=2611.20002)",
    ].join("\n"),
  );
  const api = {
    get: vi.fn(async (route: string): Promise<unknown> => {
      if (route === "/budget")
        return {
          day: "2026-11-19",
          used: 61_000,
          reserved: 0,
          limit: 80_000,
          resetAt: "2026-11-20T00:00:00.000Z",
          staleLeasesReleased: 0,
        };
      if (route === "/digests/2026-11-17?lang=en")
        return {
          day: "2026-11-17",
          picks: ["pap_a", "pap_c"],
          createdAt: "2026-11-19T02:30:00.000Z",
        };
      if (route.startsWith("/feed/days/2026-11-17/full"))
        return {
          day: "2026-11-17",
          status: "final",
          counts: {},
          items: [
            feedPaper("pap_a", [{ scheme: "arxiv", value: "2611.20001" }]),
            feedPaper("pap_c", [{ scheme: "doi", value: "10.1/c" }]),
          ],
        };
      return null;
    }),
    write: vi.fn(),
  };
  const deps = {
    cwd: dir,
    dir,
    env: { HOME: dir },
    flow: { now: () => new Date("2026-11-19T03:40:00.000Z") },
  } as unknown as FlowDeps;
  const config = defineConfig({
    instance: { publicUrl: "https://local", timezone: "Asia/Shanghai" },
  });
  const options = shadowReportOptions([
    "report",
    "--old-digest",
    oldDigest,
    "--old-completed-at",
    "2026-11-19T02:39:00.000Z",
    "--new-day",
    "2026-11-17",
    "--client",
    "claude",
  ]);
  const result = await shadowReportCommand(options, api, deps, config);
  const file = path.join(
    dir,
    ".cache/litscout/run/shadow-reports/2026-11-19.json",
  );
  expect(result.data).toMatchObject({
    file,
    picks: { intersection: 1, union: 3 },
  });
  const report = shadowReport.parse(JSON.parse(await readFile(file, "utf8")));
  expect(report).toEqual({
    version: 1,
    reportedAt: "2026-11-19T03:40:00.000Z",
    oldReadingDay: "2026-11-17",
    newReadingDay: "2026-11-17",
    oldDigestAt: "2026-11-19T02:39:00.000Z",
    newDigestAt: "2026-11-19T02:30:00.000Z",
    picks: { intersection: 1, union: 3 },
    client: "claude",
    budget: "ok",
  });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  // A later run with no new evidence keeps the completed comparison.
  api.get.mockImplementation(async (route: string) =>
    route === "/budget" ? Promise.reject(new Error("offline")) : null,
  );
  await shadowReportCommand(options, api, deps, config);
  expect(
    shadowReport.parse(JSON.parse(await readFile(file, "utf8"))),
  ).toMatchObject({
    newDigestAt: "2026-11-19T02:30:00.000Z",
    picks: { intersection: 1, union: 3 },
    budget: "ok",
  });
  // With no earlier report, missing evidence is unknown, not zero.
  const fresh = { ...deps, env: { HOME: path.join(dir, "fresh") } } as FlowDeps;
  await shadowReportCommand(options, api, fresh, config);
  expect(
    shadowReport.parse(
      JSON.parse(
        await readFile(
          path.join(
            dir,
            "fresh/.cache/litscout/run/shadow-reports/2026-11-19.json",
          ),
          "utf8",
        ),
      ),
    ),
  ).toMatchObject({ newDigestAt: null, picks: null, budget: "unknown" });
});

it("needs the old digest file", () => {
  expect(() => shadowReportOptions(["report"])).toThrow(/--old-digest/);
});

it("keeps an earlier comparison only whole and only for the same old digest, and warns about picks outside the feed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-shadow-"));
  dirs.push(dir);
  const shared = path.join(dir, "shared");
  await mkdir(shared, { mode: 0o755 });
  const write = (name: string, day: string, id: string) =>
    writeFile(
      path.join(dir, name),
      `**N 篇新论文**（arXiv ${day} 批次）\n- [A](https://x/#day=${day}&paper=${id})`,
    );
  await write("a.md", "2026-11-17", "2611.20001");
  await write("b.md", "2026-11-18", "2611.30001");
  let digestUp = true;
  const api = {
    get: vi.fn(async (route: string): Promise<unknown> => {
      if (route === "/budget")
        return {
          day: "2026-11-19",
          used: 1,
          reserved: 0,
          limit: 80_000,
          resetAt: "2026-11-20T00:00:00.000Z",
          staleLeasesReleased: 0,
        };
      if (route.startsWith("/digests/") && digestUp)
        return {
          day: "2026-11-17",
          picks: ["pap_a", "pap_gone"],
          createdAt: "2026-11-19T02:30:00.000Z",
        };
      if (route.startsWith("/feed/days/2026-11-17/full"))
        return {
          day: "2026-11-17",
          status: "final",
          counts: {},
          items: [
            feedPaper("pap_a", [{ scheme: "arxiv", value: "2611.20001" }]),
          ],
        };
      return null;
    }),
    write: vi.fn(),
  };
  const deps = {
    cwd: dir,
    dir,
    env: { HOME: dir },
    flow: { now: () => new Date("2026-11-19T03:40:00.000Z") },
  } as unknown as FlowDeps;
  const config = defineConfig({
    instance: { publicUrl: "https://local", timezone: "Asia/Shanghai" },
  });
  const run = (file: string, extra: string[] = []) =>
    shadowReportCommand(
      shadowReportOptions([
        "report",
        "--old-digest",
        path.join(dir, file),
        "--new-day",
        "2026-11-17",
        "--reports-dir",
        shared,
        ...extra,
      ]),
      api,
      deps,
      config,
    );
  const first = await run("a.md", [
    "--old-completed-at",
    "2026-11-19T02:39:00.000Z",
  ]);
  expect(first.data).toMatchObject({
    picks: { intersection: 1, union: 2 },
    warnings: [
      "1 LitScout pick is not in the day's feed; it counts as unmatched",
    ],
  });
  // An existing folder keeps its mode; only a folder the command made is 700.
  expect((await stat(shared)).mode & 0o777).toBe(0o755);
  const report = () =>
    readFile(path.join(shared, "2026-11-19.json"), "utf8").then((t) =>
      shadowReport.parse(JSON.parse(t)),
    );
  // Same old digest, digest unreadable now: the whole earlier comparison stays,
  // including the completion time given on the first run.
  digestUp = false;
  await run("a.md");
  expect(await report()).toMatchObject({
    oldDigestAt: "2026-11-19T02:39:00.000Z",
    newReadingDay: "2026-11-17",
    picks: { intersection: 1, union: 2 },
  });
  // A different old digest is a different comparison: nothing is carried over.
  await run("b.md");
  expect(await report()).toMatchObject({
    oldReadingDay: "2026-11-18",
    newReadingDay: null,
    newDigestAt: null,
    picks: null,
  });
});

it("finds the old digest by reading day in a folder on a catch-up day, and skips a pair it already has", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-shadow-dir-"));
  dirs.push(dir);
  const digests = path.join(dir, "digests");
  await mkdir(digests);
  const oldDigest = (day: string, paper: string) =>
    [
      `# LitScout 日报 · ${day}`,
      `- [A](https://x/#day=${day}&topic=T&paper=${paper})`,
    ].join("\n");
  // Old files are named by the old run's date; the header says the reading day.
  await writeFile(
    path.join(digests, "2026-11-18.md"),
    oldDigest("2026-11-17", "2611.10001"),
  );
  await writeFile(
    path.join(digests, "2026-11-19.md"),
    oldDigest("2026-11-19", "2611.20001"),
  );
  await writeFile(path.join(digests, "notes.md"), "not a digest");
  const api = {
    get: vi.fn(async (route: string): Promise<unknown> => {
      if (route === "/budget") return null;
      if (route === "/digests/2026-11-19?lang=en")
        return {
          day: "2026-11-19",
          picks: ["pap_a"],
          createdAt: "2026-11-20T02:41:00.000Z",
        };
      if (route.startsWith("/feed/days/2026-11-19/full"))
        return {
          day: "2026-11-19",
          status: "digested",
          counts: {},
          items: [
            feedPaper("pap_a", [{ scheme: "arxiv", value: "2611.20001" }]),
          ],
        };
      return null;
    }),
    write: vi.fn(),
  };
  const at = (iso: string) =>
    ({
      cwd: dir,
      dir,
      env: { HOME: dir },
      flow: { now: () => new Date(iso) },
    }) as unknown as FlowDeps;
  const config = defineConfig({
    instance: { publicUrl: "https://local", timezone: "Asia/Shanghai" },
  });
  const options = shadowReportOptions([
    "report",
    "--old-digests",
    digests,
    "--new-day",
    "2026-11-19",
  ]);
  const reports = path.join(dir, ".cache/litscout/run/shadow-reports");
  // 2026-11-20: no 2026-11-20.md (the old pipeline had no new batch), so the
  // file whose reading day is LitScout's 11-19 is compared.
  const first = await shadowReportCommand(
    options,
    api,
    at("2026-11-20T04:00:00.000Z"),
    config,
  );
  expect(first.data).toMatchObject({
    file: path.join(reports, "2026-11-20.json"),
    oldReadingDay: "2026-11-19",
    newReadingDay: "2026-11-19",
    picks: { intersection: 1, union: 1 },
  });
  // 2026-11-21 with still nothing new: the pair is already saved, so the
  // run skips instead of writing a second copy.
  const second = await shadowReportCommand(
    options,
    api,
    at("2026-11-21T04:00:00.000Z"),
    config,
  );
  expect(second.data).toEqual({
    status: "skipped",
    reason: "already-compared",
    newDay: "2026-11-19",
  });
  await expect(stat(path.join(reports, "2026-11-21.json"))).rejects.toThrow();
  // Today's file wins when it exists, even for another reading day.
  await writeFile(
    path.join(digests, "2026-11-21.md"),
    oldDigest("2026-11-20", "2611.30001"),
  );
  const third = await shadowReportCommand(
    options,
    api,
    at("2026-11-21T04:00:00.000Z"),
    config,
  );
  expect(third.data).toMatchObject({
    oldReadingDay: "2026-11-20",
    newReadingDay: "2026-11-19",
  });
  // No old digest for LitScout's day: skip and write nothing.
  const none = shadowReportOptions([
    "report",
    "--old-digests",
    digests,
    "--new-day",
    "2026-11-16",
  ]);
  const fourth = await shadowReportCommand(
    none,
    api,
    at("2026-11-22T04:00:00.000Z"),
    config,
  );
  expect(fourth.data).toEqual({
    status: "skipped",
    reason: "no-old-digest",
    newDay: "2026-11-16",
  });
  // Exactly one of the two flags.
  expect(() => shadowReportOptions(["report"])).toThrow(UsageError);
  expect(() =>
    shadowReportOptions([
      "report",
      "--old-digest",
      "a.md",
      "--old-digests",
      digests,
    ]),
  ).toThrow(UsageError);
});
