import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import {
  newZoteroProgress,
  zoteroBatchSize,
  zoteroFileBytes,
  type ZoteroBatch,
} from "@litscout/pipeline/zotero-contracts";
import { parseCommand, runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";

const fixture = (name: string) =>
  fileURLToPath(
    new URL(
      "../../../packages/pipeline/test/fixtures/zotero/" + name,
      import.meta.url,
    ),
  );
const success = (data: object) => Response.json({ success: true, data });
function harness(respond: (batch: ZoteroBatch) => Response) {
  const print = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(String(input)).toBe(
      "https://instance.example/api/v1/library/import",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture",
    );
    return respond(JSON.parse(String(init?.body)));
  });
  const deps = {
    fetch,
    print,
    cwd: process.cwd(),
    loadConfig: async () =>
      defineConfig({
        instance: {
          publicUrl: "https://instance.example",
          limits: { ingest: { papers: zoteroBatchSize } },
        },
      }),
    flow: { token: "fixture" },
  } as unknown as SetupDeps;
  return { deps, fetch, output: () => JSON.parse(print.mock.lastCall![0]) };
}

it("previews export fixtures and reports invalid records and file duplicates", async () => {
  const calls: ZoteroBatch[] = [];
  const { deps, output } = harness((batch) => {
    calls.push(batch);
    return success({
      ...newZoteroProgress(),
      next: batch.entries.length,
      new: 1,
      linked: 1,
      unverified: 1,
    });
  });
  expect(
    await runCommand(
      ["library", "import", fixture("items.json"), "--dry-run", "--json"],
      deps,
    ),
  ).toBe(0);
  expect(calls[0]).toMatchObject({ format: "csl", total: 2, dryRun: true });
  expect(output().data).toMatchObject({
    status: "dry-run",
    new: 1,
    linked: 1,
    duplicates: 0,
    unverified: 1,
    invalid: 1,
    issues: [{ item: 2 }],
  });
  expect(
    await runCommand(
      [
        "library",
        "import",
        fixture("tricky.bib"),
        "--format",
        "bibtex",
        "--dry-run",
        "--json",
      ],
      deps,
    ),
  ).toBe(0);
  expect(output().data.issues).toMatchObject([{ line: 17 }]);
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-zotero-cli-"));
  try {
    const file = path.join(dir, "duplicate.bib");
    await writeFile(
      file,
      "@article{a,title={Same}} @article{b,title={Same}} @article{c,title={Unique}}",
    );
    expect(
      await runCommand(
        ["library", "import", file, "--dry-run", "--json"],
        deps,
      ),
    ).toBe(0);
    expect(output().data.duplicates).toBe(1);
    expect(calls.at(-1)?.entries).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports budget-short and resumes with the exact file hash", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-zotero-cli-"));
  const file = path.join(dir, "with spaces.bib");
  const calls: ZoteroBatch[] = [];
  let progress = newZoteroProgress();
  let short = true;
  const { deps, output } = harness((batch) => {
    calls.push(batch);
    if (batch.offset < progress.next) return success(progress);
    if (short && batch.offset > 0)
      return Response.json(
        {
          success: false,
          error: {
            code: "WRITE_BUDGET_EXCEEDED",
            retry_after: "2026-11-19T00:00:00.000Z",
          },
        },
        { status: 429 },
      );
    progress = {
      ...progress,
      next: batch.offset + batch.entries.length,
      new: progress.new + batch.entries.length,
      unverified: progress.unverified + batch.entries.length,
    };
    return success(progress);
  });
  try {
    await writeFile(
      file,
      Array.from(
        { length: zoteroBatchSize + 1 },
        (_, i) => "@article{key" + i + ",title={Distinct title " + i + "}}",
      ).join("\n"),
    );
    const args = ["library", "import", file, "--json"];
    expect(await runCommand(args, deps)).toBe(1);
    expect(output().data).toMatchObject({
      status: "budget-short",
      new: zoteroBatchSize,
      remaining: 1,
    });
    short = false;
    expect(await runCommand(args, deps)).toBe(0);
    expect(output().data).toMatchObject({
      status: "imported",
      new: zoteroBatchSize + 1,
      remaining: 0,
    });
    expect(calls.map((batch) => batch.offset)).toEqual([
      0,
      zoteroBatchSize,
      0,
      zoteroBatchSize,
    ]);
    expect(new Set(calls.map((batch) => batch.hash)).size).toBe(1);
    expect(calls[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects oversized files before making any API requests and validates options", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-zotero-cli-"));
  const file = path.join(dir, "inferred.json");
  const { deps, fetch, output } = harness(() => success({}));
  try {
    await writeFile(file, "");
    await truncate(file, zoteroFileBytes + 1);
    expect(await runCommand(["library", "import", file, "--json"], deps)).toBe(
      1,
    );
    expect(output().data.message).toMatch(/5 MB/);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => parseCommand(["library", "import", "a", "b"])).toThrow(
      /<file>/,
    );
    expect(() =>
      parseCommand(["library", "import", "a", "--format", "ris"]),
    ).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
