import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { legacyDay } from "./fixtures.mjs";

export const exec = promisify(execFile);
export const root = fileURLToPath(new URL("../../", import.meta.url));
export const cliEntry = path.join(root, "apps/cli/dist/index.js");
const preload = new URL("./cli-preload.mjs", import.meta.url);
const agent = fileURLToPath(new URL("./agent.mjs", import.meta.url));
export const ideaText =
  "---\ntags: [type/idea]\n---\nCompare the fixture cameras.\n";
export const legacyTitle = "A historical calibration study";

export async function certificate(directory) {
  const key = path.join(directory, "key.pem");
  const ca = path.join(directory, "cert.pem");
  await exec(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=LitScout rehearsal",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      ca,
    ],
    { timeout: 15_000 },
  );
  return {
    key: await readFile(key, "utf8"),
    cert: await readFile(ca, "utf8"),
    ca,
  };
}

export async function createToken(db) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const token =
    "lsk_" + [...randomBytes(52)].map((byte) => alphabet[byte & 31]).join("");
  await db
    .prepare("INSERT INTO api_tokens(id,name,hash,scopes) VALUES (?,?,?,?)")
    .bind(
      "tok_rehearsal",
      "scheduler",
      createHash("sha256").update(token).digest("hex"),
      JSON.stringify(["read", "ingest", "write", "vault"]),
    )
    .run();
  return token;
}

export async function setupCli(directory, worker, sources, ca, token) {
  const home = path.join(directory, "home");
  const state = path.join(home, ".config", "litscout");
  const bin = path.join(directory, "bin");
  const vault = path.join(directory, "vault");
  const config = path.join(directory, "litscout.config.ts");
  const tmp = path.join(directory, "tmp");
  for (const dir of [state, bin, vault, tmp])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(vault, "Idea.md"), ideaText);
  await writeFile(
    path.join(directory, "venues.json"),
    JSON.stringify({
      venues: [{ name: "Fixture Journal", kind: "journal", jmlr: true }],
    }),
  );
  const clients = { client: "codex", fallback: ["claude"], timeout: 61 };
  await writeFile(
    config,
    "export default " +
      JSON.stringify({
        instance: {
          publicUrl: worker,
          publicFeed: true,
          timezone: "Asia/Shanghai",
        },
        sources: {
          arxiv: { categories: ["cs.CV"] },
          huggingface: { dailyPapers: true, upvotesDays: 2 },
          venues: { watchlist: "./venues.json" },
        },
        topics: [{ name: "Vision", keywords: ["stereo", "depth"] }],
        vault: { root: vault, write: false },
        agent: { mode: "client", summaries: clients, digest: clients },
      }),
  );
  await writeFile(
    path.join(state, "credentials.json"),
    JSON.stringify({
      tokens: [{ token, url: worker }],
    }),
    { mode: 0o600 },
  );
  const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  for (const client of ["codex", "claude"]) {
    await writeFile(
      path.join(bin, client),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(agent)} ${client} "$@"\n`,
      { mode: 0o700 },
    );
  }
  return {
    config,
    home,
    vault,
    state,
    env: {
      PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
      HOME: home,
      TMPDIR: tmp,
      TZ: "UTC",
      GIT_CONFIG_NOSYSTEM: "1",
      NODE_ENV: "test",
      NODE_EXTRA_CA_CERTS: ca,
      NODE_OPTIONS: "--import=" + preload.href,
      LITSCOUT_REHEARSAL_WORKER: worker,
      LITSCOUT_REHEARSAL_SOURCES: sources,
    },
  };
}

export async function legacyRepository(directory, env) {
  const repo = path.join(directory, "legacy");
  await mkdir(path.join(repo, "data"), { recursive: true });
  await writeFile(
    path.join(repo, "data", legacyDay + ".jsonl"),
    JSON.stringify({
      id: "2511.00104",
      title: legacyTitle,
      summary: "A supplied abstract from the fixture archive.",
      authors: ["Fixture Author"],
    }) + "\n",
  );
  const git = (...args) =>
    exec("git", args, {
      cwd: repo,
      env: { PATH: env.PATH, HOME: env.HOME, GIT_CONFIG_NOSYSTEM: "1" },
      timeout: 10_000,
    });
  await git("init", "--initial-branch=data", "--template=");
  await git("add", "data");
  await git(
    "-c",
    "user.name=Rehearsal",
    "-c",
    `user.email=${["fixture", "example.invalid"].join("@")}`,
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test: create legacy fixture",
  );
  return { repo, git };
}
