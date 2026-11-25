import { mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { runCommand } from "../src/setup-commands";
it("T5 the CLI dry run reads a fixture Git branch containing three complete real days", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "litscout-real-dry-run-"));
  try {
    const repo = path.join(root, "reference");
    await mkdir(repo);
    await cp(
      "packages/sync/test/fixtures/round3/data",
      path.join(repo, "data"),
      { recursive: true },
    );
    execFileSync("git", ["init", "-b", "data", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=" + ["fixture", "example.invalid"].join("@"),
        "commit",
        "-m",
        "test: record three real data days",
      ],
      { stdio: "ignore" },
    );
    const out: string[] = [],
      fetch = vi.fn(),
      run = vi.fn();
    const result = await runCommand(
      [
        "migrate",
        "legacy",
        "--repo",
        repo,
        "--from",
        "2026-11-10",
        "--to",
        "2026-11-12",
        "--dry-run",
        "--json",
      ],
      {
        cwd: root,
        dir: path.join(root, "state"),
        env: {},
        isTTY: false,
        templateDir: "templates/self-host",
        bundlePath: "unused",
        fetch,
        run,
        fetchVenues: vi.fn(),
        prompt: vi.fn(),
        print: (line) => out.push(line),
      },
    );
    expect(result).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({
      data: {
        status: "dry-run",
        counts: [
          { day: "2026-11-10", papers: 1124, skipped: 0 },
          { day: "2026-11-11", papers: 838, skipped: 0 },
          { day: "2026-11-12", papers: 418, skipped: 0 },
        ],
        estimatedRows: 71403,
        invalid: [],
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(
      execFileSync("git", ["-C", repo, "status", "--porcelain"], {
        encoding: "utf8",
      }),
    ).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
