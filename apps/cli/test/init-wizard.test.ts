import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseWatchList } from "@litscout/sources/watch/watchlist";
import type { Client } from "@litscout/core";
import { runCommand, type SetupDeps } from "../src/setup-commands";
import { loadConfig } from "../src/config-loader";

// `litscout init` in a terminal asks a few questions and writes a config for
// the answers: no one starts from another reader's topics, time zone or
// venues. Scripts and --json still get the plain starter files.
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function harness(
  answers: string[],
  { signedIn = ["claude"] as Client[], isTTY = true } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "litscout-init-"));
  dirs.push(root);
  const cwd = path.join(root, "etc");
  await import("node:fs/promises").then((fs) => fs.mkdir(cwd));
  const out: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  const prompt = vi.fn(async (label: string) => {
    asked.push(label);
    if (!queue.length) throw new Error(`No answer left for "${label}"`);
    return queue.shift()!;
  });
  const deps = {
    isTTY,
    cwd,
    dir: path.join(root, "state"),
    home: root,
    timeZone: () => "Europe/Berlin",
    templateDir: path.resolve("templates/self-host"),
    flow: {
      preflight: async (client: Client) => ({
        client,
        usable: signedIn.includes(client),
        reason: signedIn.includes(client) ? "signed in" : "not found",
      }),
    },
    run: vi.fn(),
    fetch: vi.fn(),
    fetchVenues: vi.fn(),
    prompt,
    print: (text: string) => out.push(text),
  } as unknown as SetupDeps;
  return { root, cwd, deps, out, asked, prompt, queue };
}
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

it("sets up a trial on this computer from the reader's own answers", async () => {
  const h = await harness([
    "", // where: 1, a trial on this computer
    "", // time zone: the detected one
    "zh",
    "3, cs.LG",
    "Depth",
    "monocular depth, stereo matching",
    "Speech",
    "speech recognition",
    "", // no third topic
    "", // use Claude Code: yes
    "2, 3",
  ]);
  expect(await runCommand(["init"], h.deps)).toBe(0);
  expect(h.queue).toEqual([]);

  const { config } = await loadConfig(h.cwd);
  expect(config.instance).toMatchObject({
    publicUrl: "http://127.0.0.1:8787",
    timezone: "Europe/Berlin",
    language: "zh",
    publicFeed: false,
  });
  expect(config.sources.arxiv.categories).toEqual(["cs.CV", "cs.LG"]);
  expect(config.topics).toEqual([
    { name: "Depth", keywords: ["monocular depth", "stereo matching"] },
    { name: "Speech", keywords: ["speech recognition"] },
  ]);
  expect(config.agent).toMatchObject({
    mode: "client",
    summaries: { client: "claude", fallback: [] },
    digest: { client: "claude", fallback: [] },
  });

  // The chosen areas' venues, in a watch list the crawler reads cleanly.
  const warnings: string[] = [];
  const venues = parseWatchList(
    await readFile(path.join(h.cwd, "venues.json"), "utf8"),
    (text) => warnings.push(text),
  );
  expect(warnings).toEqual([]);
  expect(venues.map((v) => v.name)).toEqual(
    expect.arrayContaining(["CVPR", "ECCV", "ACL", "TACL"]),
  );
  expect(venues.map((v) => v.name)).not.toContain("NeurIPS");

  // A trial is ready to start: the server's settings are written too.
  const server = JSON.parse(
    await readFile(path.join(h.root, "litscout", "etc", "server.json"), "utf8"),
  );
  expect(server).toMatchObject({ local: true, port: 8787 });
  expect(await exists(path.join(h.cwd, "cron.md"))).toBe(true);
  const text = h.out.join("\n");
  expect(text).toContain("server.js serve --config");
  expect(text).toContain("litscout daily fetch");
  expect(text).toContain("http://127.0.0.1:8787/app");
});

it("asks again until an answer is usable", async () => {
  const h = await harness(
    [
      "7", // no such choice
      "1",
      "Mars/Base", // not a time zone
      "Asia/Tokyo",
      "", // language: en
      "", // no category yet
      "cs.!!", // not a category
      "cs.RO",
      "", // a topic is required
      "Grasping",
      "", // a keyword is required
      "grasp",
      "",
      "", // no venues
    ],
    { signedIn: [] },
  );
  expect(await runCommand(["init"], h.deps)).toBe(0);
  expect(h.queue).toEqual([]);
  const { config } = await loadConfig(h.cwd);
  expect(config.instance.timezone).toBe("Asia/Tokyo");
  expect(config.sources.arxiv.categories).toEqual(["cs.RO"]);
  expect(config.topics).toEqual([{ name: "Grasping", keywords: ["grasp"] }]);
  // No signed-in agent CLI: keyword mode, and the way to turn summaries on.
  expect(config.agent.mode).toBe("none");
  expect(h.out.join("\n")).toMatch(/keyword mode/i);
  expect(
    JSON.parse(await readFile(path.join(h.cwd, "venues.json"), "utf8")),
  ).toEqual({ venues: [] });
});

it("writes a config for Cloudflare or a server without starting a trial", async () => {
  const h = await harness([
    "3",
    "https://litscout.example.org/?from=mail", // not an origin
    "https://litscout.example.org/",
    "",
    "",
    "cs.CL",
    "Parsing",
    "dependency parsing",
    "",
    "n", // no agent, though Claude Code is signed in
    "2, 2", // an area named twice
  ]);
  expect(await runCommand(["init"], h.deps)).toBe(0);
  const { config } = await loadConfig(h.cwd);
  expect(config.instance.publicUrl).toBe("https://litscout.example.org");
  expect(config.agent.mode).toBe("none");
  expect(await exists(path.join(h.root, "litscout"))).toBe(false);
  expect(h.out.join("\n")).toContain("docs/self-host-server.md");
  const names = JSON.parse(
    await readFile(path.join(h.cwd, "venues.json"), "utf8"),
  ).venues.map((v: { name: string }) => v.name);
  expect(names).toEqual([...new Set(names)]);
  expect(names).toContain("CVPR");
});

it("never asks when it would overwrite, in a script, or with --defaults", async () => {
  const h = await harness([]);
  await writeFile(path.join(h.cwd, "litscout.config.ts"), "keep me");
  expect(await runCommand(["init"], h.deps)).toBe(1);
  expect(h.prompt).not.toHaveBeenCalled();
  expect(await readFile(path.join(h.cwd, "litscout.config.ts"), "utf8")).toBe(
    "keep me",
  );

  for (const [args, isTTY] of [
    [["init", "--json"], true],
    [["init", "--defaults"], true],
    [["init"], false],
  ] as const) {
    const plain = await harness([], { isTTY });
    expect(await runCommand([...args], plain.deps)).toBe(0);
    expect(plain.prompt).not.toHaveBeenCalled();
    // The neutral starter, ready to edit by hand.
    expect(
      await readFile(path.join(plain.cwd, "litscout.config.ts"), "utf8"),
    ).toContain('timezone: "UTC"');
  }
});

it("says how to finish when the trial's server settings already exist", async () => {
  const h = await harness([
    "",
    "",
    "",
    "cs.LG",
    "Optimisation",
    "convex",
    "",
    "",
    "",
  ]);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(h.root, "litscout", "etc"), { recursive: true });
  await writeFile(path.join(h.root, "litscout", "etc", "server.json"), "{}");
  expect(await runCommand(["init"], h.deps)).toBe(0);
  const text = h.out.join("\n");
  expect(text).toMatch(/server settings were not written: .*exists/);
  expect(text).toContain("litscout server init --local --force");
  // The config is written either way; the old server settings are kept.
  expect((await loadConfig(h.cwd)).config.topics[0]!.name).toBe("Optimisation");
  expect(
    await readFile(path.join(h.root, "litscout", "etc", "server.json"), "utf8"),
  ).toBe("{}");
});
