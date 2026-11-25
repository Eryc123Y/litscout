import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
// The built folder must hold this build only: the release bundle copies all of
// apps/cli/dist to the server, and `migrate` runs every .sql file it finds in
// dist/migrations. A file left over from an earlier build would ship with it.
const dist = "apps/cli/dist";

const sorted = (dir) => readdirSync(dir).sort();
assert.deepEqual(
  sorted(path.join(dist, "migrations")),
  sorted("packages/db/migrations"),
  "dist/migrations differs from packages/db/migrations",
);

// Every web asset is reachable from index.html through the files that name it.
const web = path.join(dist, "web");
const assets = new Set(sorted(path.join(web, "assets")));
const textual = (name) => /\.(js|css|html|json|svg|webmanifest)$/.test(name);
const reached = new Set();
const queue = ["index.html"];
while (queue.length) {
  const file = queue.pop();
  const text = readFileSync(path.join(web, file), "utf8");
  for (const name of assets)
    if (!reached.has(name) && text.includes(name)) {
      reached.add(name);
      if (textual(name)) queue.push(path.join("assets", name));
    }
}
const stale = [...assets].filter((name) => !reached.has(name));
assert.deepEqual(stale, [], `web assets no page reaches: ${stale.join(", ")}`);
console.log(
  `Built folder check passed: ${assets.size} web assets, all reachable; migrations match`,
);
