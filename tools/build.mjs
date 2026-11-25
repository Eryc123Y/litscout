import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
// Start from an empty folder: the release bundle ships all of apps/cli/dist,
// and `migrate` runs every file in dist/migrations, so nothing from an earlier
// build may stay (apps/cli/scripts/dist-check.mjs checks this after a build).
rmSync("apps/cli/dist", { recursive: true, force: true });
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();
await build({
  entryPoints: ["apps/worker/src/index.ts"],
  outfile: "apps/worker/dist/bundle/worker.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  define: { __GIT_SHA__: JSON.stringify(sha) },
});
const { dependencies } = JSON.parse(readFileSync("package.json", "utf8"));
await build({
  entryPoints: ["apps/cli/src/index.ts"],
  outfile: "apps/cli/dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Bundled CommonJS packages (for example yaml) call require() for Node built-ins.
  // An ESM bundle has no require, so give it one.
  banner: {
    js: 'import { createRequire as __litscoutCreateRequire } from "node:module";\nconst require = __litscoutCreateRequire(import.meta.url);',
  },
  external: Object.keys(dependencies).filter(
    (name) => !name.startsWith("@litscout/"),
  ),
});
await chmod("apps/cli/dist/index.js", 0o755);
// Lets a config import defineConfig where no packages are installed.
await writeFile(
  "apps/cli/dist/config-core.mjs",
  "export const defineConfig = (config) => config;\n",
);
// The self-hosted server: runs the same Worker bundle with saved data.
await build({
  entryPoints: ["apps/server/src/main.ts"],
  outfile: "apps/cli/dist/server.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __litscoutCreateRequire } from "node:module";\nconst require = __litscoutCreateRequire(import.meta.url);',
  },
  external: [
    "miniflare",
    ...Object.keys(dependencies).filter(
      (name) => !name.startsWith("@litscout/"),
    ),
  ],
});
await chmod("apps/cli/dist/server.js", 0o755);
await viteBuild({ root: "apps/web" });
const { cp, mkdir } = await import("node:fs/promises");
await mkdir("apps/cli/dist/templates", { recursive: true });
await cp("templates/self-host", "apps/cli/dist/templates", { recursive: true });
await cp("packages/db/migrations", "apps/cli/dist/migrations", {
  recursive: true,
});
await cp("apps/web/dist", "apps/cli/dist/web", { recursive: true });
await cp("apps/worker/dist/bundle/worker.js", "apps/cli/dist/worker.js");
// The commit this build came from. The vault machine's job rebuilds a build
// that is not from its clone's commit (apps/server/scripts/vault-host.sh).
await writeFile(
  "apps/cli/dist/commit",
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }),
);
