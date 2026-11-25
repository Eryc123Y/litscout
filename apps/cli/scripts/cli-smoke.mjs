import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
// Runs the built CLI bundle, not the sources: a bundling fault (for example a
// CommonJS dependency calling require() inside the ESM bundle) only shows here.
const output = execFileSync(
  process.execPath,
  ["apps/cli/dist/index.js", "--help"],
  { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
);
assert.match(output, /litscout/i);

// Every command starts by loading the bundle's static imports. These packages
// take most of that time on a small server (seconds each run of the daily
// job) and only a few commands use them, so they load where they are used.
const heavy = ["pdfjs-dist", "cheerio", "drizzle-orm"];
const bundle = readFileSync("apps/cli/dist/index.js", "utf8");
const staticImports = [
  ...bundle.matchAll(/^import\s(?:[^;]*?\sfrom\s)?"([^"]+)"/gm),
].map(([, name]) => name);
const loaded = staticImports.filter((name) =>
  heavy.some((pkg) => name === pkg || name.startsWith(`${pkg}/`)),
);
assert.deepEqual(loaded, [], `the CLI loads at start: ${loaded.join(", ")}`);
console.log("CLI bundle smoke passed");
