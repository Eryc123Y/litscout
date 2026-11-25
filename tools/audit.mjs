import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
// `--static` checks the tracked files only and can run first; `--tests` checks
// the imported tests in the last test run; no flag does both.
const mode = process.argv[2];
if (mode !== undefined && mode !== "--static" && mode !== "--tests")
  throw new Error("usage: node tools/audit.mjs [--static | --tests]");
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim()
  .split("\n");
const failures = [];
const imports = [];
const summary = [];
for (const file of mode === "--tests" ? [] : files) {
  const text = readFileSync(file, "utf8");
  // systemd template instances (name@instance.service) are not addresses.
  const scanned = text.replace(
    /[\w.-]+@[\w.-]*\.(?:service|timer|socket|target|path|mount)\b/g,
    "",
  );
  if (
    /lsk_[A-Z2-7]{52}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(
      scanned,
    )
  )
    failures.push(`Unexpected token or contact literal in ${file}`);
  if (!/^(apps|packages)\/[^/]+\/.*\.tsx?$/.test(file)) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text, file);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      check(node.arguments[0].text, file);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
function check(specifier, file) {
  if (!specifier.startsWith(".")) return;
  const target = path.normalize(path.join(path.dirname(file), specifier));
  if (
    /^(apps|packages)\//.test(target) &&
    file.split("/").slice(0, 2).join("/") !==
      target.split("/").slice(0, 2).join("/")
  )
    imports.push(`${file}: ${specifier}`);
}
if (imports.length) failures.push(...imports);
if (mode !== "--tests") checkLicence();
if (mode !== "--static") checkImportedTests();
if (failures.length) throw new Error(failures.join("\n"));
process.stdout.write(`Audit passed: ${summary.join("; ")}.\n`);
// The licence (R1, 11-25: AGPL-3.0-or-later): the text at the root and
// the same SPDX id in every package of the workspace.
function checkLicence() {
  const licence = "AGPL-3.0-or-later";
  if (
    !files.includes("LICENSE") ||
    !/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/.test(
      readFileSync("LICENSE", "utf8"),
    )
  )
    failures.push("LICENSE is not the GNU AGPL version 3 text");
  for (const file of files.filter((f) => path.basename(f) === "package.json"))
    if (JSON.parse(readFileSync(file, "utf8")).license !== licence)
      failures.push(`${file}: license is not ${licence}`);
  summary.push(
    `${files.length} tracked files`,
    "no token/contact literals or package-crossing relative imports",
    `${licence} in LICENSE and every package`,
  );
}
function checkImportedTests() {
  const imported = JSON.parse(
    readFileSync("tools/imported-tests.json", "utf8"),
  );
  const results = JSON.parse(
    readFileSync(".artifacts/test-results.json", "utf8"),
  );
  const selected = results.testResults.filter((r) =>
    imported.includes(path.relative(process.cwd(), r.name)),
  );
  if (
    selected.length !== imported.length ||
    selected.some((r) => r.status !== "passed")
  )
    failures.push("Some imported test files did not pass");
  summary.push(
    `${selected.length} imported test files, ${selected.reduce((n, r) => n + r.assertionResults.length, 0)} imported tests passed`,
  );
}
