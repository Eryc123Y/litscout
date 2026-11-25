import { mkdtemp, readFile, stat, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli, type CliDeps } from "../src/commands";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function setup() {
  await mkdir(".artifacts", { recursive: true });
  const dir = await mkdtemp(path.resolve(".artifacts/cli-"));
  dirs.push(dir);
  const secrets: unknown[] = [];
  const run = vi.fn(async (args: readonly string[]): Promise<string> => {
    if (args.includes("bulk")) {
      const file = args[2]!;
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      secrets.push(JSON.parse(await readFile(file, "utf8")));
    }
    if (args.includes("create")) return '{"id":"synthetic-namespace"}';
    if (args[0] === "deploy") return "https://litscout.example";
    return "Authenticated";
  });
  const output: string[] = [];
  const deps: CliDeps = {
    isTTY: true,
    fetchVenues: vi.fn(async () => ({
      downloaded_at: "2026-11-11",
      venues: [],
    })),
    dir,
    bundlePath: path.resolve("dist/worker.js"),
    run,
    prompt: vi.fn(async (label) =>
      label.includes("Delete")
        ? "yes"
        : label.includes("name")
          ? "litscout"
          : "synthetic-secret",
    ),
    fetch: vi.fn(async () =>
      Response.json({
        code: "ABCD2345",
        clients: [],
        endpoint: "https://litscout.example/mcp",
      }),
    ),
    print: (text) => {
      output.push(text);
    },
  };
  return { deps, run, dir, secrets, output };
}
it.each(["download", "KV put"] as const)(
  "R6 keeps deploy going and reports a redacted %s failure",
  async (step) => {
    const h = await setup(),
      original = h.run.getMockImplementation()!;
    const hidden = "private upstream response " + "lsk_" + "Q".repeat(52);
    if (step === "download")
      vi.mocked(h.deps.fetchVenues).mockRejectedValue(
        Object.assign(new Error(hidden), { status: 503 }),
      );
    else
      h.run.mockImplementation(async (args) => {
        if (args[0] === "kv" && args.includes("put"))
          throw Object.assign(new Error(hidden), { code: "ETIMEDOUT" });
        return original(args);
      });
    await runCli(["deploy"], h.deps);
    expect(h.output.join("\n")).toContain(`${step} failed`);
    expect(h.output.join("\n")).toContain(
      step === "download" ? "HTTP 503" : "ETIMEDOUT",
    );
    expect(h.output.join("\n")).not.toContain(hidden);
    expect(
      h.run.mock.calls.filter(([args]) => args[0] === "deploy"),
    ).toHaveLength(2);
  },
);
it("deploys with a private state/config and private temporary secrets, bundling a real worker path", async () => {
  const { deps, run, dir, secrets, output } = await setup();
  await runCli(["deploy"], deps);
  const state = JSON.parse(
    await readFile(path.join(dir, "state.json"), "utf8"),
  );
  expect(state.token.length).toBeGreaterThanOrEqual(32);
  expect(state.endpoint).toBe("https://litscout.example");
  expect((await stat(path.join(dir, "state.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(secrets).toEqual([
    expect.objectContaining({
      MGMT_TOKEN: state.token,
      S2_API_KEY: "synthetic-secret",
      CONSENT_SECRET: expect.any(String),
    }),
  ]);
  expect(JSON.stringify(run.mock.calls)).not.toContain("synthetic-secret");
  expect(output.join("")).not.toContain(state.token);
  expect((await readdir(dir)).some((f) => f.startsWith("secrets-"))).toBe(
    false,
  );
  const config = JSON.parse(
    await readFile(path.join(dir, "wrangler.jsonc"), "utf8"),
  );
  expect(config.main).toBe(deps.bundlePath);
  expect(config.vars.PUBLIC_URL).toBe(state.endpoint);
});
it("checks authentication and supports login only through the injected Wrangler runner", async () => {
  const { deps, run } = await setup();
  run.mockRejectedValueOnce(new Error("unauthenticated"));
  await runCli(["deploy"], deps);
  expect(run.mock.calls.some(([args]) => args[0] === "login")).toBe(true);
});
it("cleans secret files on failure and retains resumable local state", async () => {
  const { deps, dir, run } = await setup();
  run.mockImplementation(async (args) => {
    if (args.includes("bulk")) throw new Error("failed");
    if (args.includes("create")) return '{"id":"synthetic-namespace"}';
    return "Authenticated";
  });
  await expect(runCli(["deploy"], deps)).rejects.toThrow();
  expect((await readdir(dir)).some((f) => f.startsWith("secrets-"))).toBe(
    false,
  );
  expect(
    JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"))
      .namespaceId,
  ).toBe("synthetic-namespace");
});
it("pairs, lists, revokes and requests status using the stored Bearer token", async () => {
  const { deps, output } = await setup();
  await runCli(["deploy"], deps);
  for (const command of [
    ["pair"],
    ["clients"],
    ["revoke", "client"],
    ["status"],
  ])
    await runCli(command, deps);
  expect(
    vi
      .mocked(deps.fetch)
      .mock.calls.map(([url]) => new URL(String(url)).pathname),
  ).toEqual([
    "/admin/pair",
    "/admin/clients",
    "/admin/revoke",
    "/admin/status",
  ]);
  expect(output.join("\n")).toContain("ABCD2345");
  await expect(runCli(["revoke"], deps)).rejects.toThrow("id");
  vi.mocked(deps.fetch).mockResolvedValueOnce(
    new Response("secret echo", { status: 401 }),
  );
  await expect(runCli(["status"], deps)).rejects.toThrow("401");
});
it("rotates only source keys and destroys only after confirmation", async () => {
  const { deps, run, secrets, dir } = await setup();
  await runCli(["deploy"], deps);
  await runCli(["keys"], deps);
  expect(secrets[1]).not.toHaveProperty("MGMT_TOKEN");
  vi.mocked(deps.prompt).mockResolvedValueOnce("no");
  await runCli(["destroy"], deps);
  expect(run.mock.calls.some(([a]) => a[0] === "delete")).toBe(false);
  vi.mocked(deps.prompt).mockResolvedValueOnce("yes");
  await runCli(["destroy"], deps);
  expect(run.mock.calls.some(([a]) => a[0] === "delete")).toBe(true);
  expect(run.mock.calls.some(([a]) => a.includes("--namespace-id"))).toBe(true);
  await expect(readFile(path.join(dir, "state.json"))).rejects.toThrow();
});
it("prints help, rejects key arguments, and refuses commands before deployment", async () => {
  const { deps, output } = await setup();
  await runCli([], deps);
  expect(output.join("")).toContain("deploy");
  await expect(runCli(["pair"], deps)).rejects.toThrow("deploy");
  await expect(runCli(["unknown"], deps)).rejects.toThrow("Unknown");
  await expect(runCli(["keys", "secret"], deps)).rejects.toThrow("arguments");
});

it("selects the deployment endpoint rather than a documentation URL, and resumes without rotating management access", async () => {
  const { deps, run, dir, secrets } = await setup();
  const original = run.getMockImplementation()!;
  run.mockImplementation(async (args) =>
    args[0] === "deploy"
      ? "Documentation: https://docs.example/help\n  https://litscout.example\n"
      : original(args),
  );
  await runCli(["deploy"], deps);
  const token = JSON.parse(
    await readFile(path.join(dir, "state.json"), "utf8"),
  ).token;
  vi.mocked(deps.prompt).mockResolvedValue("");
  await runCli(["deploy"], deps);
  expect(
    JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")),
  ).toMatchObject({ endpoint: "https://litscout.example", token });
  expect(secrets[1]).not.toHaveProperty("CONSENT_SECRET");
  await runCli(["keys"], deps);
  expect(secrets).toHaveLength(2);
});
it("creates fresh pairing state when changing the Worker name and preserves the previous profile", async () => {
  const h = await setup();
  let namespaces = 0;
  h.run.mockImplementation(async (args) => {
    if (args[0] === "kv" && args.includes("create"))
      return JSON.stringify({ id: `synthetic-namespace-${++namespaces}` });
    if (args[0] === "deploy") return "https://litscout.example";
    return "Authenticated";
  });
  await runCli(["deploy"], h.deps);
  const previous = JSON.parse(
    await readFile(path.join(h.dir, "state.json"), "utf8"),
  );
  await runCli(["deploy"], { ...h.deps, workerName: "staging" });
  const next = JSON.parse(
    await readFile(path.join(h.dir, "state.json"), "utf8"),
  );
  expect(namespaces).toBe(2);
  expect(next.name).toBe("staging");
  expect(next.token).not.toBe(previous.token);
  const backup = path.join(h.dir, "state.litscout.json");
  expect(JSON.parse(await readFile(backup, "utf8"))).toEqual(previous);
  expect((await stat(backup)).mode & 0o777).toBe(0o600);
});
