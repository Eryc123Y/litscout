import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  utimes,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@litscout/core";
import { loadConfig } from "../src/config-loader";
import { runCommand } from "../src/setup-commands";
import { doctorResponse } from "./helpers/doctor";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function harness() {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "litscout-r2-cli-")),
  );
  dirs.push(dir);
  const out: string[] = [];
  const config = defineConfig({
    instance: { name: "sample", publicUrl: "https://sample.example" },
  });
  return {
    dir,
    out,
    deps: {
      isTTY: true,
      dir,
      cwd: dir,
      flow: {
        token: "synthetic-scheduler-value",
        preflight: async (
          client: import("@litscout/pipeline/agents").Client,
        ) => ({ client, usable: true, reason: "fake" }),
      },
      templateDir: path.resolve("templates/self-host"),
      bundlePath: path.resolve("packages/db/worker.js"),
      nodeVersion: "22.13.0",
      run: vi.fn(async (_args: readonly string[]) => '[{"results":[]}]'),
      fetch: vi.fn(async (input: RequestInfo | URL) => doctorResponse(input)),
      fetchVenues: vi.fn(async () => ({
        downloaded_at: "2026-11-17",
        venues: [],
      })),
      prompt: vi.fn(async () => ""),
      print: (text: string) => out.push(text),
      loadConfig: async () => config,
    },
  };
}
it("stops discovery at Git directories and files, but permits an explicit config", async () => {
  const h = await harness();
  await writeFile(
    path.join(h.dir, "litscout.config.ts"),
    "export default {storage:{fullDays:99}};",
  );
  const project = path.join(h.dir, "project");
  await mkdir(path.join(project, "child"), { recursive: true });
  await writeFile(path.join(project, ".git"), "gitdir: elsewhere");
  await expect(loadConfig(path.join(project, "child"))).rejects.toThrow(
    /boundary/,
  );
  const explicit = await loadConfig(
    path.join(project, "child"),
    path.join(h.dir, "litscout.config.ts"),
  );
  expect(explicit.config.storage.fullDays).toBe(99);
  expect(explicit.file).toBe(path.join(h.dir, "litscout.config.ts"));
  await rm(path.join(project, ".git"));
  await mkdir(path.join(project, ".git"));
  await expect(loadConfig(path.join(project, "child"))).rejects.toThrow(
    /boundary/,
  );
  await writeFile(
    path.join(project, "litscout.config.ts"),
    "export default {};",
  );
  expect((await loadConfig(path.join(project, "child"))).file).toBe(
    path.join(project, "litscout.config.ts"),
  );
});
it("stops at home even when an ancestor has a config", async () => {
  const h = await harness();
  await writeFile(path.join(h.dir, "litscout.config.ts"), "export default {};");
  const home = path.join(h.dir, "home");
  await mkdir(path.join(home, "child"), { recursive: true });
  await expect(
    loadConfig(path.join(home, "child"), undefined, home),
  ).rejects.toThrow(/boundary/);
});
it("prints the selected config path in JSON and in doctor output", async () => {
  const h = await harness();
  const file = path.join(h.dir, "chosen.ts");
  await writeFile(file, "export default {};");
  const deps = { ...h.deps, loadConfig: undefined };
  h.deps.run.mockResolvedValue("[]");
  expect(
    await runCommand(["deploy", "--dry-run", "--config", file, "--json"], deps),
  ).toBe(0);
  expect(JSON.parse(h.out.at(-1)!).meta.configPath).toBe(file);
  h.deps.run.mockResolvedValue("Authenticated");
  expect(await runCommand(["doctor", "--config", file], deps)).toBe(1);
  expect(h.out.join("\n")).toContain(file);
  expect(h.out.join("\n")).toContain("Access is disabled");
});
it("creates expiring tokens, defaults to no expiry, and never sends plaintext to SQL", async () => {
  const h = await harness();
  const before = Date.now();
  expect(
    await runCommand(
      [
        "token",
        "create",
        "--name",
        "short",
        "--scopes",
        "read",
        "--expires-in",
        "7",
        "--json",
      ],
      h.deps,
    ),
  ).toBe(0);
  const row = JSON.parse(h.out[0]!).data;
  expect(Date.parse(row.expiresAt) - before).toBeGreaterThanOrEqual(
    7 * 86400000,
  );
  expect(JSON.stringify(h.deps.run.mock.calls)).not.toContain(row.token);
  expect(h.deps.run.mock.calls[0]?.[0].join(" ")).toContain(row.expiresAt);
  expect(
    await runCommand(
      ["token", "create", "--scopes", "read", "--name", "permanent", "--json"],
      h.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(h.out.at(-1)!).data.expiresAt).toBeNull();
  for (const days of ["0", "-1", "NaN", "999999999"]) {
    const count = h.deps.run.mock.calls.length;
    expect(
      await runCommand(
        [
          "token",
          "create",
          "--name",
          "bad",
          "--scopes",
          "read",
          "--expires-in",
          days,
        ],
        h.deps,
      ),
    ).toBe(1);
    expect(h.deps.run).toHaveBeenCalledTimes(count);
  }
});
it("saves a token without printing it with --save-only, for agents whose output is logged", async () => {
  const h = await harness();
  h.deps.run.mockResolvedValue('[{"results":[]}]');
  for (const json of [true, false]) {
    const before = h.out.length;
    expect(
      await runCommand(
        [
          "token",
          "create",
          "--name",
          json ? "scheduler" : "scheduler-text",
          "--scopes",
          "read,ingest,vault",
          "--save-only",
          ...(json ? ["--json"] : []),
        ],
        h.deps,
      ),
    ).toBe(0);
    const stored = JSON.parse(
      await readFile(path.join(h.dir, "credentials.json"), "utf8"),
    ).tokens.at(-1) as { id: string; token: string };
    const printed = h.out.slice(before).join("\n");
    expect(printed).not.toContain(stored.token);
    expect(printed).not.toMatch(/lsk_/);
    expect(printed).toContain(stored.id);
    if (json)
      expect(JSON.parse(h.out.at(-1)!).data).toMatchObject({
        id: stored.id,
        name: "scheduler",
        scopes: ["read", "ingest", "vault"],
        saved: path.join(h.dir, "credentials.json"),
      });
  }
  // The dry run says the token stays local.
  expect(
    await runCommand(
      [
        "token",
        "create",
        "--name",
        "scheduler",
        "--scopes",
        "read",
        "--save-only",
        "--dry-run",
        "--json",
      ],
      h.deps,
    ),
  ).toBe(0);
  expect(JSON.parse(h.out.at(-1)!).data.commands.join("\n")).toMatch(
    /not printed/i,
  );
  expect(
    await runCommand(
      [
        "token",
        "create",
        "--name",
        "x",
        "--scopes",
        "read",
        "--save-only",
        "--save-only",
      ],
      h.deps,
    ),
  ).toBe(1);
});
it("serialises two creates and stores both before their remote inserts", async () => {
  const h = await harness();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.deps.run.mockImplementation(async () => {
    const stored = JSON.parse(
      await readFile(path.join(h.dir, "credentials.json"), "utf8"),
    );
    expect(stored.tokens.length).toBeGreaterThanOrEqual(1);
    if (++arrived === 2) release();
    await gate;
    return '[{"results":[]}]';
  });
  const create = (name: string) =>
    runCommand(
      ["token", "create", "--name", name, "--scopes", "read", "--json"],
      h.deps,
    );
  expect(await Promise.all([create("first"), create("second")])).toEqual([
    0, 0,
  ]);
  const file = path.join(h.dir, "credentials.json");
  expect(
    JSON.parse(await readFile(file, "utf8"))
      .tokens.map((t: { name: string }) => t.name)
      .sort(),
  ).toEqual(["first", "second"]);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
it("rolls back only the failed local entry and recovers an abandoned stale lock", async () => {
  const h = await harness();
  const lock = path.join(h.dir, "credentials.json.lock");
  await writeFile(lock, JSON.stringify({ pid: 999999999, id: "abandoned" }));
  await utimes(lock, new Date(0), new Date(0));
  h.deps.run.mockImplementation(async () => {
    expect(
      JSON.parse(await readFile(path.join(h.dir, "credentials.json"), "utf8"))
        .tokens,
    ).toHaveLength(1);
    throw new Error("private failure");
  });
  expect(
    await runCommand(
      ["token", "create", "--name", "failed", "--scopes", "read", "--json"],
      h.deps,
    ),
  ).toBe(1);
  expect(
    JSON.parse(await readFile(path.join(h.dir, "credentials.json"), "utf8"))
      .tokens,
  ).toEqual([]);
  expect(h.out.join("")).not.toContain("private failure");
  await expect(stat(lock)).rejects.toThrow();
});
it("doctor warns for soon-expiring and old permanent tokens and reports Access status", async () => {
  const h = await harness();
  const now = Date.now();
  const rows = [
    {
      id: "tok_short",
      name: "soon",
      created_at: new Date(now - 86400000).toISOString(),
      expires_at: new Date(now + 7 * 86400000).toISOString(),
      revoked_at: null,
    },
    {
      id: "tok_old",
      name: "old",
      created_at: new Date(now - 181 * 86400000).toISOString(),
      expires_at: null,
      revoked_at: null,
    },
  ];
  await mkdir(path.join(h.dir, "vault"));
  h.deps.run.mockImplementation(async (args) =>
    args[0] === "--version"
      ? "4.151.0"
      : args[0] === "whoami"
        ? "private identity"
        : args[1] === "info"
          ? JSON.stringify({ database_size: 100 })
          : JSON.stringify([{ results: rows }]),
  );
  expect(await runCommand(["doctor", "--json"], h.deps)).toBe(0);
  const data = JSON.parse(h.out[0]!).data;
  expect(data.warnings.join(" ")).toContain("14 days");
  expect(data.warnings.join(" ")).toContain("180 days");
  expect(data.access.configured).toBe(false);
  expect(data.access.message).toContain("Access is disabled");
  expect(data.configPath).toBe(path.join(h.dir, "litscout.config.ts"));
  expect(h.out.join("")).not.toContain("private identity");
});
it("deploys validated Access vars and doctor recognises a complete configuration", async () => {
  const h = await harness();
  h.deps.loadConfig = async () =>
    defineConfig({
      instance: {
        name: "sample",
        publicUrl: "https://sample.example",
        webUrl: "https://reader.example",
      },
      access: {
        teamDomain: "your-team.cloudflareaccess.com",
        aud: "EXAMPLE_AUD",
      },
    });
  h.deps.run.mockImplementation(async (args) => {
    if (args[0] === "whoami") return "Authenticated";
    if (args[0] === "deploy") return "https://sample.example";
    if (args[1] === "list")
      return JSON.stringify([
        { name: "sample-db", uuid: "synthetic-database" },
      ]);
    if (args[1] === "execute")
      return args[args.indexOf("--command") + 1]?.startsWith(
        "SELECT 0 AS used, 80000 AS cap",
      )
        ? '[{"results":[{"used":0,"cap":80000}]}]'
        : '[{"results":[]}]';
    return args.includes("create") ? '{"id":"synthetic-namespace"}' : "OK";
  });
  expect(await runCommand(["deploy", "--json"], h.deps)).toBe(0);
  expect(
    JSON.parse(await readFile(path.join(h.dir, "wrangler.jsonc"), "utf8")).vars,
  ).toMatchObject({
    ACCESS_TEAM_DOMAIN: "your-team.cloudflareaccess.com",
    ACCESS_AUD: "EXAMPLE_AUD",
  });
  await mkdir(path.join(h.dir, "vault"));
  h.deps.run.mockImplementation(async (args) =>
    args[0] === "--version"
      ? "4.151.0"
      : args[0] === "whoami"
        ? "Authenticated"
        : args[1] === "info"
          ? "{}"
          : '[{"results":[]}]',
  );
  expect(await runCommand(["doctor", "--json"], h.deps)).toBe(0);
  expect(JSON.parse(h.out.at(-1)!).data.access.configured).toBe(true);
});
it("reports explicit config errors with their path and refuses malformed overrides", async () => {
  const h = await harness();
  const file = path.join(h.dir, "invalid.ts");
  await writeFile(
    file,
    'export default {access:{teamDomain:"https://invalid"}};',
  );
  expect(
    await runCommand(["doctor", "--config", file, "--json"], {
      ...h.deps,
      loadConfig: undefined,
    }),
  ).toBe(1);
  expect(JSON.parse(h.out.at(-1)!).meta.configPath).toBe(file);
  for (const args of [
    ["doctor", "--config"],
    ["doctor", "--config", file, "--config", file],
    ["init", "--config", file],
  ])
    expect(await runCommand(args, h.deps)).toBe(1);
  expect(h.deps.run).not.toHaveBeenCalled();
});
it("a failed concurrent insert cannot remove the other newly saved token", async () => {
  const h = await harness();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.deps.run.mockImplementation(async (args) => {
    if (++arrived === 2) release();
    await gate;
    if (args.join(" ").includes("'failed'"))
      throw new Error("insertion failed");
    return '[{"results":[]}]';
  });
  const create = (name: string) =>
    runCommand(
      ["token", "create", "--name", name, "--scopes", "read", "--json"],
      h.deps,
    );
  expect(await Promise.all([create("failed"), create("survivor")])).toEqual([
    1, 0,
  ]);
  expect(
    JSON.parse(
      await readFile(path.join(h.dir, "credentials.json"), "utf8"),
    ).tokens.map((t: { name: string }) => t.name),
  ).toEqual(["survivor"]);
});
