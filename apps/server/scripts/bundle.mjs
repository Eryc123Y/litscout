// Pack the built CLI and server for another machine: apps/cli/dist plus a
// package.json that pins the runtime packages to the versions installed here.
// Usage (after `pnpm build`): node apps/server/scripts/bundle.mjs OUT_DIR
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: node apps/server/scripts/bundle.mjs OUT_DIR");
const repo = path.resolve(import.meta.dirname, "../../..");
// Packages the built index.js and server.js import at run time.
const cliPackages = [
  "cheerio",
  "csv-parse",
  "drizzle-orm",
  "fast-xml-parser",
  "jiti",
  "pdfjs-dist",
  "ulid",
  "zod",
];
// The installed version, read from the package folder itself: some packages
// do not export their package.json.
const version = (from, name) =>
  JSON.parse(
    readFileSync(path.join(from, "node_modules", name, "package.json"), "utf8"),
  ).version;
const dependencies = Object.fromEntries([
  ...cliPackages.map((name) => [name, version(repo, name)]),
  ["miniflare", version(path.join(repo, "apps/server"), "miniflare")],
]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(repo, "apps/cli/dist"), path.join(out, "dist"), {
  recursive: true,
});
// Operations scripts (snapshot, re-sync) run from the release folder.
cpSync(path.join(repo, "apps/server/scripts"), path.join(out, "scripts"), {
  recursive: true,
});
// The systemd units, so an administrator installs them from the release.
cpSync(path.join(repo, "apps/server/deploy"), path.join(out, "deploy"), {
  recursive: true,
});
writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "litscout-server-bundle",
      private: true,
      license: "AGPL-3.0-or-later",
      type: "module",
      engines: { node: ">=22.13" },
      dependencies,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ out, dependencies }));
