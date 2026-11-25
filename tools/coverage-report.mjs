import { readFileSync } from "node:fs";
import path from "node:path";
const coverage = JSON.parse(
  readFileSync("coverage/coverage-summary.json", "utf8"),
);
const imported = new Set(
  JSON.parse(readFileSync("tools/imported-files.json", "utf8")),
);
const groups = new Map();
const metrics = ["lines", "functions", "branches", "statements"];
for (const [file, result] of Object.entries(coverage)) {
  if (file === "total") continue;
  const relative = path.relative(process.cwd(), file);
  const names = [
    relative.split(path.sep).slice(0, 2).join("/"),
    ...(imported.has(relative) ? ["Imported MCP"] : []),
  ];
  for (const name of names) {
    const group =
      groups.get(name) ??
      Object.fromEntries(metrics.map((m) => [m, { total: 0, covered: 0 }]));
    for (const metric of metrics) {
      group[metric].total += result[metric].total;
      group[metric].covered += result[metric].covered;
    }
    groups.set(name, group);
  }
}
function percentage(entry) {
  return entry.total ? (100 * entry.covered) / entry.total : 100;
}
process.stdout.write(
  "| Package | Lines | Functions | Branches | Statements |\n|---|---:|---:|---:|---:|\n",
);
for (const [name, result] of groups) {
  process.stdout.write(
    `| ${name} | ${metrics.map((m) => percentage(result[m]).toFixed(2) + "%").join(" | ")} |\n`,
  );
}
const original = groups.get("Imported MCP");
if (!original || percentage(original.lines) < 94.51)
  throw new Error(
    "Imported MCP line coverage fell below its reported 94.51% baseline",
  );
