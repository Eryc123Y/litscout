import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@litscout/core";
import { runCommand } from "../src/setup-commands";
import { loadConfig } from "../src/config-loader";
import { wranglerLine } from "../src/runtime";
import { doctorResponse } from "./helpers/doctor";
const dirs: string[] = [];
async function harness() {
  const dir = await mkdtemp(path.join(tmpdir(), "litscout-setup-"));
  dirs.push(dir);
  const out: string[] = [];
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
      bundlePath: path.resolve("packages/db/worker.js"),
      nodeVersion: "22.13.0",
      templateDir: path.resolve("templates/self-host"),
      run: vi.fn(async (_args: readonly string[]) => "[]"),
      fetch: vi.fn(async (input: RequestInfo | URL) => doctorResponse(input)),
      fetchVenues: vi.fn(),
      prompt: vi.fn(),
      print: (s: string) => out.push(s),
      loadConfig: async () =>
        defineConfig({
          instance: { name: "sample", publicUrl: "https://sample.example" },
        }),
    },
  };
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
it("initialises config and venues without overwriting either existing file", async () => {
  const h = await harness();
  expect(await runCommand(["init", "--json"], h.deps)).toBe(0);
  expect(JSON.parse(h.out[0]!)).toMatchObject({ success: true });
  expect(
    await readFile(path.join(h.dir, "litscout.config.ts"), "utf8"),
  ).toContain("defineConfig");
  expect(await runCommand(["init"], h.deps)).toBe(1);
  expect(h.deps.run).not.toHaveBeenCalled();
});
it("loads upward and reports all invalid field paths", async () => {
  const h = await harness();
  await writeFile(
    path.join(h.dir, "litscout.config.ts"),
    'export default { instance: { publicUrl: "bad" }, storage: { fullDays: -1 } };',
  );
  await mkdir(path.join(h.dir, "child"));
  await expect(loadConfig(path.join(h.dir, "child"))).rejects.toThrow(
    /instance.publicUrl[\s\S]*storage.fullDays/,
  );
  await writeFile(
    path.join(h.dir, "litscout.config.ts"),
    "export default { storage: { fullDays: 30 } };",
  );
  expect((await loadConfig(h.dir)).config.storage.fullDays).toBe(30);
});
it("prints the deployment plan after a read-only database lookup", async () => {
  const h = await harness();
  expect(
    await runCommand(
      ["deploy", "--name", "custom", "--dry-run", "--json"],
      h.deps,
    ),
  ).toBe(0);
  const result = JSON.parse(h.out[0]!);
  expect(
    result.data.commands.filter((line: string) =>
      line.startsWith("wrangler whoami"),
    ),
  ).toHaveLength(3);
  expect(result.data.migrations).toContainEqual({
    name: "0017_write_cost.sql",
    estimatedRows: 256,
  });
  expect(JSON.stringify(result)).toContain("d1 create custom-db");
  expect(JSON.stringify(result)).toContain("kv namespace create");
  expect(JSON.stringify(result)).toContain("secret bulk");
  expect(JSON.stringify(result)).toContain("deploy --config");
  expect(h.deps.run.mock.calls).toEqual([[["d1", "list", "--json"]]]);
  expect(h.deps.fetch).not.toHaveBeenCalled();
});
it("creates a token once, sends only its hash to D1, and writes mode 600 credentials", async () => {
  const h = await harness();
  expect(
    await runCommand(
      [
        "token",
        "create",
        "--name",
        "local-test",
        "--scopes",
        "ingest,read",
        "--json",
      ],
      h.deps,
    ),
  ).toBe(0);
  const result = JSON.parse(h.out[0]!);
  const token = result.data.token;
  expect(token).toMatch(/^lsk_[A-Z2-7]{52}$/);
  const calls = JSON.stringify(h.deps.run.mock.calls);
  expect(calls).not.toContain(token);
  expect(calls).toMatch(/[a-f0-9]{64}/);
  expect(calls).toContain("--remote");
  const file = path.join(h.dir, "credentials.json");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readFile(file, "utf8")).toContain(token);
  expect(h.out.join("").split(token)).toHaveLength(2);
});
it("rejects token SQL injection and invalid scopes before the runner", async () => {
  const h = await harness();
  for (const args of [
    [
      "token",
      "create",
      "--name",
      "x';DROP TABLE papers;--",
      "--scopes",
      "read",
    ],
    ["token", "create", "--name", "ok", "--scopes", "admin"],
    ["token", "revoke", "tok_bad';drop"],
  ])
    expect(await runCommand(args, h.deps)).toBe(1);
  expect(h.deps.run).not.toHaveBeenCalled();
});
it("lists and revokes tokens, returning 2 when nothing changes", async () => {
  const h = await harness();
  h.deps.run.mockResolvedValue(
    JSON.stringify([
      {
        results: [
          {
            id: "tok_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            name: "test",
            scopes: '["read"]',
          },
        ],
      },
    ]),
  );
  expect(await runCommand(["token", "list", "--json"], h.deps)).toBe(0);
  h.deps.run.mockResolvedValue(JSON.stringify([{ results: [] }]));
  expect(await runCommand(["token", "list", "--json"], h.deps)).toBe(2);
  expect(
    await runCommand(
      ["token", "revoke", "tok_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
      h.deps,
    ),
  ).toBe(2);
});
it("doctor reports usage warnings and never prints whoami output", async () => {
  const h = await harness();
  await mkdir(path.join(h.dir, "vault"));
  h.deps.run.mockImplementation(async (args) =>
    args[0] === "--version"
      ? "4.151.0"
      : args[0] === "whoami"
        ? "private identity"
        : JSON.stringify({
            database_size: 310_000_000,
            rows_read_24h: 3_600_000,
            rows_written_24h: 71_000,
          }),
  );
  expect(await runCommand(["doctor", "--json"], h.deps)).toBe(0);
  expect(h.out.join("")).not.toContain("private identity");
  expect(h.out.join("")).toContain("300 MB");
  expect(h.out.join("")).toContain("70%");
});
it("doctor reports failed checks without printing upstream details", async () => {
  const h = await harness();
  h.deps.run.mockRejectedValue(new Error("private identity"));
  expect(await runCommand(["doctor", "--json"], h.deps)).toBe(1);
  expect(h.out.join("")).not.toContain("private identity");
});
it.each([false, true])(
  "matches the deploy preview with the runner (login retry: %s)",
  async (retryLogin) => {
    const h = await harness();
    let lists = 0;
    let identityChecks = 0;
    h.deps.run.mockImplementation(async (args) => {
      if (args[0] === "whoami" && ++identityChecks === 2 && retryLogin)
        return "Not authenticated";
      if (args[0] === "d1" && args[1] === "list")
        return JSON.stringify(
          lists++ === 0
            ? []
            : [{ name: "custom-db", uuid: "synthetic-database" }],
        );
      if (args[0] === "kv" && args.includes("create"))
        return '{"id":"synthetic-namespace"}';
      if (args[1] === "execute") return '[{"success":true,"results":[]}]';
      if (args[0] === "deploy") return "https://sample.example";
      return "Authenticated";
    });
    h.deps.prompt.mockResolvedValue("");
    h.deps.fetchVenues.mockResolvedValue({
      downloaded_at: "2026-11-17",
      venues: [],
    });
    expect(
      await runCommand(
        ["deploy", "--name", "custom", "--dry-run", "--json"],
        h.deps,
      ),
    ).toBe(0);
    const plan: string[] = JSON.parse(h.out[0]!).data.commands;
    expect(h.deps.run.mock.calls).toEqual([[["d1", "list", "--json"]]]);
    h.deps.run.mockClear();
    lists = 0;
    expect(h.deps.prompt).not.toHaveBeenCalled();
    expect(h.deps.fetchVenues).not.toHaveBeenCalled();
    expect(
      await runCommand(["deploy", "--name", "custom", "--json"], h.deps),
    ).toBe(0);
    const preview = plan
      .filter(
        (line) =>
          line.startsWith("wrangler ") &&
          (retryLogin || !line.includes(" # if the recheck fails")),
      )
      .map((line) => line.split(" # ")[0]);
    const executed = h.deps.run.mock.calls
      .filter(([args]) => args[1] !== "execute")
      .map(([args]) =>
        wranglerLine(
          args[0] === "secret"
            ? args.map((arg, index) =>
                index === 2 ? "PRIVATE_TEMP_FILE" : arg,
              )
            : args.map((arg) =>
                arg === "synthetic-namespace" ? "KV_NAMESPACE_ID" : arg,
              ),
        ),
      );
    expect(preview).toEqual(executed);
    const config = JSON.parse(
      await readFile(path.join(h.dir, "wrangler.jsonc"), "utf8"),
    );
    expect(config.d1_databases[0]).toMatchObject({
      binding: "DB",
      database_name: "custom-db",
      database_id: "synthetic-database",
    });
    expect(config.assets.binding).toBe("ASSETS");
    h.deps.run.mockImplementation(async (args) =>
      args[0] === "d1" && args[1] === "execute"
        ? '[{"results":[]}]'
        : "Authenticated",
    );
    // A Worker without the admin token routes: token commands use Wrangler
    // against the deployed database.
    h.deps.fetch.mockImplementation(async (input: RequestInfo | URL) =>
      String(input).includes("/admin/tokens")
        ? new Response("Not found", { status: 404 })
        : doctorResponse(input),
    );
    expect(await runCommand(["token", "list", "--json"], h.deps)).toBe(2);
    expect(h.deps.run.mock.calls.at(-1)?.[0].slice(0, 3)).toEqual([
      "d1",
      "execute",
      "custom-db",
    ]);
    const calls = h.deps.run.mock.calls.map((c) => c[0].join(" "));
    const applied = calls.findIndex((c) =>
      c.includes("INSERT INTO d1_migrations"),
    );
    expect(applied).toBeGreaterThanOrEqual(0);
    expect(applied).toBeLessThan(
      calls.findIndex((c) => c.startsWith("deploy")),
    );
  },
);
it("loads the generated template from a child directory", async () => {
  const h = await harness();
  await runCommand(["init"], h.deps);
  await mkdir(path.join(h.dir, "nested"));
  expect(
    (await loadConfig(path.join(h.dir, "nested"))).config.instance.name,
  ).toBe("LitScout");
  await writeFile(
    path.join(h.dir, "litscout.config.ts"),
    'import {defineConfig} from "@litscout/core"; export default defineConfig({storage:{fullDays:-1},instance:{publicUrl:"bad"}});',
  );
  await expect(loadConfig(h.dir)).rejects.toThrow(
    /instance.publicUrl[\s\S]*storage.fullDays/,
  );
});
