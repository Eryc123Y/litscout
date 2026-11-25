import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runCommand, type SetupDeps } from "../src/setup-commands";

// `server init` prepares an own server from litscout.config.ts: the
// LitScout folder, etc/server.json with the Worker's vars, etc/secrets.env
// with new secrets, and the CLI state that `token create` reads. Nothing on
// Cloudflare is needed.
const config = `export default {
  instance: { publicUrl: "https://api.example.org", name: "Lab radar", timezone: "Europe/Berlin" },
  access: { teamDomain: "lab.cloudflareaccess.com", aud: "aud-123" },
  topics: [{ name: "Vision", keywords: ["stereo"] }],
  storage: { fullDays: 60 },
};`;
async function setup(
  run: (paths: { work: string; base: string; state: string }) => Promise<void>,
) {
  const work = await mkdtemp(join(tmpdir(), "litscout-server-init-"));
  try {
    await writeFile(join(work, "litscout.config.ts"), config);
    await run({
      work,
      base: join(work, "litscout"),
      state: join(work, "cli-state"),
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
const deps = (work: string, state: string, print = vi.fn()) =>
  ({
    dir: state,
    cwd: work,
    print,
    templateDir: join(work, "cli-dist", "templates"),
  }) as unknown as SetupDeps;
const init = (work: string, base: string, state: string, ...flags: string[]) =>
  runCommand(
    ["server", "init", "--base", base, ...flags, "--json"],
    deps(work, state),
  );
const mode = async (file: string) => (await stat(file)).mode & 0o777;
const readJson = async (file: string) =>
  JSON.parse(await readFile(file, "utf8"));

it("writes the server's settings, new secrets and the CLI state", async () => {
  await setup(async ({ work, base, state }) => {
    expect(await init(work, base, state)).toBe(0);
    const server = await readJson(join(base, "etc/server.json"));
    expect(server).toEqual({
      host: "127.0.0.1",
      port: 8787,
      app: join(base, "current/dist"),
      state: join(base, "state"),
      secretsFile: "secrets.env",
      cronUtc: "02:00",
      vars: expect.objectContaining({
        PUBLIC_URL: "https://api.example.org",
        WRITE_LIMIT: "1000000",
        ACCESS_TEAM_DOMAIN: "lab.cloudflareaccess.com",
        ACCESS_AUD: "aud-123",
        HEALTH_ON_TIME_BY: expect.any(String),
        MCP_RESEARCH_TOOLS: expect.any(String),
      }),
    });
    expect(JSON.parse(server.vars.INSTANCE_CONFIG)).toMatchObject({
      name: "Lab radar",
      timezone: "Europe/Berlin",
      topics: ["Vision"],
    });
    expect(JSON.parse(server.vars.STORAGE_CONFIG)).toMatchObject({
      fullDays: 60,
    });
    const secrets = await readFile(join(base, "etc/secrets.env"), "utf8");
    const token = secrets.match(/^MGMT_TOKEN=(\S{64,})$/m)?.[1];
    expect(token).toBeTruthy();
    expect(secrets).toMatch(/^CONSENT_SECRET=\S{64,}$/m);
    expect(await mode(join(base, "etc/secrets.env"))).toBe(0o600);
    expect(await mode(join(base, "etc/server.json"))).toBe(0o600);
    for (const folder of ["state", "logs", "backups", "releases", "etc"])
      expect(await mode(join(base, folder))).toBe(0o700);
    expect(await readJson(join(state, "state.json"))).toEqual({
      name: "litscout",
      token,
      consentSecret: secrets.match(/^CONSENT_SECRET=(\S+)$/m)?.[1],
      endpoint: "https://api.example.org",
    });
  });
});

it("keeps the secrets on --force and refuses to overwrite without it", async () => {
  await setup(async ({ work, base, state }) => {
    expect(await init(work, base, state)).toBe(0);
    const secrets = await readFile(join(base, "etc/secrets.env"), "utf8");
    expect(await init(work, base, state)).not.toBe(0);
    await writeFile(
      join(work, "litscout.config.ts"),
      config.replace("Lab radar", "Renamed radar"),
    );
    expect(await init(work, base, state, "--force")).toBe(0);
    expect(await readFile(join(base, "etc/secrets.env"), "utf8")).toBe(secrets);
    const server = await readJson(join(base, "etc/server.json"));
    expect(JSON.parse(server.vars.INSTANCE_CONFIG).name).toBe("Renamed radar");
  });
});

it("never replaces CLI state that holds another management token", async () => {
  await setup(async ({ work, base, state }) => {
    await runCommand(
      ["server", "init", "--base", base, "--json"],
      deps(work, state),
    );
    await writeFile(
      join(state, "state.json"),
      JSON.stringify({ name: "litscout", token: "other-token" }),
    );
    await rm(join(base, "etc"), { recursive: true });
    const print = vi.fn();
    expect(
      await runCommand(
        ["server", "init", "--base", base, "--json"],
        deps(work, state, print),
      ),
    ).not.toBe(0);
    expect(print.mock.calls.flat().join("\n")).toMatch(/state\.json/);
  });
});

it("previews without writing or showing secrets, and needs an https address", async () => {
  await setup(async ({ work, base, state }) => {
    const print = vi.fn();
    expect(
      await runCommand(
        ["server", "init", "--base", base, "--dry-run", "--json"],
        deps(work, state, print),
      ),
    ).toBe(0);
    const out = print.mock.calls.flat().join("\n");
    expect(JSON.parse(out).data).toMatchObject({
      dryRun: true,
      files: expect.arrayContaining([join(base, "etc/server.json")]),
    });
    expect(out).not.toMatch(/MGMT_TOKEN=|CONSENT_SECRET=/);
    await expect(stat(base)).rejects.toThrow();
    await writeFile(
      join(work, "litscout.config.ts"),
      config.replace("https://api.example.org", "http://api.example.org"),
    );
    expect(await init(work, base, state)).not.toBe(0);
  });
});

it("prepares a trial on this computer with --local", async () => {
  await setup(async ({ work, base, state }) => {
    const local = (url: string) =>
      writeFile(
        join(work, "litscout.config.ts"),
        config
          .replace("https://api.example.org", url)
          .replace(/  access: .*\n/, ""),
      );
    await local("http://127.0.0.1:9123");
    // A loopback address is a trial: say how to ask for one.
    const print = vi.fn();
    expect(
      await runCommand(
        ["server", "init", "--base", base, "--json"],
        deps(work, state, print),
      ),
    ).not.toBe(0);
    expect(print.mock.calls.flat().join("\n")).toMatch(/--local/);
    expect(await init(work, base, state, "--local")).toBe(0);
    const server = await readJson(join(base, "etc/server.json"));
    expect(server).toMatchObject({
      local: true,
      host: "127.0.0.1",
      port: 9123,
      // The build this CLI runs from: a trial has no release folder.
      app: join(work, "cli-dist"),
      state: join(base, "state"),
      vars: { PUBLIC_URL: "http://127.0.0.1:9123" },
    });
    expect(server.vars).not.toHaveProperty("ACCESS_AUD");
    expect(await readJson(join(state, "state.json"))).toMatchObject({
      endpoint: "http://127.0.0.1:9123",
    });
  });
});

it("refuses --local for an address that is not this computer", async () => {
  await setup(async ({ work, base, state }) => {
    const print = vi.fn();
    expect(
      await runCommand(
        ["server", "init", "--base", base, "--local", "--json"],
        deps(work, state, print),
      ),
    ).not.toBe(0);
    expect(print.mock.calls.flat().join("\n")).toMatch(
      /http:\/\/127\.0\.0\.1:8787/,
    );
    await expect(stat(base)).rejects.toThrow();
  });
});
