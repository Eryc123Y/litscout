#!/usr/bin/env node
import { fetchVenueTables } from "./fetch-venues";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./setup-commands";
import { stdout, stderr, print, streamExitCode } from "./output";
import { prompt, runWrangler } from "./runtime";
import { runWatch } from "@litscout/sources/watch/run";
import { runAbstracts } from "./abstracts/run";
import { InputError, MAX_BYTES } from "./abstracts/input";

/** All of stdin as UTF-8; stops reading (and fails) past `limit` bytes. */
async function readStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > limit)
      throw new InputError(`input is larger than ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

let wrote = false;
const streamOutput = (text: string) => {
  wrote ||= text.length > 0;
  stdout(text);
};
const json = process.argv.includes("--json");
const streamError = (text: string) =>
  stderr(json ? JSON.stringify({ error: text.trim() }) + "\n" : text);
const argv = process.argv
  .slice(2)
  .filter(
    (arg) =>
      arg !== "--json" ||
      !["watch", "abstracts"].includes(process.argv[2] ?? ""),
  );
if (argv[0] === "abstracts") {
  // Same rules as watch: stdout carries only result lines, and no process.exit.
  const code = await runAbstracts(argv.slice(1), {
    fetch,
    env: process.env,
    readStdin: () => readStdin(MAX_BYTES),
    stdout: streamOutput,
    stderr: streamError,
  });
  process.exitCode = streamExitCode(
    code,
    wrote,
    argv.includes("--help") || argv.includes("-h"),
  );
} else if (argv[0] === "watch") {
  // stdout carries only feed lines; every message goes to stderr. Never call process.exit here:
  // that could cut off buffered stdout when it is a pipe.
  const code = await runWatch(argv.slice(1), {
    fetch,
    env: process.env,
    readFile: (file) => readFile(file, "utf8"),
    // State (the JMLR ledger) is replaced atomically, so a concurrent run never reads half a file.
    writeFile: async (file, text) => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    stdout: streamOutput,
    stderr: streamError,
  });
  process.exitCode = streamExitCode(
    code,
    wrote,
    argv.includes("--help") || argv.includes("-h"),
  );
} else {
  process.exitCode = await runCommand(argv, {
    cwd: process.cwd(),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY),
    templateDir: fileURLToPath(new URL("./templates", import.meta.url)),
    fetchVenues: fetchVenueTables,
    dir: path.join(homedir(), ".config", "litscout"),
    cacheDir: path.join(homedir(), ".cache", "litscout"),
    bundlePath: fileURLToPath(new URL("./worker.js", import.meta.url)),
    run: runWrangler,
    prompt: (label, secret) => prompt(label, secret, stderr),
    fetch,
    print,
  });
}
