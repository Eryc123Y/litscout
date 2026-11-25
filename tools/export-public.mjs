// Write the tree that can be published: the tracked files of HEAD without
// the working notes, then check that nothing in it points back at them or
// names the private instance.
//
//   node tools/export-public.mjs OUT_DIR
//
// OUT_DIR gets the files only, with no history; publishing starts a new
// one. The working notes (docs/build, docs/legacy, docs/review) stay in the
// private repository. docs/build/public-export.json, which is itself a
// working note and never exported, may add to both lists:
//
//   { "exclude": ["docs/more"], "deny": ["a private host name"],
//     "denyPatterns": ["\\bFirstName\\b"] }
//
// `deny` strings are matched without regard to case in every text file;
// `denyPatterns` are regular expressions, matched as written.
// The command prints its findings and exits 1 when there are any. A secret
// scanner still has to read OUT_DIR afterwards: this checks names, not keys.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const workingNotes = ["docs/build", "docs/legacy", "docs/review"];
const settingsFile = "docs/build/public-export.json";
/** This script and its test name the working notes on purpose. */
const self = ["tools/export-public.mjs", "tools/test/export-public.test.ts"];
/** Recorded listings and feeds: real papers, whose authors' names are not
 * the instance's. Plain `deny` strings still apply to them. */
const recorded = /(^|\/)test\/fixtures\//;

/** Every file under a folder, as paths relative to it. */
export function filesUnder(root, at = "") {
  return readdirSync(path.join(root, at), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = path.join(at, entry.name);
      return entry.isDirectory() ? filesUnder(root, relative) : [relative];
    },
  );
}

/** The text of a file, or null for one that is not text. */
function textOf(file) {
  const bytes = readFileSync(file);
  return bytes.subarray(0, 8000).includes(0) ? null : bytes.toString("utf8");
}

/** The anchor GitHub gives a Markdown heading. */
export function headingAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}
const anchorsOf = (markdown) =>
  new Set(
    markdown
      .replace(/```[\s\S]*?```/g, "")
      .split("\n")
      .filter((line) => /^#{1,6}\s/.test(line))
      .map((line) => headingAnchor(line.replace(/^#{1,6}\s+/, ""))),
  );

/** Links from a Markdown file to a missing file or heading in the tree. */
export function brokenLinks(root, file, markdown) {
  const problems = [];
  const prose = markdown.replace(/```[\s\S]*?```/g, "");
  for (const [, target] of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    const [to, anchor] = target.split("#");
    const resolved = to
      ? path.join(root, path.dirname(file), decodeURIComponent(to))
      : path.join(root, file);
    if (!existsSync(resolved)) {
      problems.push(`${file}: link to ${target}, which is not in the tree`);
      continue;
    }
    if (
      !anchor ||
      !resolved.endsWith(".md") ||
      statSync(resolved).isDirectory()
    )
      continue;
    if (!anchorsOf(readFileSync(resolved, "utf8")).has(anchor))
      problems.push(`${file}: link to ${target}, a heading that is not there`);
  }
  return problems;
}

/** What stops a tree from being published. */
export function checkTree(
  root,
  { excluded = workingNotes, deny = [], denyPatterns = [] } = {},
) {
  const problems = [];
  const denied = deny.map((text) => text.toLowerCase()).filter(Boolean);
  const patterns = denyPatterns.map((source) => new RegExp(source));
  for (const file of filesUnder(root).sort()) {
    const text = textOf(path.join(root, file));
    if (text === null) continue;
    text.split("\n").forEach((line, at) => {
      for (const folder of self.includes(file) ? [] : excluded)
        if (line.includes(folder))
          problems.push(
            `${file}:${at + 1}: names ${folder}, which is not in the tree`,
          );
      const lower = line.toLowerCase();
      for (const word of denied)
        if (lower.includes(word))
          problems.push(`${file}:${at + 1}: contains "${word}"`);
      for (const pattern of recorded.test(file) ? [] : patterns)
        if (pattern.test(line))
          problems.push(`${file}:${at + 1}: matches ${pattern}`);
    });
    if (file.endsWith(".md")) problems.push(...brokenLinks(root, file, text));
  }
  return problems;
}

/** The exported tree: HEAD's tracked files without the excluded paths. */
export function exportTree(repo, out, excluded) {
  if (existsSync(out) && readdirSync(out).length)
    throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
    cwd: repo,
    maxBuffer: 1 << 30,
  });
  execFileSync("tar", ["-x", "-C", out], { input: archive });
  for (const entry of excluded)
    rmSync(path.join(out, entry), { recursive: true, force: true });
  // The formatter's ignore list names files that are gone now.
  const ignore = path.join(out, ".prettierignore");
  if (existsSync(ignore))
    writeFileSync(
      ignore,
      readFileSync(ignore, "utf8")
        .split("\n")
        .filter((line) => !excluded.some((entry) => line.startsWith(entry)))
        .join("\n"),
    );
  return filesUnder(out).length;
}

function main() {
  const out = process.argv[2];
  if (!out) throw new Error("usage: node tools/export-public.mjs OUT_DIR");
  const repo = path.resolve(fileURLToPath(import.meta.url), "../..");
  if (execFileSync("git", ["status", "--porcelain"], { cwd: repo }).length)
    throw new Error(
      "Commit or stash your changes first: HEAD is what is exported",
    );
  const settings = existsSync(path.join(repo, settingsFile))
    ? JSON.parse(readFileSync(path.join(repo, settingsFile), "utf8"))
    : {};
  const excluded = [...workingNotes, ...(settings.exclude ?? [])];
  const files = exportTree(repo, path.resolve(out), excluded);
  const problems = checkTree(path.resolve(out), {
    excluded,
    deny: settings.deny ?? [],
    denyPatterns: settings.denyPatterns ?? [],
  });
  for (const problem of problems) console.error(problem);
  console.log(
    JSON.stringify({
      out: path.resolve(out),
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
        .toString()
        .trim(),
      files,
      excluded,
      denyWords:
        (settings.deny ?? []).length + (settings.denyPatterns ?? []).length,
      problems: problems.length,
    }),
  );
  if (problems.length) process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
