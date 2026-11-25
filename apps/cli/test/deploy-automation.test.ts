import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-deploy-auto-"));
  dirs.push(dir);
  const out: string[] = [];
  const uploads: Record<string, string>[] = [];
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "whoami") return "Authenticated";
    if (args[0] === "d1" && args[1] === "list")
      return JSON.stringify([
        { name: "sample-db", uuid: "synthetic-database" },
      ]);
    if (args[1] === "execute")
      return args[args.indexOf("--command") + 1]?.startsWith(
        "SELECT 0 AS used, 80000 AS cap",
      )
        ? '[{"results":[{"used":0,"cap":80000}]}]'
        : '[{"results":[]}]';
    if (args[0] === "kv" && args.includes("create"))
      return '{"id":"synthetic-namespace"}';
    if (args[0] === "secret") {
      uploads.push(JSON.parse(await readFile(args[2]!, "utf8")));
      return "OK";
    }
    if (args[0] === "deploy") return "https://sample.example";
    return "OK";
  });
  return {
    dir,
    out,
    uploads,
    deps: {
      dir,
      cwd: dir,
      bundlePath: path.resolve("packages/db/worker.js"),
      templateDir: path.resolve("templates/self-host"),
      run,
      fetch: vi.fn(),
      fetchVenues: vi.fn(async () => ({
        downloaded_at: "2026-11-17",
        venues: [],
      })),
      prompt: vi.fn(async () => {
        throw new Error("Unexpected prompt");
      }),
      print: (text: string) => out.push(text),
      loadConfig: async () => defineConfig({ instance: { name: "sample" } }),
      isTTY: false,
      env: {} as Readonly<Record<string, string | undefined>>,
    },
  };
}
it("deploys with --skip-keys without prompts and keeps required management secrets", async () => {
  const h = await harness();
  expect(await runCommand(["deploy", "--skip-keys", "--json"], h.deps)).toBe(0);
  expect(h.deps.prompt).not.toHaveBeenCalled();
  const config = JSON.parse(
    await readFile(path.join(h.dir, "wrangler.jsonc"), "utf8"),
  );
  // Only the 02:00 UTC housekeeping cron; the M4d crawl trial adds none.
  expect(config.triggers).toEqual({ crons: ["0 2 * * *"] });
  expect(h.uploads).toHaveLength(1);
  expect(Object.keys(h.uploads[0]!).sort()).toEqual([
    "CONSENT_SECRET",
    "MGMT_TOKEN",
  ]);
  expect(
    (await readdir(h.dir)).some((name) => name.startsWith("secrets-")),
  ).toBe(false);
});
it("takes only nonempty allowlisted keys from the supplied environment and never echoes them", async () => {
  const h = await harness();
  const env = {
    S2_API_KEY: " synthetic-s2 ",
    OPENALEX_API_KEY: "   ",
    CORE_API_KEY: "synthetic-core",
    UNRELATED: "synthetic-unrelated",
  };
  expect(
    await runCommand(["deploy", "--keys-from-env", "--json"], {
      ...h.deps,
      env,
    }),
  ).toBe(0);
  expect(h.deps.prompt).not.toHaveBeenCalled();
  expect(h.uploads[0]).toMatchObject({
    S2_API_KEY: "synthetic-s2",
    CORE_API_KEY: "synthetic-core",
  });
  expect(h.uploads[0]).not.toHaveProperty("OPENALEX_API_KEY");
  expect(h.uploads[0]).not.toHaveProperty("UNRELATED");
  for (const value of [
    "synthetic-s2",
    "synthetic-core",
    "synthetic-unrelated",
  ]) {
    expect(h.out.join("")).not.toContain(value);
    expect(JSON.stringify(h.deps.run.mock.calls)).not.toContain(value);
  }
});
it("fails before any runner call, prompt or local state write without flags and without a TTY", async () => {
  const h = await harness();
  expect(await runCommand(["deploy", "--json"], h.deps)).toBe(1);
  const error = JSON.parse(h.out[0]!).data.message;
  expect(error).toContain("--skip-keys");
  expect(error).toContain("--keys-from-env");
  expect(h.deps.run).not.toHaveBeenCalled();
  expect(h.deps.prompt).not.toHaveBeenCalled();
  expect(await readdir(h.dir)).toEqual([]);
});
it("previews skipped/env key modes with read-only D1 calls and no key access or prompt", async () => {
  const h = await harness();
  const env = Object.defineProperty({}, "S2_API_KEY", {
    get() {
      throw new Error("Preview read a key");
    },
  });
  for (const flag of ["--skip-keys", "--keys-from-env"]) {
    expect(
      await runCommand(["deploy", flag, "--dry-run", "--json"], {
        ...h.deps,
        env,
      }),
    ).toBe(0);
    const plan = JSON.parse(h.out.at(-1)!).data.commands.join("\n");
    expect(plan).toContain(
      flag === "--skip-keys"
        ? "no source keys"
        : "nonempty source keys from the environment",
    );
  }
  expect(h.deps.run.mock.calls.map(([args]) => args[1])).toEqual([
    "list",
    "execute",
    "execute",
    "list",
    "execute",
    "execute",
  ]);
  expect(h.deps.prompt).not.toHaveBeenCalled();
  expect(await readdir(h.dir)).toEqual([]);
});
it("rejects conflicting key flags before side effects", async () => {
  const h = await harness();
  expect(
    await runCommand(
      ["deploy", "--skip-keys", "--keys-from-env", "--json"],
      h.deps,
    ),
  ).toBe(1);
  expect(h.deps.run).not.toHaveBeenCalled();
  expect(h.deps.prompt).not.toHaveBeenCalled();
});
