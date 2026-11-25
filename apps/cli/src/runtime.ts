import { stdout } from "./output";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
export function wranglerLine(args: readonly string[]) {
  return ["wrangler", ...args]
    .map((arg) =>
      /^[\w./:-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'",
    )
    .join(" ");
}
/** Wrangler stdout is captured, never forwarded (secret upload errors may echo input). */
export function runWrangler(args: readonly string[]): Promise<string> {
  const require = createRequire(import.meta.url);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(
          path.dirname(require.resolve("wrangler/package.json")),
          "bin",
          "wrangler.js",
        ),
        ...args,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.resume();
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        Object.assign(new Error("Unable to start Wrangler"), {
          code: error.code,
        }),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            Object.assign(
              new Error(
                `Wrangler ${args[0]} failed; check your local authentication and configuration.`,
              ),
              { code },
            ),
          ),
    );
  });
}
export async function prompt(
  label: string,
  secret = false,
  writeOutput: (text: string) => void = stdout,
): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error("An interactive terminal is required for private prompts.");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) writeOutput(String(chunk));
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    writeOutput(`${label}: `);
    muted = secret;
    const answer = await rl.question("");
    muted = false;
    if (secret) writeOutput("\n");
    return answer;
  } finally {
    rl.close();
    output.destroy();
  }
}
