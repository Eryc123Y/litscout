// Decides whether a CI run needs the code checks (types, lint, unit, browser
// and smoke tests, the rehearsal). A change that touches only documentation
// skips them; the quick checks (dependency audit, formatting, repository audit)
// run on every change anyway.
//
// Documentation is anything under docs/, Markdown at the root and LICENSE. A
// document under docs/ still counts as code when a test, script or tool names
// its path, because some tests parse the guides (the commands in
// docs/self-host.md, the runbook's wording). Any doubt runs everything.
//
// Usage: node tools/ci-scope.mjs BASE HEAD  → prints `code=true` or `code=false`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const isDocument = (file) =>
  file.startsWith("docs/") || /^[^/]+\.md$/.test(file) || file === "LICENSE";

/** Files that may read a document by its path: tests, scripts and tools. */
export const isChecker = (file) =>
  /\.(ts|tsx|mjs|js)$/.test(file) &&
  (/(^|\/)(test|e2e|scripts)\//.test(file) || file.startsWith("tools/"));

/**
 * @param {readonly string[]} changed paths changed between the two commits
 * @param {readonly string[]} checkers the text of every checker file
 */
export function needsCode(changed, checkers) {
  if (changed.length === 0 || !changed.every(isDocument)) return true;
  return changed.some(
    (file) =>
      file.startsWith("docs/") && checkers.some((text) => text.includes(file)),
  );
}

const git = (repo, ...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

/**
 * Paths changed between the merge base of `base` and `head`, and `head`. A rename lists both its
 * old and new path (`--no-renames`), so moving code into docs/ is not a documentation change.
 */
export function changedFiles(base, head, repo = ".") {
  if (!base || /^0+$/.test(base) || !head) return [];
  try {
    return git(repo, "diff", "--name-only", "--no-renames", `${base}...${head}`)
      .split("\n")
      .filter(Boolean);
  } catch {
    // The base is not in the clone (a force push, a shallow fetch): run everything.
    return [];
  }
}

function main([base, head]) {
  const changed = changedFiles(base, head);
  const checkers = git(".", "ls-files")
    .split("\n")
    .filter(isChecker)
    .map((file) => readFileSync(file, "utf8"));
  const code = needsCode(changed, checkers);
  process.stderr.write(
    `${changed.length} changed file(s); code checks ${code ? "run" : "skipped"}\n`,
  );
  process.stdout.write(`code=${code}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
