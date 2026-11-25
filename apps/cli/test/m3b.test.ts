import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defineConfig } from "@litscout/core";
import { SCHEMA_VERSION } from "@litscout/db";
import { runCommand, parseCommand } from "../src/setup-commands";
import { localVaultSink } from "@litscout/sync/vault-sink";
import { openVault } from "@litscout/sync/vault-source";
import { parseNote } from "@litscout/sync/vault-note";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "litscout-m3b-"));
  roots.push(cwd);
  const out: string[] = [];
  const deps = {
    dir: path.join(cwd, "state"),
    cwd,
    templateDir: path.resolve("templates/self-host"),
    bundlePath: path.resolve("packages/db/worker.js"),
    nodeVersion: "22.13.0",
    loadConfig: async () =>
      defineConfig({
        instance: {
          name: "test",
          publicUrl: "https://cli.example",
          webUrl: "https://web.example",
        },
        access: {
          teamDomain: "test.cloudflareaccess.com",
          aud: "aud_from_dashboard",
        },
        agent: { mode: "none" },
      }),
    run: vi.fn(async (_args: readonly string[]) => ""),
    fetch: vi.fn<typeof fetch>(),
    prompt: vi.fn(),
    fetchVenues: vi.fn(),
    print: (line: string) => out.push(line),
    flow: {
      token: "lsk_" + "A".repeat(52),
      preflight: vi.fn(),
      agent: vi.fn(),
    },
  };
  const run = async (...args: string[]) => {
    const code = await runCommand([...args, "--json"], deps);
    return { code, ...JSON.parse(out.at(-1)!) };
  };
  return { deps, run };
}

it("initializes all starter files and renders notes through the real vault writer", async () => {
  const { deps, run } = await fixture();
  const result = await run("init");
  expect(result.code).toBe(0);
  expect(result.data.created).toHaveLength(8);
  expect(result.data.messages.join(" ")).toMatch(/Edit.*litscout.config.ts/);
  // Every template but the venue catalog, which only `init`'s questions read.
  expect(await readdir(deps.cwd)).toEqual(
    (await readdir(deps.templateDir))
      .filter((name) => name !== "venue-catalog.json")
      .sort(),
  );
  const sidecar = JSON.parse(
    await readFile(path.join(deps.cwd, "antigravity-sidecar.json"), "utf8"),
  );
  expect(sidecar.args.at(-1)).toContain("tool-less settings");
  expect(sidecar.agent_permissions).toEqual({
    workspace_uris: ["file:///ABSOLUTE/REPO"],
    access_grants: [
      "read_file(/ABSOLUTE/REPO)",
      "command(pnpm)",
      "read_file(/ABSOLUTE/HOME/.cache/litscout/run)",
      "write_file(/ABSOLUTE/HOME/.cache/litscout/run)",
    ],
  });
  const vaultConfig = defineConfig({
    vault: {
      write: true,
      paperNotes: {
        dirs: { Vision: "Papers" },
        template: "./vault-paper-template.md",
      },
      digestsDir: "Digests",
      digestTemplate: "./vault-digest-template.md",
    },
  }).vault;
  await mkdir(path.join(deps.cwd, "vault"));
  const sink = localVaultSink(
    await openVault(vaultConfig, deps.cwd),
    vaultConfig,
    { configDir: deps.cwd },
  );
  const created = await sink.request({
    id: "req_template",
    kind: "make_paper_note",
    paper: {
      id: "pap_sample",
      title: "Stereo: a paper",
      arxiv: "2611.00001",
      topics: ["Vision"],
      links: [],
      notes: [],
    },
  });
  const digest = await sink.digest("2026-11-16", "Digest body");
  for (const [type, file] of [
    ["paper", created.path],
    ["digest", digest.path],
  ] as const) {
    const { doc } = parseNote(
      await readFile(path.join(deps.cwd, "vault", file), "utf8"),
    );
    expect(doc.get("type")).toBe(type);
    expect(doc.toJSON().tags).toEqual([`type/${type}`]);
    expect(doc.get("description")).toEqual(expect.stringMatching(/\S/));
  }
});

function guideCommands(guide: string) {
  const quotedWords = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  const examples: string[] = [];
  const prose = guide.replace(
    /^[ \t]*```([^\n]*)\n([\s\S]*?)^[ \t]*```.*$/gm,
    (_, lang, block) => {
      if (/^(?:sh|bash|zsh)$/.test(lang.trim()))
        examples.push(...block.replace(/\\\n[ \t]*/g, " ").split("\n"));
      return "";
    },
  );
  examples.push(
    ...Array.from(prose.matchAll(/`([^`\n]+)`/g), ([, code]) => code!),
  );
  return examples.flatMap((example) => {
    const cli = /^\s*(?:pnpm exec )?litscout\s+(.+)$/.exec(example);
    return cli
      ? [
          [...cli[1]!.matchAll(quotedWords)].map(
            ([, double, single, bare]) => double ?? single ?? bare!,
          ),
        ]
      : [];
  });
}

it.each([
  [
    "docs/self-host.md",
    ["init", "deploy", "token", "daily", "pair", "doctor", "sync", "budget"],
  ],
  [
    "docs/runbook/daily.md",
    [
      "daily start",
      "daily report",
      "daily fetch",
      "legacy import",
      "sidecar old-prompt",
      "backup",
      "sync",
    ],
  ],
  [
    "docs/runbook/cutover.md",
    [
      "cutover check",
      "sidecar cutover",
      "sidecar rollback",
      "vault enable-writes",
      "backup",
      "sync",
    ],
  ],
] as const)(
  "parses guide commands documented in %s",
  async (file, expected) => {
    const commands = guideCommands(await readFile(file, "utf8"));
    const values: Record<string, string> = {
      $LEGACY_FROM: "2026-10-20",
      $LEGACY_TO: "2026-11-18",
      $READING_DAY: "2026-11-18",
      $REMAINING: "1000",
      $OLD_DONE_AT: "2026-11-19T02:39:00.000Z",
      $VAULT: "/vault",
      $DIGEST_CLIENT: "claude",
    };
    for (const prefix of expected)
      expect(
        commands.some((args) =>
          (args.join(" ") + " ").startsWith(prefix + " "),
        ),
        prefix,
      ).toBe(true);
    for (const args of commands)
      expect(
        () => parseCommand(args.map((arg) => values[arg] ?? arg)),
        args.join(" "),
      ).not.toThrow();
  },
);

it("checks inline and table examples with the CLI parsers", () => {
  const examples = [
    'Run `litscout ideas capture "Research idea"`.',
    "| Working papers | `pnpm exec litscout wp list` |",
    "| Suggestions | `litscout suggestions list --status new` |",
    "Run `litscout sidecar restore --file fixture.json`.",
    'Run `litscout legacy import --repo "/local repo" --dry-run`.',
    "Run `litscout summaries todo`, `litscout digest context` or `litscout weekly`.",
    "Run `litscout watch --since 2026-11-18 --venues venues.json`.",
    "Run `litscout abstracts` or `litscout contracts`.",
    "Run `litscout day reopen 2026-11-18 --dry-run`.",
  ];
  const commands = guideCommands(examples.join("\n"));
  expect(commands).toHaveLength(12);
  for (const args of commands)
    expect(() => parseCommand(args), args.join(" ")).not.toThrow();
  const [invalid] = guideCommands("| Sync | `litscout sync --only invalid` |");
  expect(() => parseCommand(invalid!)).toThrow();
});

it("rejects flags that the selected subcommand does not use", async () => {
  const { deps, run } = await fixture();
  for (const args of [
    ["daily", "status", "--day", "2026-11-18"],
    ["digest", "put", "draft.json", "--day", "2026-11-18"],
    ["digest", "final", "--model", "ignored"],
    ["summaries", "todo", "--parallel", "2"],
    ["summaries", "put", "draft.json", "--model", "ignored"],
    ["sidecar", "restore", "--file", "config.json", "--config", "unused.ts"],
  ]) {
    expect(() => parseCommand(args)).toThrow();
    expect(await run(...args)).toMatchObject({ code: 1, success: false });
  }
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.run).not.toHaveBeenCalled();
  expect(await readdir(deps.cwd)).toEqual([]);
});

it("never consumes dry-run or a dash-prefixed value as a token name", async () => {
  const { deps, run } = await fixture();
  for (const name of ["-scheduler", "--dry-run", "--config"]) {
    const args = ["token", "create", "--name", name, "--scopes", "read"];
    expect(() => parseCommand(args)).toThrow();
    expect(await run(...args)).toMatchObject({ code: 1, success: false });
  }
  for (const args of [
    ["--dry-run", "token", "create", "--name", "scheduler", "--scopes", "read"],
    ["token", "--dry-run", "create", "--name", "scheduler", "--scopes", "read"],
    ["token", "create", "--name", "scheduler", "--scopes", "read", "--dry-run"],
  ]) {
    expect(await run(...args)).toMatchObject({
      code: 0,
      data: { name: "scheduler", commands: expect.any(Array) },
    });
  }
  expect(deps.run).not.toHaveBeenCalled();
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.prompt).not.toHaveBeenCalled();
  expect(await readdir(deps.cwd)).toEqual([]);
});

it("reports invalid doctor config with global options first", async () => {
  const { deps } = await fixture();
  const file = path.join(deps.cwd, "invalid.ts");
  await writeFile(
    file,
    'export default { instance: { publicUrl: "invalid" } };',
  );
  const print = vi.fn();
  expect(
    await runCommand(["--json", "--config", file, "doctor"], {
      ...deps,
      loadConfig: undefined,
      print,
    }),
  ).toBe(1);
  expect(JSON.parse(print.mock.calls[0]![0])).toMatchObject({
    success: false,
    meta: { configPath: await realpath(file) },
    data: { configValid: false, hint: expect.any(String) },
  });
});

it("skips summaries and digest before credentials, requests, or agent preflight in no-LLM mode", async () => {
  const { deps, run } = await fixture();
  for (const args of [
    ["summaries", "run"],
    ["summaries", "todo"],
    ["digest", "run", "--final"],
    ["digest", "final"],
    ["digest", "context"],
    ["digest", "put", "draft.json"],
    ["weekly"],
  ]) {
    const result = await run(...args);
    expect(result).toMatchObject({
      code: 0,
      data: { status: "skipped-no-llm" },
    });
  }
  expect((await run("digest", "unknown")).code).toBe(1);
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.flow.agent).not.toHaveBeenCalled();
  expect(deps.flow.preflight).not.toHaveBeenCalled();
  expect(await readdir(deps.cwd)).toEqual([]);
  deps.fetch.mockResolvedValue(Response.json({ success: true, data: [] }));
  const status = await run("daily", "status");
  expect(Array.isArray(status.data)).toBe(true);
});

it("previews deploy and token creation without generating credentials or writing remotely", async () => {
  const { deps, run } = await fixture();
  deps.run.mockResolvedValue("[]");
  const deploy = await run("deploy", "--skip-keys", "--dry-run");
  expect(deploy.code).toBe(0);
  expect(deploy.data.commands.join("\n")).toMatch(
    /secret bulk.*\n.*MGMT_TOKEN/s,
  );
  expect(deploy.data.commands.join("\n")).toMatch(/litscout:venues/);
  const token = await run(
    "token",
    "create",
    "--dry-run",
    "--name",
    "scheduler",
    "--scopes",
    "read,ingest,vault",
    "--expires-in",
    "30",
  );
  expect(token).toMatchObject({
    code: 0,
    data: { name: "scheduler", scopes: ["read", "ingest", "vault"] },
  });
  expect(token.data.commands.join("\n")).toMatch(
    /d1 execute test-db.*INSERT INTO api_tokens/,
  );
  expect(token.data.token).toBeUndefined();
  expect(deps.run.mock.calls).toEqual([[["d1", "list", "--json"]]]);
  expect(deps.fetch).not.toHaveBeenCalled();
  expect(deps.prompt).not.toHaveBeenCalled();
  expect(await readdir(deps.cwd)).toEqual([]);
});

it("doctor checks the live bindings, schema and both required scopes using the selected token", async () => {
  const { deps, run } = await fixture();
  deps.run.mockImplementation(async (args) =>
    args[0] === "--version"
      ? "4.151.0"
      : args[0] === "whoami"
        ? "private identity"
        : "{}",
  );
  deps.fetch.mockImplementation(async (input, options) => {
    switch (new URL(String(input)).pathname) {
      case "/health":
        return Response.json({ ok: true });
      case "/api/v1/health":
        expect(new Headers(options?.headers).get("authorization")).toBe(
          `Bearer ${deps.flow.token}`,
        );
        return Response.json({
          success: true,
          data: {
            database: { reachable: true, schemaVersion: SCHEMA_VERSION },
            bindings: { DB: true, OAUTH_KV: true },
          },
        });
      case "/api/v1/budget":
        return Response.json({
          success: true,
          data: {
            day: "2026-11-18",
            used: 0,
            reserved: 0,
            limit: 80000,
            staleLeasesReleased: 0,
            resetAt: "2026-11-19T00:00:00.000Z",
          },
        });
      default:
        throw new Error("Unexpected URL");
    }
  });
  const healthy = await run("doctor");
  expect(healthy).toMatchObject({
    code: 0,
    data: {
      configValid: true,
      checks: {
        node: { ok: true, version: "22.13.0" },
        wrangler: { ok: true },
        worker: { ok: true },
        d1: { ok: true },
        kv: { ok: true },
        schema: { ok: true },
        access: { ok: true },
        token: { ok: true },
        vaultRoot: { ok: true, configured: false },
        vaultExcludes: { ok: true },
        agents: { ok: true },
        vaultWrite: { enabled: false },
      },
    },
  });
  expect(deps.flow.preflight).not.toHaveBeenCalled();
  expect(JSON.stringify(healthy)).not.toContain(deps.flow.token);
  expect(JSON.stringify(healthy)).not.toContain("private identity");
  expect(healthy.data.warnings.join(" ")).not.toContain("vault.root");

  await mkdir(path.join(deps.cwd, "vault"));
  expect((await run("doctor")).data.checks.vaultRoot).toMatchObject({
    ok: true,
    configured: true,
  });

  deps.fetch.mockImplementation(async (input) => {
    switch (new URL(String(input)).pathname) {
      case "/health":
        return Response.json({ ok: false }, { status: 503 });
      case "/api/v1/health":
        return Response.json(
          {
            success: false,
            data: {
              database: { reachable: true, schemaVersion: SCHEMA_VERSION - 1 },
              bindings: { DB: true, OAUTH_KV: false },
            },
          },
          { status: 503 },
        );
      case "/api/v1/budget":
        return Response.json({}, { status: 403 });
      default:
        throw new Error("Unexpected URL");
    }
  });
  const failed = await run("doctor");
  expect(failed.code).toBe(1);
  for (const check of ["kv", "schema", "token"]) {
    expect(failed.data.checks[check]).toMatchObject({
      ok: false,
      hint: expect.any(String),
    });
  }
});

it("doctor gives hints for inconsistent Access, vault excludes and unavailable clients", async () => {
  const { deps } = await fixture();
  const print = vi.fn();
  deps.run.mockImplementation(async (args) =>
    args[0] === "--version" ? "4.151.0" : "You are not authenticated.",
  );
  deps.flow.preflight.mockImplementation(async (client) => ({
    client,
    usable: false,
    reason: "keychain unavailable",
  }));
  expect(
    await runCommand(["doctor", "--json"], {
      ...deps,
      nodeVersion: "22.12.0",
      print,
      loadConfig: async () =>
        defineConfig({
          access: { teamDomain: "test.cloudflareaccess.com" },
          vault: { exclude: ["../private/**"], write: true },
        }),
    }),
  ).toBe(1);
  const { data } = JSON.parse(print.mock.calls[0]![0]);
  for (const check of ["wranglerLogin", "access", "vaultExcludes", "agents"])
    expect(data.checks[check]).toMatchObject({
      ok: false,
      hint: expect.any(String),
    });
  expect(data.checks.vaultWrite.enabled).toBe(true);
  expect(data.checks.vaultRoot).toMatchObject({ ok: true, configured: false });
  expect(data.warnings.join(" ")).toContain("vault.root");
  expect(data.checks.node).toMatchObject({ ok: false, version: "22.12.0" });
  expect(data.agentChecks).toContainEqual({
    client: "claude",
    reason: "keychain unavailable",
    usable: false,
    hint: expect.any(String),
  });
  expect(deps.fetch).not.toHaveBeenCalled();
});

it("makes Shadow mode the runbook's default, skipped only by the cutover prompt's words", async () => {
  // 2026-11-19: the runbook said "when the scheduler uses the shadow prompt",
  // the scheduled agent read the plain pointer as "only LitScout", and the old
  // pipeline did not run at 10:20 or 12:20.
  const { readFile } = await import("node:fs/promises");
  // Line wrapping in the Markdown source does not matter to the reader.
  const runbook = (
    await readFile(
      new URL("../../../docs/runbook/daily.md", import.meta.url),
      "utf8",
    )
  ).replace(/\s+/g, " ");
  const sidecar = await readFile(
    new URL("../src/sidecar-command.ts", import.meta.url),
    "utf8",
  );
  const skip = "Run only LitScout";
  expect(sidecar).toContain(skip);
  const commandOrder = runbook.slice(runbook.indexOf("## Command order"));
  expect(commandOrder.slice(0, 1200)).toMatch(
    new RegExp(`Unless the scheduler prompt contains the words "${skip}`),
  );
  expect(runbook).toContain(
    "Shadow mode is the default until the owner approves cutover",
  );
  expect(runbook).not.toContain("When the scheduler uses the shadow prompt");
});
