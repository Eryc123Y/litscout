import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@litscout/core/agent-config";
import type {
  WriterOptions,
  PreflightResult,
} from "@litscout/pipeline/agent-chain";
export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut?: boolean;
};
export type CheckProcess = (
  argv: string[],
  timeout: number,
  input: string,
) => Promise<ProcessResult>;
export function agentEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SHELL",
      "USER",
      "LOGNAME",
    ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]!]])),
  );
}
export function agentProcess(
  argv: string[],
  timeout: number,
  input: string,
  cwd?: string,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached,
      env: agentEnvironment(),
    });
    let timedOut = false;
    let spawnError: string | undefined;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          // Fall back to terminating the direct child if the group is unavailable.
          child.kill("SIGKILL");
        }
      }
    };
    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout)
        : undefined;
    const maxBuffer = 1_000_000;
    const collect = (stream: typeof child.stdout) => {
      const output: Buffer[] = [];
      let length = 0;
      const append = (chunk: Buffer) => {
        output.push(chunk.subarray(0, maxBuffer - length));
        length += chunk.length;
        if (length > maxBuffer) {
          spawnError ??= "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          kill();
        }
      };
      stream.on("data", (chunk: Buffer) => {
        if (length <= maxBuffer) append(chunk);
      });
      return () => {
        stream.pause();
        // read() emits data for any buffered chunk before the pipe is destroyed.
        stream.read();
        stream.destroy();
        return Buffer.concat(output).toString("utf8");
      };
    };
    // Diagnostics: only the end matters, and a client may echo its whole
    // prompt here (Codex does), so size never stops the client.
    const tailBytes = 64_000;
    const collectTail = (stream: typeof child.stderr) => {
      let tail = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > tailBytes) tail = tail.subarray(-tailBytes);
      });
      return () => {
        stream.pause();
        stream.read();
        stream.destroy();
        return tail.toString("utf8");
      };
    };
    const stdout = collect(child.stdout),
      stderr = collectTail(child.stderr);
    const finish = (code: number) => {
      clearTimeout(timer);
      if (detached && !timedOut) kill();
      child.stdin.destroy();
      const out = stdout(),
        err = stderr();
      resolve({
        code: spawnError || timedOut ? 1 : code,
        stdout: out,
        stderr: spawnError === "ENOENT" ? "Cannot start client" : err,
        spawnError,
        timedOut,
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error.code;
      finish(1);
    });
    child.once("exit", (code) => finish(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
export async function checkClient(
  client: Client,
  run: CheckProcess = agentProcess,
): Promise<PreflightResult> {
  const argv =
    client === "claude"
      ? ["claude", "auth", "status"]
      : client === "codex"
        ? ["codex", "login", "status"]
        : client === "antigravity"
          ? ["agy", "models"]
          : null;
  if (!argv)
    return {
      client,
      usable: true,
      reason: "no auth check for configured client",
    };
  try {
    const result = await run(argv, 20000, "");
    if (result.spawnError === "ENOENT")
      return { client, usable: false, reason: "not found" };
    if (client === "claude") return claudeStatus(result);
    if (result.code !== 0)
      return {
        client,
        usable: false,
        reason: "cannot start or not authenticated",
      };
    return { client, usable: true, reason: "ready" };
  } catch {
    return { client, usable: false, reason: "check failed or timed out" };
  }
}
function claudeStatus(result: ProcessResult): PreflightResult {
  const diagnostic = result.stderr + "\n" + result.stdout;
  const status = (reason: string, usable = false): PreflightResult => ({
    client: "claude",
    usable,
    reason,
  });
  let loggedIn: unknown;
  try {
    loggedIn = JSON.parse(result.stdout)?.loggedIn;
  } catch {
    // Some client versions report auth errors as plain text.
  }
  if (loggedIn === true && result.code === 0) return status("ready", true);
  if (
    /keychain.{0,80}(unavailable|denied|locked|inaccessible|not accessible)/i.test(
      diagnostic,
    ) ||
    /(?:cannot|could not|failed to|unable to) (?:access|open|unlock|read from).*keychain/i.test(
      diagnostic,
    ) ||
    /user interaction is not allowed|errSec(?:NotAvailable|InteractionNotAllowed)|-25308|-25291/i.test(
      diagnostic,
    )
  )
    return status("Keychain unavailable");
  if (
    loggedIn === false ||
    /not logged in|not authenticated|run .{0,15}login/i.test(diagnostic)
  )
    return status("not logged in");
  return status("auth status check failed");
}
export async function executeAgent(
  argv: string[],
  prompt: string,
  options: WriterOptions,
  roots: { dir: string; cwd: string },
) {
  const directory = await mkdtemp(path.join(tmpdir(), "litscout-agent-"));
  try {
    const actual = await realpath(directory);
    for (const root of [roots.dir, roots.cwd].filter(Boolean)) {
      const base = await realpath(root).catch(() => path.resolve(root));
      if (actual === base || actual.startsWith(base + path.sep))
        throw new Error(
          "Agent temporary directory must be outside private state and the repository",
        );
    }
    const file = path.join(directory, "answer.txt");
    const args = argv.map((v) =>
      v.replaceAll("{chunkPrompt}", prompt).replaceAll("{answerFile}", file),
    );
    const stream = streamJson(argv);
    const result = await agentProcess(
      args,
      (options.timeout ?? 900) * 1000,
      stdinPrompt(argv, prompt, options.client, stream),
      directory,
    );
    if (!result.timedOut && options.client === "claude" && claudeJson(argv)) {
      const answer = claudeAnswer(result);
      if (answer) return answer;
    }
    if (result.code !== 0)
      return {
        code: result.code,
        text: result.stdout,
        diagnostic: result.timedOut ? "Agent timed out" : result.stderr,
        ...(result.timedOut ? { timedOut: true } : {}),
      };
    if (options.client === "codex") {
      const text = await readFile(file, "utf8").catch(() => "");
      return text.trim()
        ? { code: 0, text, diagnostic: result.stderr }
        : {
            code: 1,
            text: "Codex answer file missing or empty",
            diagnostic: result.stderr,
          };
    }
    if (stream) return streamAnswer(result.stdout, result.stderr);
    return { code: 0, text: result.stdout, diagnostic: result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const claudeJson = (argv: readonly string[]) =>
  argv.some((v, i) => v === "--output-format" && argv[i + 1] === "json");
const claudeError = /^API Error\b|Prompt is too long/i;
/**
 * Claude Code's `--output-format json` envelope: the checked draft in
 * `structured_output`, else the answer in `result`. An error result, such as
 * "Prompt is too long" or "API Error: ...", is a failed answer with that text
 * as its diagnostic. Null when stdout is not an envelope.
 */
function claudeAnswer(result: ProcessResult) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object") return null;
  const fields = envelope as {
    is_error?: unknown;
    subtype?: unknown;
    result?: unknown;
    structured_output?: unknown;
  };
  const text = typeof fields.result === "string" ? fields.result : "";
  if (fields.is_error === true || result.code !== 0 || claudeError.test(text))
    return {
      code: result.code || 1,
      text: "",
      diagnostic: [text || String(fields.subtype ?? "error"), result.stderr]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000),
    };
  return {
    code: 0,
    text:
      fields.structured_output == null
        ? text
        : JSON.stringify(fields.structured_output),
    diagnostic: result.stderr,
  };
}
const streamJson = (argv: readonly string[]) =>
  argv.some((v, i) => v === "--output-format" && argv[i + 1] === "stream-json");
/**
 * What the client reads on stdin. A command with {chunkPrompt} carries the
 * prompt itself; built-in Claude Code and Codex read it as text, and
 * Antigravity as one stream-json user message.
 */
function stdinPrompt(
  argv: readonly string[],
  prompt: string,
  client: WriterOptions["client"],
  stream: boolean,
) {
  if (client === "codex") return argv.at(-1) === "-" ? prompt : "";
  if (argv.some((v) => v.includes("{chunkPrompt}"))) return "";
  if (client === "antigravity" && stream)
    return (
      JSON.stringify({ event: "user", message: { content: prompt } }) + "\n"
    );
  return client === "claude" ? prompt : "";
}
/** The answer from the final `result` event of a stream-json transcript. */
function streamAnswer(stdout: string, stderr: string) {
  let result: { status?: string; response?: string; error?: string } | null =
    null;
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { event?: string; result?: object };
      if (event.event === "result" && event.result) result = event.result;
    } catch {
      /* Not every line is JSON; the result event is. */
    }
  }
  if (result?.status === "SUCCESS" && result.response?.trim())
    return { code: 0, text: result.response, diagnostic: stderr };
  return {
    code: 1,
    text: result?.response ?? "",
    diagnostic:
      [result?.error, stderr].filter(Boolean).join("\n") ||
      "No result in the client's output",
  };
}
