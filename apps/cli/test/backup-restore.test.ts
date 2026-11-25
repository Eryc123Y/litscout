import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { backupDataSections } from "@litscout/pipeline/backup-contracts";
import { resumePath } from "../src/checkpoint-store";
import { runCommand, type SetupDeps } from "../src/setup-commands";

const day = "2026-11-19T00:00:00.000Z";
const paper = (id: string) => ({
  id,
  title: "Paper " + id,
  abstract: null,
  tldr: "",
  authors: [],
  venue: null,
  venue_kind: null,
  year: null,
  published_on: null,
  primary_category: null,
  categories: [],
  first_seen_on: null,
  source: "manual",
  verified: 1,
  created_at: day,
  updated_at: day,
  rev: 1,
});
const libraryRow = (paper_id: string) => ({
  paper_id,
  status: "saved",
  tags: [],
  added_via: "cli",
  added_at: day,
  updated_at: day,
  rev: 1,
});
const sorted = (row: object) =>
  Object.fromEntries(
    Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
function bundleOf(rows: Record<string, object[]>) {
  const data = Object.fromEntries(
    backupDataSections.map((section) => [section, rows[section] ?? []]),
  );
  const counts = {
    ...Object.fromEntries(
      backupDataSections.map((section) => [section, data[section]!.length]),
    ),
    configuredTopics: 0,
  };
  const sha256 = createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(data).map(([section, list]) => [
            section,
            list.map(sorted),
          ]),
        ),
      ),
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    instanceName: "My research",
    createdAt: day,
    configuredTopics: [],
    expectedCounts: counts,
    counts,
    sha256,
    data,
  };
}
// 30 papers make two paper pages; with the library page, three pages.
const ids = Array.from(
  { length: 30 },
  (_, i) => "pap_" + String(i).padStart(2, "0"),
);
const bundle = bundleOf({
  papers: ids.map(paper),
  library: [libraryRow("pap_00")],
});

let dir: string;
let prints: string[];
let personalRows: number;
let used: number;
let quota: boolean;
let pages: { section: string; items: unknown[] }[];
let requests: ReturnType<typeof vi.fn>;
let deps: SetupDeps;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "litscout-restore-test-"));
  prints = [];
  personalRows = 0;
  used = 0;
  quota = false;
  pages = [];
  requests = vi.fn(async (url: URL, init?: RequestInit) => {
    if (url.pathname === "/api/v1/budget")
      return Response.json({
        success: true,
        data: { day: "2026-11-19", used, reserved: 0, limit: 80000 },
      });
    if (url.pathname !== "/api/v1/backup/restore")
      return Response.json({ success: false }, { status: 404 });
    if (init?.method !== "POST")
      return Response.json({
        success: true,
        data: {
          personalRows,
          counts: Object.fromEntries(
            backupDataSections.map((section) => [
              section,
              section === "library" ? personalRows : 0,
            ]),
          ),
        },
      });
    if (quota)
      return Response.json(
        {
          success: false,
          error: { code: "WRITE_BUDGET_EXCEEDED", message: "Budget" },
        },
        { status: 429 },
      );
    const page = JSON.parse(String(init.body));
    pages.push(page);
    return Response.json({
      success: true,
      data: { inserted: page.items.length, skipped: 0 },
      meta: { rowsWritten: 9 * page.items.length },
    });
  });
  deps = {
    cwd: dir,
    dir,
    flow: {
      token: "lsk_" + "W".repeat(52),
      now: () => new Date(day),
    },
    fetch: requests,
    loadConfig: async () =>
      defineConfig({ instance: { publicUrl: "https://local.invalid" } }),
    print: (line: string) => prints.push(line),
  } as unknown as SetupDeps;
  await writeFile(
    path.join(dir, "export.json.gz"),
    gzipSync(JSON.stringify(bundle)),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (...args: string[]) =>
  runCommand(["backup", "restore", "export.json.gz", ...args, "--json"], deps);
const last = () => JSON.parse(prints.at(-1)!).data;

it("plans a restore without writing, and refuses an instance that holds data", async () => {
  expect(await run("--dry-run")).toBe(0);
  expect(last()).toMatchObject({
    dryRun: true,
    instanceName: "My research",
    rows: { papers: 30, library: 1, topics: 0 },
    pages: 3,
    maxRowsWritten: expect.any(Number),
    balance: 80000,
    fitsToday: true,
  });
  expect(pages).toEqual([]);

  personalRows = 3;
  expect(await run("--dry-run")).toBe(1);
  expect(last().message).toMatch(/already has 3 personal rows.*library 3/i);
  expect(await run()).toBe(1);
  expect(pages).toEqual([]);
});

it("pauses at the row limit, saves its place, and resumes where it stopped", async () => {
  expect(await run("--max-rows", "250")).toBe(0);
  expect(last()).toMatchObject({
    status: "paused",
    reason: "budget",
    next: 1,
    pages: 3,
    inserted: 25,
  });
  expect(pages.map((page) => page.section)).toEqual(["papers"]);

  // The instance is no longer empty, but the saved place belongs to this export.
  personalRows = 1;
  quota = true;
  expect(await run()).toBe(0);
  expect(last()).toMatchObject({ status: "paused", next: 1 });

  quota = false;
  expect(await run()).toBe(0);
  expect(last()).toMatchObject({
    status: "done",
    next: 3,
    inserted: 31,
    skipped: 0,
    rowsWritten: 279,
  });
  expect(pages.map((page) => page.section)).toEqual([
    "papers",
    "papers",
    "library",
  ]);
  const resume = path.join(dir, "resume");
  const [folder] = await readdir(resume);
  expect(await readdir(path.join(resume, folder!))).toEqual([]);

  // With the checkpoint gone, a rerun checks the instance again.
  expect(await run()).toBe(1);
  expect(last().message).toMatch(/already has 1 personal row/i);
});

it("trusts a saved place only for this export, its pages and an instance that kept its rows", async () => {
  const folder = resumePath(dir, "https://local.invalid");
  await mkdir(folder, { recursive: true });
  const save = (value: object) =>
    writeFile(
      path.join(folder, `restore-${bundle.sha256.slice(0, 32)}.json`),
      JSON.stringify({
        sha256: bundle.sha256,
        next: 3,
        pages: 3,
        inserted: 31,
        skipped: 0,
        rowsWritten: 279,
        ...value,
      }),
    );

  // Saved under another page split: not this restore's place.
  await save({ pages: 4, next: 2 });
  personalRows = 3;
  expect(await run()).toBe(1);
  expect(last().message).toMatch(/already has 3 personal rows/i);

  // Past the personal pages, yet the instance holds none: it was reset.
  await save({ next: 3 });
  personalRows = 0;
  expect(await run()).toBe(0);
  expect(last()).toMatchObject({
    status: "done",
    restarted: true,
    next: 3,
    inserted: 31,
    rowsWritten: 279,
  });
  expect(pages.map((page) => page.section)).toEqual([
    "papers",
    "papers",
    "library",
  ]);
});

it("keeps rows for the rest of the day with --keep-rows", async () => {
  used = 79_700;
  expect(await run("--keep-rows", "100")).toBe(0);
  expect(last()).toMatchObject({ status: "paused", next: 0, inserted: 0 });
  expect(pages).toEqual([]);
});

it("refuses a tampered export before contacting the instance", async () => {
  await writeFile(
    path.join(dir, "export.json.gz"),
    gzipSync(JSON.stringify({ ...bundle, sha256: "0".repeat(64) })),
  );
  expect(await run("--dry-run")).toBe(1);
  expect(last().message).toMatch(/SHA-256/);
  expect(requests).not.toHaveBeenCalled();
  for (const args of [
    ["--max-rows", "5", "--keep-rows", "5"],
    ["--dry-run", "--max-rows", "5"],
  ]) {
    expect(await run(...args)).toBe(1);
    expect(last().message).toMatch(/--max-rows|--keep-rows/);
  }
  expect(await runCommand(["backup", "restore", "--json"], deps)).toBe(1);
  expect(last().message).toMatch(/backup restore FILE/);
});
