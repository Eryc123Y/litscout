import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runCommand } from "../src/setup-commands";
import type { SetupDeps } from "../src/command-types";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(rename).mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "litscout-sidecar-"));
  roots.push(root);
  const repo = path.join(root, "repo space"),
    home = path.join(root, "fake-home"),
    file = path.join(root, "sidecar.json"),
    config = path.join(root, "private config.ts");
  await mkdir(repo);
  await mkdir(home);
  await writeFile(config, "export default {};");
  const original = {
    builtin: "cron",
    restart_policy: "on-failure",
    display_name: "Private display",
    description: "PRIVATE_DESCRIPTION",
    args: [
      "CRON_TZ=Asia/Shanghai 20 10,12,16,21 * * 0-5",
      "agentapi",
      "new-conversation",
      "--model=PRIVATE_MODEL",
      "--",
      "OLD_PRIVATE_PROMPT",
    ],
    agent_permissions: {
      workspace_uris: ["file:///old-private-repo"],
      access_grants: [
        "command(uv)",
        "command(git)",
        "read_file(/old-private-repo)",
      ],
      other: "PRIVATE_PERMISSION_VALUE",
    },
    unrelated: { private: "PRIVATE_OTHER_VALUE" },
  };
  const bytes = JSON.stringify(original);
  await writeFile(file, bytes);
  const out: string[] = [];
  const deps = {
    cwd: repo,
    dir: path.join(root, "state"),
    env: { HOME: home },
    print: (s: string) => out.push(s),
    loadConfig: vi.fn(),
    run: vi.fn(),
    fetch: vi.fn(),
  } as unknown as SetupDeps;
  const call = (...args: string[]) => runCommand(["sidecar", ...args], deps);
  return {
    root,
    repo,
    home,
    file,
    config,
    original,
    bytes,
    out,
    deps,
    call,
    backup: path.join(root, "sidecar.before-m1b.json"),
    work: path.join(home, ".cache/litscout/run"),
  };
}
it("R3 dry-run prints only planned changes and writes nothing", async () => {
  const h = await fixture();
  expect(
    await h.call(
      "shadow",
      "--file",
      h.file,
      "--config",
      h.config,
      "--dry-run",
      "--json",
    ),
  ).toBe(0);
  expect(await readFile(h.file, "utf8")).toBe(h.bytes);
  for (const file of [h.backup, h.work])
    await expect(stat(file)).rejects.toHaveProperty("code", "ENOENT");
  const report = JSON.parse(h.out[0]!).data;
  expect(report.changes).toContainEqual({
    path: "agent_permissions.access_grants.5",
    value: `read_file(${h.work})`,
  });
  for (const secret of [
    "OLD_PRIVATE_PROMPT",
    "PRIVATE_MODEL",
    "PRIVATE_DESCRIPTION",
    "PRIVATE_OTHER_VALUE",
    "PRIVATE_PERMISSION_VALUE",
    "old-private-repo",
  ])
    expect(h.out.join("\n")).not.toContain(secret);
  expect(h.deps.loadConfig).not.toHaveBeenCalled();
  expect(h.deps.run).not.toHaveBeenCalled();
  expect(h.deps.fetch).not.toHaveBeenCalled();
});
it("R3 shadow changes only the final prompt and appended permissions, backs up once, and restores exact bytes", async () => {
  const h = await fixture();
  expect(
    await h.call(
      "shadow",
      "--file",
      h.file,
      "--config",
      h.config,
      "--repo",
      h.repo,
      "--json",
    ),
  ).toBe(0);
  const actual = JSON.parse(await readFile(h.file, "utf8"));
  const expected = structuredClone(h.original);
  expected.args[5] = `Run LitScout for today by following \`${h.repo}/docs/runbook/daily.md\` exactly. Use \`--config ${h.config}\` wherever the runbook passes a config path. End with the report as the final message.`;
  expected.agent_permissions.workspace_uris.push(pathToFileURL(h.repo).href);
  expected.agent_permissions.access_grants.push(
    `read_file(${h.repo})`,
    "command(pnpm)",
    `read_file(${h.work})`,
    `write_file(${h.work})`,
  );
  expect(actual).toEqual(expected);
  expect(await readFile(h.backup, "utf8")).toBe(h.bytes);
  expect((await stat(h.backup)).mode & 0o777).toBe(0o600);
  expect((await stat(h.work)).mode & 0o777).toBe(0o700);
  expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
    1,
  );
  expect(await readFile(h.backup, "utf8")).toBe(h.bytes);
  h.out.length = 0;
  expect(await h.call("old-prompt", "--file", h.backup)).toBe(0);
  expect(h.out).toEqual(["OLD_PRIVATE_PROMPT"]);
  expect(await h.call("restore", "--file", h.file)).toBe(0);
  expect(await readFile(h.file, "utf8")).toBe(h.bytes);
});
it("R3 never writes a malformed sidecar or overwrites an existing backup; restore validates before writing", async () => {
  const h = await fixture();
  for (const value of [
    { args: [] },
    { args: ["cron", null] },
    { args: ["cron", ""] },
    { args: ["prompt"], agent_permissions: { access_grants: 42 } },
  ]) {
    await writeFile(h.file, JSON.stringify(value));
    expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
      1,
    );
    await expect(stat(h.backup)).rejects.toHaveProperty("code", "ENOENT");
  }
  await writeFile(h.file, h.bytes);
  await writeFile(h.backup, '{"args":[]}');
  expect(await h.call("restore", "--file", h.file)).toBe(1);
  expect(await readFile(h.file, "utf8")).toBe(h.bytes);
  expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
    1,
  );
  expect(await readFile(h.backup, "utf8")).toBe('{"args":[]}');
});
it("R3 preserves existing permissions without duplicating a grant and validates command options", async () => {
  const h = await fixture();
  h.original.agent_permissions.access_grants.push("command(pnpm)");
  await writeFile(h.file, JSON.stringify(h.original));
  expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
    0,
  );
  const value = JSON.parse(await readFile(h.file, "utf8"));
  expect(
    value.agent_permissions.access_grants.filter(
      (g: string) => g === "command(pnpm)",
    ),
  ).toHaveLength(1);
  for (const args of [
    ["shadow", "--file", h.file],
    ["unknown"],
    ["old-prompt", "--file", h.backup, "--bad"],
    ["old-prompt", "--file", h.backup, "--config", h.config],
    ["restore"],
    ["shadow", "--file", h.file, "--config", h.config, "--repo", "bad\npath"],
  ])
    expect(await h.call(...args)).toBe(1);
});
it("R3 supports a minimal sidecar without deleting unrelated fields", async () => {
  const h = await fixture();
  await writeFile(
    h.file,
    JSON.stringify({ args: ["old prompt"], extra: { keep: true } }),
  );
  expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
    0,
  );
  const updated = JSON.parse(await readFile(h.file, "utf8"));
  expect(updated.extra).toEqual({ keep: true });
  expect(updated.agent_permissions.workspace_uris).toHaveLength(1);
  expect(updated.agent_permissions.access_grants).toHaveLength(4);
});

it("previews and applies a new-only pointer, then restores both exact backups", async () => {
  const h = await fixture();
  const legacy = path.join(h.home, "GitHub", "litscout-daily");
  const legacyUri = pathToFileURL(legacy).href;
  h.original.agent_permissions.workspace_uris = [
    legacyUri,
    legacyUri + "/docs",
    "file:///shared",
  ];
  const legacyGrants = [
    "command(uv)",
    "command(uvx)",
    "command(git)",
    "command(python)",
    "command(python3)",
    `read_file(${legacy}/docs)`,
    `write_file(${legacy})`,
    `read_file(${h.backup})`,
  ];
  h.original.agent_permissions.access_grants = [
    ...legacyGrants,
    "read_file(/old-private-repo)",
    "read_file(/shared)",
  ];
  const original = JSON.stringify(h.original);
  await writeFile(h.file, original);
  expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
    0,
  );
  const shadow = await readFile(h.file, "utf8");
  h.out.length = 0;
  expect(await h.call("cutover", "--file", h.file, "--dry-run")).toBe(0);
  expect(h.out.join("\n")).toContain("Skip Shadow mode");
  const removed = [
    `- workspace_uris: "${legacyUri}"`,
    `- workspace_uris: "${legacyUri}/docs"`,
    ...legacyGrants.map((grant) => `- access_grants: ${JSON.stringify(grant)}`),
  ];
  const preserved = [
    '  workspace_uris: "file:///shared"',
    `  workspace_uris: "${pathToFileURL(h.repo).href}"`,
    ...[
      "read_file(/old-private-repo)",
      "read_file(/shared)",
      `read_file(${h.repo})`,
      "command(pnpm)",
      `read_file(${h.work})`,
      `write_file(${h.work})`,
    ].map((grant) => `  access_grants: ${JSON.stringify(grant)}`),
  ];
  expect(
    h.out[0]!.split("\n").filter((line) =>
      /workspace_uris|access_grants/.test(line),
    ),
  ).toEqual(expect.arrayContaining([...removed, ...preserved]));
  expect(h.out.join("\n")).not.toContain("PRIVATE_MODEL");
  expect(await readFile(h.file, "utf8")).toBe(shadow);
  expect(
    (await readdir(h.root)).filter((f) => f.includes("before-cutover")),
  ).toEqual([]);

  h.out.length = 0;
  expect(await h.call("cutover", "--file", h.file, "--json")).toBe(0);
  const backup = JSON.parse(h.out[0]!).data.backup as string;
  expect(path.basename(backup)).toMatch(
    /^sidecar\.json\.before-cutover-\d{4}-.*\.json$/,
  );
  expect(await readFile(backup, "utf8")).toBe(shadow);
  expect((await stat(backup)).mode & 0o777).toBe(0o600);
  const active = JSON.parse(await readFile(h.file, "utf8"));
  const expected = JSON.parse(shadow);
  expect(active.args.slice(0, -1)).toEqual(expected.args.slice(0, -1));
  expect(active.unrelated).toEqual(expected.unrelated);
  expect(active.agent_permissions).toEqual({
    ...expected.agent_permissions,
    workspace_uris: ["file:///shared", pathToFileURL(h.repo).href],
    access_grants: [
      "read_file(/old-private-repo)",
      "read_file(/shared)",
      `read_file(${h.repo})`,
      "command(pnpm)",
      `read_file(${h.work})`,
      `write_file(${h.work})`,
    ],
  });
  expect(await h.call("cutover", "--file", h.file)).toBe(1);
  expect(
    await h.call("rollback", "--file", h.file, "--to", "shadow", "--dry-run"),
  ).toBe(0);
  expect(JSON.parse(await readFile(h.file, "utf8"))).toEqual(active);
  expect(await h.call("rollback", "--file", h.file, "--to", "shadow")).toBe(0);
  expect(await readFile(h.file, "utf8")).toBe(shadow);
  expect(await h.call("rollback", "--file", h.file, "--to", "original")).toBe(
    0,
  );
  expect(await readFile(h.file, "utf8")).toBe(original);
});

it("refuses a manually edited cutover, previews what rollback would undo and saves exact bytes with force", async () => {
  const h = await fixture();
  const when = new Date("2026-11-18T04:30:00Z");
  h.deps.flow = { now: () => when };
  await h.call("shadow", "--file", h.file, "--config", h.config);
  const shadow = await readFile(h.file, "utf8");
  await h.call("cutover", "--file", h.file);
  const edited = JSON.parse(await readFile(h.file, "utf8"));
  edited.args[3] = "--model=MANUAL_EDIT";
  const bytes = JSON.stringify(edited);
  await writeFile(h.file, bytes);
  const backup = path.join(
    h.root,
    "sidecar.json.before-rollback-2026-11-18T04-30-00.000Z.json",
  );
  const rollback = ["rollback", "--file", h.file, "--to", "shadow"];

  expect(await h.call(...rollback)).toBe(1);
  expect(h.out.at(-1)).toMatch(/--force/);
  expect(h.out.at(-1)).toContain('- args[3]: "--model=MANUAL_EDIT"');
  expect(await h.call(...rollback, "--force", "--dry-run")).toBe(0);
  expect(h.out.at(-1)).toContain(backup);
  expect(await readFile(h.file, "utf8")).toBe(bytes);
  await expect(stat(backup)).rejects.toHaveProperty("code", "ENOENT");

  expect(await h.call(...rollback, "--force")).toBe(0);
  expect(h.out.at(-1)).toContain('- args[3]: "--model=MANUAL_EDIT"');
  expect(await readFile(h.file, "utf8")).toBe(shadow);
  expect(await readFile(backup, "utf8")).toBe(bytes);
  expect((await stat(backup)).mode & 0o777).toBe(0o600);
  await writeFile(h.file, bytes + "\n");
  expect(await h.call(...rollback, "--force")).toBe(1);
  expect(await readFile(h.file, "utf8")).toBe(bytes + "\n");
  expect(await readFile(backup, "utf8")).toBe(bytes);
});

it("leaves an already-shadow sidecar alone even before the first cutover", async () => {
  const h = await fixture();
  await h.call("shadow", "--file", h.file, "--config", h.config);
  const shadow = await readFile(h.file, "utf8");
  expect(await h.call("rollback", "--file", h.file, "--to", "shadow")).toBe(0);
  expect(h.out.at(-1)).toMatch(/already in shadow/i);
  expect(await readFile(h.file, "utf8")).toBe(shadow);
  expect(
    (await readdir(h.root)).filter((f) => f.includes("before-rollback")),
  ).toEqual([]);
});

it("keeps the live file mode through sidecar writes and leaves backups private", async () => {
  const h = await fixture();
  await chmod(h.file, 0o640);
  const steps = [
    ["shadow", "--config", h.config],
    ["cutover"],
    ["rollback", "--to", "shadow"],
    ["restore"],
  ];
  for (const [command, ...args] of steps) {
    expect(await h.call(command!, "--file", h.file, ...args)).toBe(0);
    expect((await stat(h.file)).mode & 0o777).toBe(0o640);
  }
  const backups = (await readdir(h.root)).filter((f) => f.includes(".before-"));
  expect(backups).toHaveLength(3);
  for (const backup of backups)
    expect((await stat(path.join(h.root, backup))).mode & 0o777).toBe(0o600);
});

it("reclaims a dead local PID or an expired lock and reports why", async () => {
  const h = await fixture();
  const now = new Date("2026-11-18T04:30:00Z");
  h.deps.flow = { now: () => now };
  const lock = h.file + ".litscout.lock";
  await writeFile(
    lock,
    JSON.stringify({
      pid: 2147483647,
      host: hostname(),
      timestamp: now.toISOString(),
    }),
  );
  expect(
    await h.call("shadow", "--file", h.file, "--config", h.config, "--json"),
  ).toBe(0);
  expect(JSON.parse(h.out.at(-1)!).data.messages[0]).toMatch(
    /stale.*pid.*not running/i,
  );
  await expect(stat(lock)).rejects.toHaveProperty("code", "ENOENT");

  await writeFile(
    lock,
    JSON.stringify({
      pid: process.pid,
      host: "another-host",
      timestamp: "2026-11-18T04:19:59Z",
    }),
  );
  expect(await h.call("cutover", "--file", h.file)).toBe(0);
  expect(h.out.at(-1)).toMatch(/stale.*older than 10 minutes/i);
  await expect(stat(lock)).rejects.toHaveProperty("code", "ENOENT");
});

it("records the owner and blocks a second update while its lock is live", async () => {
  const h = await fixture();
  const lock = h.file + ".litscout.lock";
  const now = new Date("2026-11-18T04:30:00Z");
  h.deps.flow = { now: () => now };
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const owner = {
    pid: process.pid,
    host: hostname(),
    timestamp: now.toISOString(),
  };
  vi.mocked(rename).mockImplementationOnce(async (from, to) => {
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual(owner);
    expect(await h.call("cutover", "--file", h.file)).toBe(1);
    expect(h.out.at(-1)).toContain(lock);
    expect(h.out.at(-1)).toMatch(/remove.*lock/i);
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual(owner);
    await fs.rename(from, to);
  });
  expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
    0,
  );
  await expect(stat(lock)).rejects.toHaveProperty("code", "ENOENT");
});

it.each([["cutover"], ["rollback", "--to", "shadow"]])(
  "verifies the sidecar on disk after %s",
  async (command, ...args) => {
    const h = await fixture();
    await h.call("shadow", "--file", h.file, "--config", h.config);
    if (command === "rollback") await h.call("cutover", "--file", h.file);
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      await fs.rename(from, to);
      const value = JSON.parse(await readFile(h.file, "utf8"));
      value.description = "Changed after rename";
      await writeFile(h.file, JSON.stringify(value));
    });
    expect(await h.call(command!, "--file", h.file, ...args)).toBe(1);
    expect(h.out.at(-1)).toMatch(/sidecar validation failed/i);
  },
);

it("refuses an original sidecar or a shadow pointer with missing LitScout grants", async () => {
  const h = await fixture();
  expect(await h.call("cutover", "--file", h.file)).toBe(1);
  expect(h.out.at(-1)).toMatch(/expected shadow/i);
  await h.call("shadow", "--file", h.file, "--config", h.config);
  const value = JSON.parse(await readFile(h.file, "utf8"));
  value.agent_permissions.access_grants = [];
  await writeFile(h.file, JSON.stringify(value));
  expect(await h.call("cutover", "--file", h.file)).toBe(1);
  expect(h.out.at(-1)).toMatch(/missing.*grant/i);
  expect(JSON.parse(await readFile(h.file, "utf8"))).toEqual(value);
  expect(await h.call("rollback", "--file", h.file, "--to", "shadow")).toBe(1);
});

it("recognises the earlier shadow pointer that Antigravity still carries, so cutover can run", async () => {
  // Installed on 2026-11-18 by an earlier `sidecar shadow`, before the
  // pointer's wording changed; cutover then refused with "Expected shadow mode".
  const h = await fixture();
  await writeFile(h.file, JSON.stringify(h.original));
  expect(await h.call("shadow", "--file", h.file, "--config", h.config)).toBe(
    0,
  );
  const installed = JSON.parse(await readFile(h.file, "utf8"));
  const current = installed.args.at(-1) as string;
  const [, runbook, config] =
    /following `([^`]+)` exactly\. Use `--config ([^`]+)`/.exec(current)!;
  installed.args[installed.args.length - 1] =
    `Run LitScout for today by following \`${runbook}\` exactly, passing \`--config ${config}\` to every litscout command. End with the report as the final message.`;
  await writeFile(h.file, JSON.stringify(installed, null, 2) + "\n");
  h.out.length = 0;
  expect(await h.call("cutover", "--file", h.file, "--dry-run")).toBe(0);
  expect(h.out.join("\n")).toContain("Skip Shadow mode");
  // A pointer in neither wording is still refused.
  installed.args[installed.args.length - 1] = current.replace(
    "exactly.",
    "loosely.",
  );
  await writeFile(h.file, JSON.stringify(installed, null, 2) + "\n");
  expect(await h.call("cutover", "--file", h.file, "--dry-run")).not.toBe(0);
});

it("tells daily start which mode the installed scheduler prompt is in", async () => {
  const { schedulerMode } = await import("../src/sidecar-command");
  const home = await mkdtemp(path.join(tmpdir(), "litscout-mode-"));
  roots.push(home);
  const folder = path.join(home, ".gemini/config/sidecars/litscout-daily");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, "sidecar.json");
  const write = (prompt: string) =>
    writeFile(file, JSON.stringify({ args: ["agent", prompt] }));
  const runbook = "/repo/docs/runbook/daily.md";
  // No scheduler on this machine: nothing to say.
  expect(await schedulerMode(home)).toBeNull();
  // The earlier shadow wording Antigravity carries on 2026-11-19.
  await write(
    `Run LitScout for today by following \`${runbook}\` exactly, passing \`--config /cfg.ts\` to every litscout command. End with the report as the final message.`,
  );
  expect(await schedulerMode(home)).toEqual({
    mode: "shadow",
    oldPrompt: `litscout sidecar old-prompt --file ${path.join(folder, "sidecar.before-m1b.json")}`,
  });
  // The cutover pointer.
  await write(
    `Run LitScout for today by following \`${runbook}\` exactly. Run only LitScout. Skip Shadow mode and the completed legacy import. Use \`--config /cfg.ts\` wherever the runbook passes a config path. End with the report as the final message.`,
  );
  expect(await schedulerMode(home)).toEqual({ mode: "cutover" });
  // The old pipeline's own prompt, or anything else.
  await write("Run the old daily pipeline.");
  expect(await schedulerMode(home)).toEqual({ mode: "other" });
  await writeFile(file, "{not json");
  expect(await schedulerMode(home)).toEqual({ mode: "unknown" });
});
