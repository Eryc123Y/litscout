import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain ES module without types
import { changedFiles, isChecker, needsCode } from "../ci-scope.mjs";

const tests = [
  'const guide = await readFile("docs/self-host.md", "utf8");',
  'new URL("../../../docs/runbook/daily.md", import.meta.url)',
];

describe("needsCode", () => {
  it("skips the code checks for documents no test reads", () => {
    expect(
      needsCode(
        ["README.md", "docs/sources.md", "docs/images/day-light.png"],
        tests,
      ),
    ).toBe(false);
    expect(needsCode(["LICENSE"], tests)).toBe(false);
  });
  it("runs them when a test reads a changed document by its path", () => {
    expect(needsCode(["docs/sources.md", "docs/self-host.md"], tests)).toBe(
      true,
    );
    expect(needsCode(["docs/runbook/daily.md"], tests)).toBe(true);
  });
  it("runs them for any file outside the documents", () => {
    expect(needsCode(["docs/sources.md", "apps/cli/src/x.ts"], tests)).toBe(
      true,
    );
    expect(needsCode(["templates/self-host/cron.md"], tests)).toBe(true);
    expect(needsCode([".github/workflows/ci.yml"], tests)).toBe(true);
  });
  it("runs them when the change is unknown", () => {
    expect(needsCode([], tests)).toBe(true);
  });
});

describe("isChecker", () => {
  it("covers tests, browser tests, scripts and tools, not product code", () => {
    expect(isChecker("apps/cli/test/m3b.test.ts")).toBe(true);
    expect(isChecker("apps/web/e2e/reader.spec.ts")).toBe(true);
    expect(isChecker("apps/cli/scripts/cli-smoke.mjs")).toBe(true);
    expect(isChecker("tools/rehearsal.mjs")).toBe(true);
    expect(isChecker("apps/cli/src/commands.ts")).toBe(false);
    expect(isChecker("apps/cli/test/fixtures/day.json")).toBe(false);
  });
});

describe("changedFiles", () => {
  it("lists both paths of a rename, so moving code into docs/ is not a docs-only change", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "ci-scope-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "ci-scope");
    git("config", "user.name", "ci-scope");
    mkdirSync(path.join(repo, "apps"));
    writeFileSync(path.join(repo, "apps", "tool.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(path.join(repo, "docs"));
    git("mv", "apps/tool.ts", "docs/tool.md");
    git("commit", "-q", "-m", "move");
    const changed = changedFiles(base, git("rev-parse", "HEAD"), repo);
    expect(changed.sort()).toEqual(["apps/tool.ts", "docs/tool.md"]);
    expect(needsCode(changed, [])).toBe(true);
  });
});
