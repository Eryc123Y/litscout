import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterEach, expect, it } from "vitest";
import { workerOptions, type ServerConfig } from "../src/config";

const open: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((mf) => mf.dispose()));
});

const worker = `import { DurableObject } from "cloudflare:workers";
export class PairingStore extends DurableObject {}
export class SourceLimiter extends DurableObject {}
export default { fetch() { return new Response("worker ok"); } };`;

it("serves an app folder reached through a symlink outside the working directory", async () => {
  // A release folder behind a `current` symlink, as the runbook installs it.
  const root = mkdtempSync(path.join(tmpdir(), "litscout-serve-"));
  const release = path.join(root, "releases", "one", "dist");
  mkdirSync(path.join(release, "web"), { recursive: true });
  writeFileSync(path.join(release, "worker.js"), worker);
  writeFileSync(path.join(release, "web", "index.html"), "<p>app</p>");
  symlinkSync(path.join(root, "releases", "one"), path.join(root, "current"));
  const config: ServerConfig = {
    local: false,
    host: "127.0.0.1",
    port: 8787,
    app: path.join(root, "current", "dist"),
    state: path.join(root, "state"),
    vars: { PUBLIC_URL: "https://litscout.example.org" },
    cronUtc: "02:00",
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      ...workerOptions(config, {}),
      port: 0,
      logRequests: false,
    }),
  );
  open.push(mf);
  const response = await mf.dispatchFetch("http://localhost/health");
  expect(await response.text()).toBe("worker ok");
});
