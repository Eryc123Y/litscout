import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// Runs the built CLI bundle, not the sources: a bundling fault (for example a
// CommonJS dependency calling require() inside the ESM bundle) only shows here.
const output = execFileSync(
  process.execPath,
  ["apps/cli/dist/index.js", "--help"],
  { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
);
assert.match(output, /litscout/i);
console.log("CLI bundle smoke passed");
